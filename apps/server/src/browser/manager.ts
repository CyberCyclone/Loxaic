/**
 * One Chromium session per conversation (#281).
 *
 * Keyed by **conversation id**, which is the only handle this module accepts:
 * there is no API that takes a container id, a CDP url, or a session token, so
 * there is nothing for a caller — or a model — to point at another chat's
 * browser. Combined with the per-session internal network, the tmpfs profile and
 * the destroy-only lifecycle, the isolation rule from the issue becomes a
 * property of the infrastructure rather than a check to remember:
 *
 * - nothing is ever resumed (a fresh container starts with a fresh profile), so a
 *   session cannot survive its own conversation, let alone cross users;
 * - nothing is ever mounted or written to disk, so there is no cache, history or
 *   download to leak into the next session;
 * - a session's network has no route to another session's network.
 *
 * **No database rows.** Deliberate, and unlike conversation sandboxes: a sandbox
 * can be paused and resumed days later, which is what a row is *for*. A browser
 * cannot be resumed at all, so a row would record state nothing can act on, and
 * its only effect would be to make a crash leave a row that lies. Discovery
 * after a restart is the engine's, by label (`sweepOrphanBrowsers`).
 *
 * The session outlives a run, as a sandbox does: "log in, then click the thing"
 * is two turns, and tearing down at the end of each would break it.
 */
import type Docker from "dockerode";
import { connectBrowser, type BrowserConnection, type PageDriver } from "./driver.ts";
import { loadWorkspace } from "../agent/workspace.ts";
import { getBrowserSettings } from "../settings.ts";
import {
  connectToNetwork,
  containerIpOn,
  createBrowserContainer,
  destroyBrowserContainer,
  ensureBrowserImage,
  isNotFound,
  launchChromium,
  listBrowserContainersOn,
  resetBrowserImageTag,
  type BrowserContainer,
} from "./container.ts";
import { chromiumArgs, chromiumEnv } from "./launch.ts";
import {
  browserNetworkName,
  createBrowserNetwork,
  destroyBrowserNetwork,
  listBrowserNetworksOn,
  type BrowserNetwork,
} from "./network.ts";
import { BrowserProxy, type ProxyHandle } from "./proxy.ts";

/** Which surface asked, which decides one thing: whether the conversation's own
 * workspace sandbox gets joined to the session's network. Never a request
 * field — it comes from the run's own surface. */
export type BrowserSurface = "chat" | "agent" | "routine";

export interface BrowserSession {
  conversationId: string;
  /** The page the tool actions run against: one per session, reused across
   * calls so navigation state survives between turns. */
  page: PageDriver;
  /** Called when the call using the session finishes, so the idle timer counts
   * from the end of use rather than its start. The manager owns teardown; a
   * caller never closes anything. */
  release(): void;
}

export interface BrowserLog {
  (message: string): void;
}

interface Entry {
  conversationId: string;
  ownerId: string;
  network: BrowserNetwork;
  container: BrowserContainer;
  proxy: ProxyHandle;
  connection: BrowserConnection;
  lastUsedAt: number;
  /** The surface that asked, kept so a later attach cannot widen a chat's
   * session: only an agent session may have a workspace sandbox joined. */
  surface: BrowserSurface;
  /** The workspace sandbox joined to this session's network, agent surface only. */
  sandboxContainerId: string | null;
}

/** One proxy for the whole server; sessions are told apart the way `proxy.ts`
 * describes (bound address, or source address in the fallback mode). */
let proxy = new BrowserProxy();
const active = new Map<string, Entry>();
/** Creation is single-flight per conversation, so two tool calls in one turn do
 * not build two browsers. */
const pending = new Map<string, Promise<Entry>>();
/** Reserved session slots per user, held across the await inside creation. */
const inFlight = new Map<string, number>();

export function resetBrowserRuntimeForTest(): void {
  proxy.detachAll();
  proxy = new BrowserProxy();
  active.clear();
  pending.clear();
  inFlight.clear();
  resetBrowserImageTag();
}

export class BrowserUnavailableError extends Error {}

/** Whether browsing can run here at all: an engine that answers and, once asked
 * properly, an image that exists. Surfaced on `/v1/config` and the admin view so
 * the answer is visible before a tool call fails. */
export async function browserAvailability(): Promise<{ available: boolean; reason?: string }> {
  const settings = getBrowserSettings();
  if (!settings.enabled) return { available: false, reason: "Browsing is switched off in the server's settings." };
  const docker = await engine();
  if (!docker) return { available: false, reason: "No container engine is reachable, so there is nowhere to run a browser." };
  return { available: true };
}

/** The engine, or null when this deployment has none. `Docker` is imported as a
 * type only: this module never constructs one, and the discovery/caching lives
 * with the sandbox layer so there is exactly one engine cache per process. */
