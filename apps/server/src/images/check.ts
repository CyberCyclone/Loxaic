/**
 * What a custom image must have for Loxaic's tools to work in it, checked by
 * running it: one throwaway sandbox, made by the same `createSandboxContainer`
 * real ones are, with no network, removed afterwards.
 *
 * Probing through a real sandbox rather than a bare container tests what will
 * actually run: every exec goes through the `setsid -w bash` wrapper, so the
 * first one failing *is* the answer "this image lacks bash or util-linux's
 * setsid" — and the probe itself needs no `/bin/sh`.
 *
 * Required tools are the ones the code reaches for unconditionally: the exec
 * wrapper and its killer (setsid, seq, sleep, cat, kill, a writable /tmp),
 * `sh` (egress/env.ts writes a GitHub workspace's CA bundle with it),
 * the file tools (base64, mkdir, dirname, cat, awk, GNU find), checkpoints
 * (cp -p, rm, wc, tr), and the project-instruction and skill reads (realpath,
 * cksum, head, tail). Missing any one breaks a tool silently mid-run, so the
 * image is refused instead. Others narrow what works, and are said.
 */
import type Docker from "dockerode";
import { createSandboxContainer } from "../sandbox/container-engine.ts";
import type { ImageCheck, ImageWarningCode } from "./access.ts";

export interface ProbeResult {
  check: ImageCheck;
  uid: number | null;
  gid: number | null;
}

/** Marks a probe's container, beside the `loxaic.sandbox` label every sandbox
 * carries — so a probe that outlives its process is swept like any orphan. */
const PROBE_LABEL = "loxaic.imageCheck";

const REQUIRED = [
  "sh", "tail", "cat", "mkdir", "rm", "cp", "dirname", "base64", "head", "wc", "tr",
  "seq", "sleep", "kill", "awk", "realpath", "cksum", "find", "id",
];

/**
 * The probe, as one bash script printing `key=value` lines. Kept as data so
 * the parser below is tested against its exact output shape.
 */
export const PROBE_SCRIPT = [
  'printf "uid=%s\\n" "$(id -u 2>/dev/null)"',
  'printf "gid=%s\\n" "$(id -g 2>/dev/null)"',
  `for t in ${REQUIRED.join(" ")}; do command -v "$t" >/dev/null 2>&1 || echo "missing=$t"; done`,
  'setsid -w true >/dev/null 2>&1 || echo "missing=setsid -w (util-linux)"',
  'f="/tmp/.loxaic-probe-$$"; { printf x > "$f" && rm -f "$f"; } 2>/dev/null || echo "missing=a writable /tmp"',
  'find / -maxdepth 0 -printf "%y" >/dev/null 2>&1 || echo "missing=GNU find (-printf)"',
  // The exact awk program fs_read runs.
  `[ "$(printf 'a\\nb\\n' | awk -v s=2 -v e=2 'NR>=s && NR<=e {print NR"\\t"$0}' 2>/dev/null)" = "$(printf '2\\tb')" ] || echo "missing=a POSIX awk"`,
  't="/tmp/.loxaic-cp-$$"; { : > "$t" && cp -p "$t" "$t.c" && rm -f "$t" "$t.c"; } 2>/dev/null || echo "missing=cp -p"',
  'for t in git gh rg; do command -v "$t" >/dev/null 2>&1 || echo "warn=$t"; done',
  '{ [ -f /etc/ssl/certs/ca-certificates.crt ] || [ -f /etc/ssl/cert.pem ] || [ -f /etc/pki/tls/certs/ca-bundle.crt ] || [ -f /etc/ssl/ca-bundle.pem ]; } || echo "warn=ca"',
  // The agent's bash tool runs a login shell, and on Debian-family images
  // /etc/profile resets PATH — an SDK's ENV PATH entries would vanish.
  'lp=$(bash -lc \'printf %s "$PATH"\' 2>/dev/null); IFS=: read -ra dirs <<< "$PATH"; for d in "${dirs[@]}"; do case ":$lp:" in *":$d:"*) ;; *) echo "warn=path:$d";; esac; done',
].join("\n");

