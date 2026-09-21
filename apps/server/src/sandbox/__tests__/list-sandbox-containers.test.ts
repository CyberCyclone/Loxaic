import type Docker from "dockerode";
import { describe, expect, it } from "vitest";
import { EXECUTOR_LABEL, listSandboxContainersOn } from "../container-engine.ts";

/**
 * Which containers the orphan sweep is allowed to consider.
 *
 * Against a fake engine, because the rule that matters here is arithmetic on
 * a field only the engine fills in: `Created` is whole seconds, rounded down.
 * Compared against a millisecond cutoff, a container made half a second
 * *after* the cutoff read as older than it — and the cutoff is "when this
 * process started", so that container was one the running server had just
 * made. It was found by checking the default against a real engine; the
 * real-container tests pin the cutoff to 0 and Infinity and cannot see it.
 */
function fakeDocker(containers: { Id: string; Created: number; Labels: Record<string, string> }[]) {
  const calls: unknown[] = [];
  const docker = {
    listContainers: (options: unknown) => {
      calls.push(options);
      return Promise.resolve(containers);
    },
  } as unknown as Docker;
  return { docker, calls };
}

const sandbox = (Id: string, Created: number, extra: Record<string, string> = {}) => ({
  Id,
  Created,
  Labels: { "loxaic.sandbox": "x", ...extra },
});

describe("listSandboxContainersOn", () => {
  it("treats a container created in the cutoff's own second as young", async () => {
    const { docker } = fakeDocker([sandbox("old", 9), sandbox("same-second", 10), sandbox("later", 11)]);
    // 10.5 s: "same-second" may have been made at 10.9, after the cutoff, and
    // still reports 10.
    await expect(listSandboxContainersOn(docker, { createdBeforeMs: 10_500 })).resolves.toEqual(["old"]);
  });

  it("lists everything with no cutoff, stopped containers included", async () => {
    const { docker, calls } = fakeDocker([sandbox("a", 9), sandbox("b", 11)]);
    await expect(listSandboxContainersOn(docker)).resolves.toEqual(["a", "b"]);
    expect(calls[0]).toMatchObject({ all: true, filters: { label: ["loxaic.sandbox"] } });
  });

  it("narrows to one user by label, and still never returns an executor's container", async () => {
    const { docker, calls } = fakeDocker([sandbox("mine", 9), sandbox("executors", 9, { [EXECUTOR_LABEL]: "e1" })]);
    await expect(listSandboxContainersOn(docker, { userId: "u1" })).resolves.toEqual(["mine"]);
    expect(calls[0]).toMatchObject({ filters: { label: ["loxaic.sandbox", "loxaic.user=u1"] } });
  });
});