async function engine(): Promise<Docker | null> {
  // Imported lazily: `container-provider` reaches the settings and the engine
  // cache, and a top-level import would pull it into every module that imports
  // this one (including the availability check on /v1/config).
  const { getEngine } = await import("../sandbox/container-provider.ts");
  return await getEngine();
}

/**
 * The session for a conversation, creating it on first use.
 *
 * The *owner* of everything created is the conversation's owner, from
 * `loadWorkspace` — the same rule `createConfigFor` follows for sandboxes, and
 * for the same reason: an editor's tool call must not create resources under the
 * editor's identity on a conversation they do not own. The sender is therefore
 * not a parameter: nothing about a browser session should depend on who happened
 * to trigger the call, and taking the id made it look like something did.
 *
 * A caller that has just used the sandbox hands its container id to
 * `attachSandboxToBrowser` after this returns, so the agent's loopback route is
 * set without a second workspace lookup.
 */
export async function getBrowserSession(conversationId: string, surface: BrowserSurface): Promise<BrowserSession> {
  const settings = getBrowserSettings();
  if (!settings.enabled) throw new BrowserUnavailableError("Browsing is switched off on this server.");

  const existing = active.get(conversationId);
  if (existing) {
    // A live entry whose browser died (container OOM-killed, crashed, or was
    // stopped outside this process) is not a session: drop it and start over.
    if (await isLive(existing)) return sessionOf(existing);
    await tearDown(existing).catch(() => undefined);
    active.delete(conversationId);
  }

  const creating = pending.get(conversationId);
  if (creating) return sessionOf(await creating);

  const promise = createEntry(conversationId, surface);
  pending.set(conversationId, promise);
  try {
    return sessionOf(await promise);
  } finally {
    // Compared against the stored promise on purpose: a different creation that
    // started while this one ran must not be cleared by this one finishing.
    if (pending.get(conversationId) === promise) pending.delete(conversationId);
  }
}

async function createEntry(conversationId: string, surface: BrowserSurface): Promise<Entry> {
  const settings = getBrowserSettings();
  const workspace = await loadWorkspace(conversationId);
  if (!workspace) throw new BrowserUnavailableError("This conversation no longer exists.");
  const ownerId = workspace.ownerId;

  // Check and reserve with no await between them, so two concurrent calls for
  // one user cannot both pass the cap while the first is still building. The
  // reservation is released once the entry exists (or fails), in the `finally`.
  assertUnderUserLimit(ownerId, settings.maxSessionsPerUser);
  reserveUserSlot(ownerId);
  try {
    return await buildEntry(ownerId, conversationId, surface, settings);
  } finally {
    releaseUserSlot(ownerId);
  }
}

async function buildEntry(
  ownerId: string,
  conversationId: string,
  surface: BrowserSurface,
  settings: ReturnType<typeof getBrowserSettings>,
): Promise<Entry> {
  const docker = await engine();
  if (!docker) throw new BrowserUnavailableError("No container engine is reachable, so there is nowhere to run a browser.");

  await ensureBrowserImage(docker);
  const network = await createBrowserNetwork(docker, conversationId);
  const proxyHandle = await proxy.attach(network.gateway, network.subnet, {});

  let container: BrowserContainer | null = null;
  try {
    container = await createBrowserContainer(docker, { userId: ownerId, conversationId, network: network.name });
    await launchChromium(
      docker,
      container.id,
      chromiumArgs({ proxyUrl: proxyHandle.proxyUrl }),
      chromiumEnv(),
    );
    // CDP over the host's loopback: the published port is the one path that
    // reaches a container on every engine, including Docker Desktop where the
    // engine is in a VM and container addresses are not reachable from here.
    const connection = await connectBrowser(
      `http://127.0.0.1:${String(container.hostCdpPort)}`,
      // A browser that is not answering is a failed session, not a hang: the
      // alternative is a tool call that sits there until the run is stopped.
      settings.launchTimeoutMs,
      settings.actionTimeoutMs,
    );

    const entry: Entry = {
      conversationId,
      ownerId,
      network,
      container,
      proxy: proxyHandle,
      connection,
      lastUsedAt: Date.now(),
      surface,
      sandboxContainerId: null,
    };
    active.set(conversationId, entry);
    return entry;
  } catch (err) {
    // Half-built: the proxy listener, the container and the network all exist
    // and nothing would reclaim them, because nothing else knows their ids and
    // only the boot sweep looks for browser containers by label.
    proxy.detach(network.gateway);
    if (container) await destroyBrowserContainer(docker, container.id).catch(() => undefined);
    await destroyBrowserNetwork(docker, network.name).catch(() => undefined);
    throw err;
  }
}

