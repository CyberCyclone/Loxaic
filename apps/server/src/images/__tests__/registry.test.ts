import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { randomUUID } from "node:crypto";
import { createServer } from "node:net";
import Docker from "dockerode";
import { pack } from "tar-stream";
import { and, db, eq, inArray } from "@loxaic/db";
import { conversations, registryLogins, sandboxes, sandboxImages, user } from "@loxaic/db/schema";
import type { WorkspaceImage } from "@loxaic/types";
import { destroyConversationSandboxes, getConversationSandbox, replaceConversationSandbox } from "../../agent/sandbox-manager.ts";
import { sandboxImageReady } from "../../sandbox/__tests__/docker-available.ts";
import { engineKind } from "../../sandbox/container-engine.ts";
import { getSandboxProvider } from "../../sandbox/provider.ts";
import { saveLogin } from "../logins.ts";
import { __waitForPull, addImage, findImage, type ImageView } from "../store.ts";
import { useRefusal } from "../access.ts";

/**
 * Custom images against a real registry (#253): the one place the guarantee
 * that makes the feature safe on a shared engine can be checked — that a
 * private image someone else pulled, sitting right there on disk, is still
 * out of reach of anyone without their own login for it.
 *
 * A `registry:2` with htpasswd auth on a loopback port, and one image built
 * `FROM debian:bookworm-slim` (bash, util-linux and coreutils, no git) with a
 * marker file, a non-root user and an ENTRYPOINT of its own — the three ways
 * a stranger's image differs from Loxaic's. Docker only: custom images refuse
 * Podman (images/store.ts), and this asks the engine before running.
 */
process.env.MCP_ENCRYPTION_KEY ??= "images-test-key";

const USERNAME = "loxaic-test";
const PASSWORD = "registry-test-password";
/** `htpasswd -nbB loxaic-test registry-test-password`, made once: registry:2
 * accepts only bcrypt, and nothing in the tree computes it. */
const HTPASSWD = "loxaic-test:$2y$05$FaCxj4KGORKK7F7c5vl34uY6pFKHz5QlGmjMx38sK22AV4Nm7JT8i\n";

const docker = new Docker();
const dockerReady = await (async () => {
  try {
    const provider = await getSandboxProvider();
    if (provider?.kind !== "container" || !(await provider.available()).ok) return false;
    return (await engineKind(docker)) === "docker";
  } catch {
    return false;
  }
})();

const alice = `test-images-alice-${randomUUID()}`;
const bob = `test-images-bob-${randomUUID()}`;
const conversationIds: string[] = [];
const savedEnv = process.env.SANDBOX_CUSTOM_IMAGES;
let registry: Docker.Container | null = null;
let reference = "";
let rootReference = "";
let noTailReference = "";
let host = "";

async function follow(stream: NodeJS.ReadableStream): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    docker.modem.followProgress(stream, (err: Error | null, out: { error?: string }[]) => {
      const failure = out.find((e) => e.error);
      if (err) reject(err);
      else if (failure) reject(new Error(failure.error));
      else resolve();
    });
  });
}

async function ensureLocal(image: string): Promise<void> {
  try {
    await docker.getImage(image).inspect();
  } catch {
    await follow(await docker.pull(image));
  }
}

function tarOf(files: Record<string, string>): NodeJS.ReadableStream {
  const archive = pack();
  for (const [name, content] of Object.entries(files)) archive.entry({ name, mode: 0o644 }, content);
  archive.finalize();
  return archive as unknown as NodeJS.ReadableStream;
}

/** A port nothing on this machine is listening on. The registry is published
 * on a fixed one: Docker Desktop's engine reaches an ephemeral published port
 * from the host's side only, so it could never push to or pull from it. */
async function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const server = createServer();
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      server.close(() => { resolve(typeof address === "object" && address ? address.port : 0); });
    });
  });
}

