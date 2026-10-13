import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import type { ExecResult, SandboxHandle } from "../../sandbox/provider.ts";
import { __resetEgressCaForTest } from "../ca.ts";
import { EgressCaError, __forgetPreparedCaForTest, egressEnv, setRunningEgressProxy, withEgress } from "../env.ts";

process.env.MCP_ENCRYPTION_KEY ??= "egress-env-test-key";

/**
 * A sandbox whose `.loxaic/` cannot be written. The proxy is running, so its
 * GitHub traffic is meant to go through it; an empty environment would send a
 * clone to github.com without a credential, to fail as "repository not found".
 */
let dir = "";
const done = { truncated: false, timedOut: false };
const identity = { conversationId: "c", ownerId: "o" };

function handleWith(commandResult: ExecResult, calls: { command: string[]; env?: Record<string, string> }[]): SandboxHandle {
  const exec = (command: string[], options?: { env?: Record<string, string> }): Promise<ExecResult> => {
    calls.push({ command, env: options?.env });
    if (command[0] === "sh" && command[2]?.includes("LOXAIC_EGRESS_CA")) {
      return Promise.resolve({ ...done, exitCode: 1, stdout: "", stderr: "sh: can't create /r/.loxaic/ca-bundle.pem: Read-only file system\n" });
    }
    return Promise.resolve(commandResult);
  };
  return { provider: "container", ref: `ref-${String(Math.random())}`, root: "/r", workdir: "/r/repo", exec } as unknown as SandboxHandle;
}

beforeAll(() => {
  dir = mkdtempSync(path.join(os.tmpdir(), "loxaic-egress-env-"));
  process.env.EGRESS_CA_DIR = dir;
  __resetEgressCaForTest();
  __forgetPreparedCaForTest();
  setRunningEgressProxy({ port: 1, bind: "127.0.0.1" });
});

afterAll(() => {
  setRunningEgressProxy(null);
  Reflect.deleteProperty(process.env, "EGRESS_CA_DIR");
  rmSync(dir, { recursive: true, force: true });
});

describe("when the proxy's CA cannot be written into a sandbox", () => {
  it("egressEnv says so, naming why, rather than returning no proxy", async () => {
    const handle = handleWith({ ...done, exitCode: 0, stdout: "", stderr: "" }, []);
    const err = await egressEnv(handle, identity).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(EgressCaError);
    expect((err as Error).message).toContain("Read-only file system");
    expect((err as Error).message).toContain("cannot reach GitHub through Loxaic");
  });

  it("a command still runs, and one that fails is told what is missing", async () => {
    const calls: { command: string[]; env?: Record<string, string> }[] = [];
    const failing = withEgress(handleWith({ ...done, exitCode: 128, stdout: "", stderr: "fatal: repository not found\n" }, calls), identity);
    const result = await failing.exec(["git", "fetch"]);
    expect(result.exitCode).toBe(128);
    expect(result.stderr).toBe(
      "fatal: repository not found\n[Loxaic] " +
        "Loxaic could not put its GitHub certificate into this workspace (sh: can't create /r/.loxaic/ca-bundle.pem: Read-only file system), " +
        "so git and gh cannot reach GitHub through Loxaic from it.\n",
    );
    // The command ran, without a proxy it could not have used.
    expect(calls.at(-1)?.command).toEqual(["git", "fetch"]);
    expect(calls.at(-1)?.env?.HTTPS_PROXY).toBeUndefined();

    const fine = withEgress(handleWith({ ...done, exitCode: 0, stdout: "a\n", stderr: "" }, []), identity);
    expect(await fine.exec(["ls"])).toEqual({ ...done, exitCode: 0, stdout: "a\n", stderr: "" });
  });
});