/**
 * Joins the conversation's own workspace sandbox to its browser session's
 * network, so an agent can drive that browser from inside its sandbox (issue AC:
 * end-to-end testing) and so `page.goto("http://localhost:3000")` reaches the
 * dev server running in the sandbox rather than the browser's own loopback.
 *
 * Called by the tool loop with the sandbox handle it already has — the id comes
 * from the engine, never from the model or a client — and it refuses on three
 * counts: a chat or routine session (never widened after creation), a session
 * with no live entry, and a `ref` that is not a container id (a host-mode or
 * laptop-executor workspace has no container to join, and its "ref" is a
 * directory or an executor id that must never end up in an engine call).
 */
export async function attachSandboxToBrowser(conversationId: string, sandboxRef: string): Promise<void> {
  const entry = active.get(conversationId);
  if (!entry || entry.surface !== "agent") return;
  // A container id is hex, 12..64 chars (the same shape executor/container.ts
  // accepts). Anything else is not something to hand to the engine.
  if (!/^[0-9a-f]{12,64}$/.test(sandboxRef)) return;
  const docker = await engine();
  if (!docker) return;
  const sandboxContainerId = sandboxRef;
  if (entry.sandboxContainerId !== sandboxContainerId) {
    await connectToNetwork(docker, sandboxContainerId, entry.network.name).catch(() => undefined);
    entry.sandboxContainerId = sandboxContainerId;
  }
  const ip = await containerIpOn(docker, sandboxContainerId, entry.network.name);
  if (ip) proxy.setPolicy(entry.network.gateway, { loopbackTarget: ip });
}

/** The CDP url a session's own workspace sandbox should use. On the agent
 * surface the sandbox is on the session network, so it reaches Chromium
 * directly — a URL through the host's loopback would be the sandbox's own
 * loopback instead. */
export function sandboxCdpUrlFor(conversationId: string): string | null {
  const entry = active.get(conversationId);
  if (!entry?.sandboxContainerId) return null;
  return `http://${entry.container.ip}:9222`;
}

async function isLive(entry: Entry): Promise<boolean> {
  if (entry.connection.isConnected()) return true;
  const docker = await engine();
  if (!docker) return false;
  try {
    await docker.getContainer(entry.container.id).inspect();
    return true;
  } catch (err) {
    return !isNotFound(err);
  }
}

function sessionOf(entry: Entry): BrowserSession {
  entry.lastUsedAt = Date.now();
  return {
    conversationId: entry.conversationId,
    page: entry.connection.page,
    release: () => {
      entry.lastUsedAt = Date.now();
    },
  };
}

/**
 * Destroys a session: browser, container, network, listener — in that order,
 * because the network refuses removal while an endpoint is joined.
 *
 * There is no `stop`: a browser has nothing to resume, and a stopped-but-kept
 * container would be exactly the "paused session another chat could resume" the
 * issue rules out.
 */
async function tearDown(entry: Entry): Promise<void> {
  await entry.connection.close().catch(() => undefined);
  const docker = await engine();
  if (docker) {
    // The sandbox leaves the network before it goes: on the agent surface it is
    // an endpoint of a network the conversation still needs for nothing else,
    // and a stale join would follow the sandbox's address around on its next
    // start.
    if (entry.sandboxContainerId) {
      await docker.getNetwork(entry.network.name).disconnect({ Container: entry.sandboxContainerId, Force: true }).catch(() => undefined);
    }
    await destroyBrowserContainer(docker, entry.container.id);
    await destroyBrowserNetwork(docker, entry.network.name);
  }
  proxy.detach(entry.network.gateway);
}

/**
 * The per-user cap, with the LRU eviction the issue's isolation rules allow:
 * only ever the *same* user's own idle session, and never one that is in use.
 *
 * Keyed on the conversation's **owner**, because that is who the browser and its
 * logins belong to — an editor triggering a session on an owner's conversation
 * consumes the owner's slot, which is the honest accounting of whose cookies are
 * being stored. `userId` is not used to pick a victim and never will be: whose
 * session is destroyed must depend on ownership, not on who happened to send the
 * message.
 */
async function assertUnderUserLimit(ownerId: string, max: number): Promise<void> {
  const held = activeForOwner(ownerId);
  if (held.length + (inFlight.get(ownerId) ?? 0) < max) return;
  const evictable = held.filter((entry) => !pending.has(entry.conversationId)).sort((a, b) => a.lastUsedAt - b.lastUsedAt);
  const victim = evictable[0];
  if (!victim) {
    throw new BrowserUnavailableError(
      max === 1
        ? "You already have a browser session open in another conversation. Close it, or ask an admin to allow more."
        : `You already have ${String(max)} browser sessions open. Close one and try again.`,
    );
  }
  active.delete(victim.conversationId);
  await tearDown(victim).catch(() => undefined);
}