async function startRegistry(): Promise<void> {
  await ensureLocal("registry:2");
  const hostPort = String(await freePort());
  registry = await docker.createContainer({
    Image: "registry:2",
    Env: [
      "REGISTRY_AUTH=htpasswd",
      "REGISTRY_AUTH_HTPASSWD_REALM=loxaic-test",
      "REGISTRY_AUTH_HTPASSWD_PATH=/auth/htpasswd",
    ],
    Labels: { "loxaic.test": "images-registry" },
    HostConfig: { PortBindings: { "5000/tcp": [{ HostIp: "127.0.0.1", HostPort: hostPort }] }, AutoRemove: false },
  });
  await registry.putArchive(tarOf({ "auth/htpasswd": HTPASSWD }), { path: "/" });
  await registry.start();
  const port = hostPort;
  host = `localhost:${port}`;
  // Ready once /v2/ answers at all (401 without credentials).
  for (let i = 0; i < 50; i++) {
    const res = await fetch(`http://127.0.0.1:${port}/v2/`).catch(() => null);
    if (res) return;
    await new Promise((r) => setTimeout(r, 200));
  }
  throw new Error("registry did not answer");
}

async function buildAndPush(): Promise<void> {
  await ensureLocal("debian:bookworm-slim");
  reference = `${host}/loxaic-test/marker:${randomUUID().slice(0, 8)}`;
  const dockerfile = [
    "FROM debian:bookworm-slim",
    "RUN useradd -m -u 1234 builder && echo marker-253 > /opt/marker",
    "USER builder",
    'ENTRYPOINT ["sh", "-c", "echo ran > /tmp/entrypoint-ran; exec sleep infinity"]',
  ].join("\n");
  await follow(await docker.buildImage(tarOf({ Dockerfile: dockerfile }), { t: reference }));
  const pushed = await docker.getImage(reference).push({
    authconfig: { username: USERNAME, password: PASSWORD, serveraddress: host },
  });
  await follow(pushed);
  // A second image whose user is root, so a move between the two has to
  // re-own every file it carries.
  rootReference = `${host}/loxaic-test/root:${randomUUID().slice(0, 8)}`;
  await follow(await docker.buildImage(tarOf({ Dockerfile: "FROM debian:bookworm-slim\nRUN echo root-image > /opt/marker\n" }), { t: rootReference }));
  await follow(await docker.getImage(rootReference).push({
    authconfig: { username: USERNAME, password: PASSWORD, serveraddress: host },
  }));
  // One whose container cannot even start: the sandbox runs `tail`.
  noTailReference = `${host}/loxaic-test/notail:${randomUUID().slice(0, 8)}`;
  await follow(await docker.buildImage(tarOf({ Dockerfile: "FROM debian:bookworm-slim\nRUN rm -f /usr/bin/tail\n" }), { t: noTailReference }));
  await follow(await docker.getImage(noTailReference).push({
    authconfig: { username: USERNAME, password: PASSWORD, serveraddress: host },
  }));
}

async function makeUser(id: string, role: string | null = null): Promise<void> {
  await db.insert(user).values({
    id,
    name: id,
    email: `${id}@example.test`,
    emailVerified: true,
    role,
    createdAt: new Date(),
    updatedAt: new Date(),
  });
}

async function conversationIn(ownerId: string, image: ImageView): Promise<string> {
  const id = randomUUID();
  conversationIds.push(id);
  const chosen: WorkspaceImage = { id: image.id, scope: image.scope, reference: image.reference, label: image.label };
  await db.insert(conversations).values({ id, ownerId, title: "images", kind: "agent", workspace: { kind: "scratch", image: chosen } });
  return id;
}

async function pulled(view: ImageView) {
  await __waitForPull(view.id);
  const row = await findImage(view.id);
  if (!row) throw new Error("row vanished");
  return row;
}

beforeAll(async () => {
  if (!dockerReady) return;
  process.env.SANDBOX_CUSTOM_IMAGES = "everyone";
  await makeUser(alice, "admin");
  await makeUser(bob);
  await startRegistry();
  await buildAndPush();
}, 600_000);