const WARNINGS: Record<Exclude<ImageWarningCode, "path" | "root">, string> = {
  git: "No git, so GitHub workspaces can't use this image.",
  gh: "No gh, so the agent can't open pull requests from this image.",
  rg: "No ripgrep (rg), so the agent's search and file-finding tools won't work.",
  ca: "No CA certificate bundle where Loxaic looks, so HTTPS from the sandbox may fail.",
};

/** Turns the probe's output into a check. Pure. */
export function parseProbe(stdout: string): ProbeResult {
  const missing: string[] = [];
  const warnings: ImageCheck["warnings"] = [];
  const lostPath: string[] = [];
  let uid: number | null = null;
  let gid: number | null = null;
  for (const line of stdout.split("\n")) {
    const eq = line.indexOf("=");
    if (eq === -1) continue;
    const key = line.slice(0, eq);
    const value = line.slice(eq + 1).trim();
    if (key === "uid" || key === "gid") {
      const n = /^\d+$/.test(value) ? Number(value) : null;
      if (key === "uid") uid = n;
      else gid = n;
    } else if (key === "missing" && value && !missing.includes(value)) {
      missing.push(value);
    } else if (key === "warn") {
      if (value.startsWith("path:")) lostPath.push(value.slice(5));
      else if (value in WARNINGS && !warnings.some((w) => w.code === value)) {
        const code = value as keyof typeof WARNINGS;
        warnings.push({ code, message: WARNINGS[code] });
      }
    }
  }
  if (lostPath.length > 0) {
    warnings.push({
      code: "path",
      message: `A login shell drops ${lostPath.join(", ")} from PATH, so the agent's commands won't find what is there.`,
    });
  }
  // Allowed (the owner's choice), but never silently: a non-root user is the
  // built-in image's biggest control, and with it gone only the dropped
  // capabilities and no-new-privileges remain between the model and the box.
  if (uid === 0) {
    warnings.push({
      code: "root",
      message: "Runs as root. Every capability is still dropped, but the agent's commands run as root inside the container.",
    });
  }
  if (uid === null || gid === null) {
    if (!missing.includes("id")) missing.push("id");
  }
  return { check: { missing, warnings }, uid, gid };
}

/** Refuses an image that carries labels in Loxaic's own namespace: a container
 * inherits its image's labels, and an inherited `loxaic.executor` would hide
 * its sandboxes from the orphan sweep. */
export function labelRefusal(labels: Record<string, string> | null | undefined): string | null {
  const ours = Object.keys(labels ?? {}).filter((k) => k.startsWith("loxaic."));
  return ours.length > 0 ? `The image carries labels Loxaic reserves (${ours.join(", ")}).` : null;
}

/**
 * Runs the probe in a throwaway sandbox from `ref` (a pinned `repo@digest`).
 * `owner` labels it like a sandbox of theirs, so a scoped sweep sees it.
 */
export async function probeImage(docker: Docker, ref: string, owner: string): Promise<ProbeResult> {
  const handle = await createSandboxContainer(docker, {
    userId: owner,
    network: false,
    image: { ref },
    labels: { [PROBE_LABEL]: "1" },
  });
  try {
    // The sandbox's main process is `tail`; without it the container exits
    // as soon as it starts (under tini, so the start itself succeeds), and
    // every exec is refused as "not running". Said as what it is.
    // Docker Desktop refuses that exec outright; Docker on Linux can run it
    // into a container already going down and report a failed exit instead.
    // Either way the question is whether the container is still up, asked
    // after a moment for it to finish stopping.
    const first = await handle.exec(["true"], { workdir: "/", timeoutMs: 30_000 }).catch(() => null);
    if (first === null || first.exitCode !== 0) {
      await new Promise((r) => setTimeout(r, 500));
      if (!(await handle.isRunning())) {
        return { check: { missing: ["tail (the container stops as soon as it starts)"], warnings: [] }, uid: null, gid: null };
      }
    }
    if (first === null || first.exitCode !== 0) {
      return { check: { missing: ["bash and setsid -w (util-linux)"], warnings: [] }, uid: null, gid: null };
    }
    const res = await handle.exec(["bash", "-c", PROBE_SCRIPT], { workdir: "/", timeoutMs: 60_000 });
    return parseProbe(res.stdout);
  } finally {
    await handle.destroy();
  }
}
