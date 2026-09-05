import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { randomUUID } from "node:crypto";
import { v4 as uuid } from "uuid";
import { db, eq } from "@loxaic/db";
import { sandboxes, user } from "@loxaic/db/schema";
import { getConversationSandbox } from "../../agent/sandbox-manager.ts";
import type { SandboxHandle } from "../provider.ts";
import { sandboxImageReady } from "./docker-available.ts";

/**
 * Real-Docker proof that writeFileBinary actually routes around ARG_MAX.
 *
 * `writeFile` (the container provider's text path) passes its payload as a
 * bash argv argument, which is capped around ~2 MB once the environment is
 * counted (ARG_MAX). writeFileBinary exists specifically to stream a larger
 * payload over hijacked stdin instead. There is no meaningful way to fake
 * this — it needs a real container — so this test creates one via
 * getConversationSandbox, exactly like the app does on first tool use.
 *
 * Verification deliberately avoids handle.readFile(): the container
 * provider's readFile is `cat` through execInContainer, itself capped at
 * MAX_OUTPUT_BYTES (256 KB) — reading back a multi-MB payload that way would
 * be truncated by the very limitation writeFileBinary exists to route
 * around, making the test pass or fail for the wrong reason. `wc -c` and
 * `head -c`/`tail -c` piped through `od` keep the verification's own output
 * tiny regardless of the file's real size.
 */
const userId = `test-container-binary-${uuid()}`;
const conversationId = randomUUID();
let handle: SandboxHandle | undefined;

const dockerReady = await sandboxImageReady();

beforeAll(async () => {
  if (!dockerReady) return;
  await db.insert(user).values({
    id: userId,
    name: "Container Binary Test",
    email: `${userId}@example.test`,
    emailVerified: true,
    createdAt: new Date(),
    updatedAt: new Date(),
  });
  handle = await getConversationSandbox(userId, conversationId);
}, 60_000);

afterAll(async () => {
  if (!dockerReady) return;
  // Optional-chained: if beforeAll failed before assigning, this must not
  // throw a second, noisier error that buries the real one.
  await handle?.stop().catch(() => undefined);
  await db.delete(sandboxes).where(eq(sandboxes.conversationId, conversationId));
  await db.delete(user).where(eq(user.id, userId));
}, 30_000);

describe.skipIf(!dockerReady)("container provider — writeFileBinary", () => {
  it("streams a payload larger than ARG_MAX correctly", async () => {
    // The describe is skipped when there is no sandbox, so this holds whenever
    // the body runs — narrowing for the type checker rather than asserting
    // with `!`, which would hide a genuinely missing handle.
    if (!handle) throw new Error("no sandbox handle — beforeAll did not run");
    const size = 3 * 1024 * 1024; // 3 MB — comfortably past bash's ~2 MB ARG_MAX-with-environment ceiling
    const payload = Buffer.alloc(size);
    // A distinctive pattern, not all-zero, so a truncated-to-zero-length or
    // all-NUL failure mode would actually be caught by the spot checks below.
    for (let i = 0; i < size; i++) payload[i] = i % 251; // 251 is prime, avoids a short repeating cycle
    const remotePath = "/home/loxaic/binary-test.bin";

    await handle.writeFileBinary(remotePath, payload);

    const sizeCheck = await handle.exec(["wc", "-c", remotePath]);
    expect(sizeCheck.stdout.trim().split(/\s+/)[0]).toBe(String(size));

    const head = await handle.exec(["bash", "-c", 'head -c 10 "$1" | od -An -tu1', "_", remotePath]);
    expect(head.stdout.trim().split(/\s+/).map(Number)).toEqual(
      Array.from({ length: 10 }, (_, i) => i % 251),
    );

    const tail = await handle.exec(["bash", "-c", 'tail -c 10 "$1" | od -An -tu1', "_", remotePath]);
    const expectedTail = Array.from({ length: 10 }, (_, i) => (size - 10 + i) % 251);
    expect(tail.stdout.trim().split(/\s+/).map(Number)).toEqual(expectedTail);
  }, 60_000);
});