afterAll(async () => {
  if (!dockerReady) return;
  if (savedEnv === undefined) Reflect.deleteProperty(process.env, "SANDBOX_CUSTOM_IMAGES");
  else process.env.SANDBOX_CUSTOM_IMAGES = savedEnv;
  // The engine first: a database failure below must not leave a registry
  // container and pushed images behind on a shared engine.
  await registry?.remove({ force: true, v: true }).catch(() => undefined);
  for (const id of conversationIds) await destroyConversationSandboxes(id).catch(() => undefined);
  if (host) {
    const leftovers = [
      ...(await docker.listImages({ filters: { reference: [`${host}/loxaic-test/marker`] } }).catch(() => [])),
      ...(await docker.listImages({ filters: { reference: [`${host}/loxaic-test/root`] } }).catch(() => [])),
      ...(await docker.listImages({ filters: { reference: [`${host}/loxaic-test/notail`] } }).catch(() => [])),
    ];
    for (const image of leftovers) await docker.getImage(image.Id).remove({ force: true }).catch(() => undefined);
  }
  await db.delete(sandboxes).where(inArray(sandboxes.ownerId, [alice, bob]));
  if (conversationIds.length > 0) await db.delete(conversations).where(inArray(conversations.id, conversationIds));
  await db.delete(sandboxImages).where(inArray(sandboxImages.createdBy, [alice, bob]));
  await db.delete(registryLogins).where(inArray(registryLogins.createdBy, [alice, bob]));
  await db.delete(user).where(inArray(user.id, [alice, bob]));
}, 120_000);