function reserveUserSlot(ownerId: string): void {
  inFlight.set(ownerId, (inFlight.get(ownerId) ?? 0) + 1);
}

function releaseUserSlot(ownerId: string): void {
  const now = (inFlight.get(ownerId) ?? 0) - 1;
  if (now <= 0) inFlight.delete(ownerId);
  else inFlight.set(ownerId, now);
}

function activeForOwner(ownerId: string): Entry[] {
  return [...active.values()].filter((entry) => entry.ownerId === ownerId);
}

/** Destroys a session held for a conversation. Called when it is deleted. */
export async function destroyConversationBrowser(conversationId: string): Promise<boolean> {
  // Await the creation first: an in-flight one would otherwise finish *after*
  // this returns and leave a container, a network and a listener belonging to a
  // conversation that no longer exists — with no row and no map entry, so only
  // the boot sweep could ever find them.
  const creating = pending.get(conversationId);
  if (creating) await creating.catch(() => undefined);
  const entry = active.get(conversationId);
  if (!entry) return false;
  active.delete(conversationId);
  await tearDown(entry);
  return true;
}

/** Pauses nothing; destroys the idle ones. The name says which, because for a
 * browser the difference is the whole point. */
export async function stopIdleBrowserSessions(now: number = Date.now()): Promise<number> {
  const { idleMs } = getBrowserSettings();
  let destroyed = 0;
  for (const [conversationId, entry] of [...active.entries()]) {
    if (pending.has(conversationId)) continue;
    if (now - entry.lastUsedAt < idleMs) continue;
    active.delete(conversationId);
    await tearDown(entry).catch(() => undefined);
    destroyed++;
  }
  return destroyed;
}

/**
 * Destroys every browser container and network the engine reports.
 *
 * At boot nothing can legitimately be claimed: the map is empty by definition,
 * so anything on the engine is a leftover from a crash or a restart — a session
 * whose cookies belong to a process that can no longer hand them to anyone.
 * Destroying them is both the reclaim and the isolation guarantee.
 */
export async function sweepOrphanBrowsers(scope: { ownerId?: string } = {}): Promise<number> {
  const docker = await engine();
  if (!docker) return 0;
  // Everything the boot sweep sees is older than this process; the engine's own
  // creation timestamps are the clock.
  const containers = await listBrowserContainersOn(docker, { userId: scope.ownerId });
  let destroyed = 0;
  for (const listed of containers) {
    await destroyBrowserContainer(docker, listed.id).catch(() => undefined);
    destroyed++;
  }
  // Networks with nothing in them: created, then abandoned by a crash before the
  // container existed, or left by a destroy that failed partway.
  for (const network of await listBrowserNetworksOn(docker)) {
    const endpoints = await docker.getNetwork(network.name).inspect().then((info) => Object.keys(info.Containers ?? {})).catch(() => ["unknown"]);
    if (endpoints.length > 0) continue;
    await destroyBrowserNetwork(docker, network.name).catch(() => undefined);
  }
  return destroyed;
}

export function startBrowserReaper(onReap?: (count: number) => void): NodeJS.Timeout {
  const timer = setInterval(() => {
    void stopIdleBrowserSessions()
      .then((count) => {
        if (count > 0) onReap?.(count);
      })
      .catch(() => undefined);
  }, 60_000);
  // A browser idle timer must not be the reason a process cannot exit.
  timer.unref();
  return timer;
}

/** Destroys every session this process holds — on shutdown, and when an admin
 * switches browsing off. */
export async function stopAllBrowserSessions(): Promise<number> {
  const entries = [...active.values()];
  active.clear();
  let destroyed = 0;
  for (const entry of entries) {
    await tearDown(entry).catch(() => undefined);
    destroyed++;
  }
  proxy.detachAll();
  return destroyed;
}

/** Live sessions, for the admin view: whose, which conversation, how recently
 * used. Never the CDP url — it is a control endpoint and has no reason to be
 * echoed into an admin payload. */
export function browserSessionStatus(): {
  conversationId: string;
  ownerId: string;
  lastUsedAt: number;
  sandboxAttached: boolean;
}[] {
  return [...active.values()].map((entry) => ({
    conversationId: entry.conversationId,
    ownerId: entry.ownerId,
    lastUsedAt: entry.lastUsedAt,
    sandboxAttached: entry.sandboxContainerId !== null,
  }));
}

/** Which proxy mode this deployment got, which changes what the isolation
 * guarantee rests on. Shown to an admin, because it is worth knowing. */
export function browserProxyMode(): "per-session" | "shared" | "none" {
  const [first] = proxy.live();
  return first?.mode ?? "none";
}

/** The name a session's network would have — exported so a test can assert the
 * network a session created is the one for *its* conversation and not another. */
export const networkNameFor = browserNetworkName;