describe.skipIf(!dockerReady)("custom images against a real registry", () => {
  let alicesImage: ImageView;

  it("pulls with the owner's own login and pins the digest it got", async () => {
    await saveLogin(alice, { registry: host, username: USERNAME, secret: PASSWORD }, alice);
    alicesImage = await addImage(alice, { reference }, alice);
    const row = await pulled(alicesImage);
    expect(row.error).toBeNull();
    expect(row.status).toBe("ready");
    expect(row.digest).toMatch(new RegExp(`^${host}/loxaic-test/marker@sha256:[a-f0-9]{64}$`));
    expect(row.uid).toBe(1234);
    // Usable, with what the image lacks said rather than refused.
    expect(useRefusal(row, "everyone", alice, { github: false })).toBeNull();
    expect(useRefusal(row, "everyone", alice, { github: true })).toMatch(/no git/);
  }, 300_000);

  it("refuses the same private image to someone with no login, though it is on this engine", async () => {
    // The image is local: Alice pulled it (and this suite built it). Bob's pull
    // still asks the registry, which refuses him, so he never gets a digest.
    await expect(docker.getImage(reference).inspect()).resolves.toBeTruthy();
    const bobs = await addImage(bob, { reference }, bob);
    const row = await pulled(bobs);
    expect(row.status).toBe("failed");
    expect(row.digest).toBeNull();
    expect(row.error).toMatch(/refused/);
    expect(row.error).not.toContain(PASSWORD);
    expect(useRefusal(row, "everyone", bob, { github: false })).toMatch(/not been pulled/);
  }, 300_000);

  it("refuses an image whose container cannot start, and leaves no container behind", async () => {
    const before = await docker.listContainers({ all: true, filters: { label: [`loxaic.user=${alice}`] } });
    const view = await addImage(alice, { reference: noTailReference }, alice);
    const row = await pulled(view);
    expect(row.status).toBe("failed");
    expect(row.error).toMatch(/tail/);
    const after = await docker.listContainers({ all: true, filters: { label: [`loxaic.user=${alice}`] } });
    expect(after.map((c) => c.Id).sort()).toEqual(before.map((c) => c.Id).sort());
  }, 300_000);

  it("never lets someone else's conversation run in a personal image", async () => {
    const conversation = await conversationIn(bob, alicesImage);
    await expect(getConversationSandbox(bob, conversation)).rejects.toThrow(/can't be used/);
  }, 120_000);

  it("runs a sandbox in the image as its own user, with a home it can write and its ENTRYPOINT skipped", async () => {
    const conversation = await conversationIn(alice, alicesImage);
    const handle = await getConversationSandbox(alice, conversation);

    const marker = await handle.exec(["cat", "/opt/marker"]);
    expect(marker.stdout.trim()).toBe("marker-253");
    expect((await handle.exec(["id", "-u"])).stdout.trim()).toBe("1234");
    await handle.writeFile(`${handle.workdir}/note.txt`, "written by the agent");
    await expect(handle.readFile(`${handle.workdir}/note.txt`)).resolves.toBe("written by the agent");
    expect((await handle.exec(["bash", "-c", "echo $HOME"])).stdout.trim()).toBe("/home/loxaic");
    expect((await handle.exec(["test", "-e", "/tmp/entrypoint-ran"])).exitCode).not.toBe(0);

    // A stop still works, through the same wrapper every exec goes through.
    const abort = new AbortController();
    setTimeout(() => { abort.abort(); }, 500);
    const started = Date.now();
    const stopped = await handle.exec(["sleep", "30"], { signal: abort.signal });
    expect(stopped.exitCode).toBe(130);
    expect(Date.now() - started).toBeLessThan(15_000);

    const row = await db.query.sandboxes.findFirst({ where: and(eq(sandboxes.conversationId, conversation), eq(sandboxes.ownerId, alice)) });
    expect(row?.image).toBe((await findImage(alicesImage.id))?.digest);
    const info = await docker.getContainer(handle.ref).inspect();
    expect(info.HostConfig.Memory).toBe(512 * 1024 * 1024);
  }, 300_000);

  it("moves a conversation to another image with its files, re-owned for the new user, and back", async () => {
    const rootImage = await addImage(alice, { reference: rootReference, label: "Root" }, alice);
    expect((await pulled(rootImage)).status).toBe("ready");
    const conversation = await conversationIn(alice, alicesImage);
    const before = await getConversationSandbox(alice, conversation);
    await before.writeFile(`${before.workdir}/work.txt`, "made in the first image");
    await before.exec(["bash", "-c", "mkdir -p /home/loxaic/.loxaic/checkpoints && echo kept > /home/loxaic/.loxaic/checkpoints/copy"]);

    const asWorkspace = (img: ImageView): WorkspaceImage => ({ id: img.id, scope: img.scope, reference: img.reference, label: img.label });
    await expect(replaceConversationSandbox(conversation, { kind: "scratch", image: asWorkspace(rootImage) })).resolves.toEqual({ moved: true });

    const after = await getConversationSandbox(alice, conversation);
    expect(after.ref).not.toBe(before.ref);
    expect((await after.exec(["cat", "/opt/marker"])).stdout.trim()).toBe("root-image");
    await expect(after.readFile(`${after.workdir}/work.txt`)).resolves.toBe("made in the first image");
    expect((await after.exec(["stat", "-c", "%u", `${after.workdir}/work.txt`])).stdout.trim()).toBe("0");
    expect((await after.exec(["cat", "/home/loxaic/.loxaic/checkpoints/copy"])).stdout.trim()).toBe("kept");
    await expect(docker.getContainer(before.ref).inspect()).rejects.toThrow();
    const rows = await db.query.sandboxes.findMany({ where: eq(sandboxes.conversationId, conversation) });
    expect(rows.map((r) => r.status).sort()).toEqual(["destroyed", "running"]);

    // And back: the file is the first image's user's again, and still writable.
    await replaceConversationSandbox(conversation, { kind: "scratch", image: asWorkspace(alicesImage) });
    const back = await getConversationSandbox(alice, conversation);
    expect((await back.exec(["stat", "-c", "%u", `${back.workdir}/work.txt`])).stdout.trim()).toBe("1234");
    await back.writeFile(`${back.workdir}/work.txt`, "edited after moving back");
    await expect(back.readFile(`${back.workdir}/work.txt`)).resolves.toBe("edited after moving back");
  }, 300_000);

  it("copies from the container the chat is using when a stale paused row sits beside it", async () => {
    const conversation = await conversationIn(alice, alicesImage);
    const before = await getConversationSandbox(alice, conversation);
    await before.writeFile(`${before.workdir}/work.txt`, "in the live container");
    // A paused row left behind, and the live row rewritten after it, so an
    // unordered read meets the stale one first.
    const [stale] = await db
      .insert(sandboxes)
      .values({ ownerId: alice, conversationId: conversation, containerId: randomUUID().replaceAll("-", ""), provider: "container", image: "stale", status: "stopped" })
      .returning();
    await db.update(sandboxes).set({ lastUsedAt: new Date() }).where(and(eq(sandboxes.conversationId, conversation), eq(sandboxes.status, "running")));

    const asWorkspace: WorkspaceImage = { id: alicesImage.id, scope: alicesImage.scope, reference: alicesImage.reference, label: alicesImage.label };
    await expect(replaceConversationSandbox(conversation, { kind: "scratch", image: asWorkspace })).resolves.toEqual({ moved: true });
    const after = await getConversationSandbox(alice, conversation);
    await expect(after.readFile(`${after.workdir}/work.txt`)).resolves.toBe("in the live container");
    await expect(docker.getContainer(before.ref).inspect()).rejects.toThrow();
    expect((await db.query.sandboxes.findFirst({ where: eq(sandboxes.id, stale.id) }))?.status).toBe("stopped");
  }, 300_000);

  it("treats a sandbox whose container is gone as nothing to move, and can move again", async () => {
    const conversation = await conversationIn(alice, alicesImage);
    const before = await getConversationSandbox(alice, conversation);
    await docker.getContainer(before.ref).remove({ force: true });

    const asWorkspace: WorkspaceImage = { id: alicesImage.id, scope: alicesImage.scope, reference: alicesImage.reference, label: `${alicesImage.label} again` };
    await expect(replaceConversationSandbox(conversation, { kind: "scratch", image: asWorkspace })).resolves.toEqual({ moved: false });
    const rows = await db.query.sandboxes.findMany({ where: eq(sandboxes.conversationId, conversation) });
    expect(rows.map((r) => r.status)).toEqual(["destroyed"]);
    const stored = await db.query.conversations.findFirst({ where: eq(conversations.id, conversation), columns: { workspace: true } });
    expect(stored?.workspace).toEqual({ kind: "scratch", image: asWorkspace });
    // The next tool call gets a fresh container, not the dead one.
    const next = await getConversationSandbox(alice, conversation);
    expect(next.ref).not.toBe(before.ref);
  }, 300_000);

  it.skipIf(!dockerReady)("moves a conversation back to Loxaic's own image when that is built here", async (ctx) => {
    if (!(await sandboxImageReady())) ctx.skip();
    const conversation = await conversationIn(alice, alicesImage);
    const before = await getConversationSandbox(alice, conversation);
    await before.writeFile(`${before.workdir}/work.txt`, "from the custom image");
    await replaceConversationSandbox(conversation, { kind: "scratch" });
    const after = await getConversationSandbox(alice, conversation);
    await expect(after.readFile(`${after.workdir}/work.txt`)).resolves.toBe("from the custom image");
    expect((await after.exec(["test", "-w", `${after.workdir}/work.txt`])).exitCode).toBe(0);
  }, 300_000);

  it("applies an admin's limits to a shared image's sandboxes, pulled with the deployment's login", async () => {
    // Bob's personal login cannot help: a shared image uses deployment logins
    // only. With none, the private image is refused.
    const bare = await addImage(null, { reference, label: "Marker (no login)", limits: { memoryMb: 768, cpus: 0.5, pids: 200 } }, alice);
    expect((await pulled(bare)).status).toBe("failed");
    await db.delete(sandboxImages).where(eq(sandboxImages.id, bare.id));

    await saveLogin(null, { registry: host, username: USERNAME, secret: PASSWORD }, alice);
    const shared = await addImage(null, { reference, label: "Marker", limits: { memoryMb: 768, cpus: 0.5, pids: 200 } }, alice);
    expect((await pulled(shared)).status).toBe("ready");

    const conversation = await conversationIn(bob, shared);
    const handle = await getConversationSandbox(bob, conversation);
    const info = await docker.getContainer(handle.ref).inspect();
    expect(info.HostConfig.Memory).toBe(768 * 1024 * 1024);
    expect(info.HostConfig.NanoCpus).toBe(5e8);
    expect(info.HostConfig.PidsLimit).toBe(200);
  }, 300_000);
});
