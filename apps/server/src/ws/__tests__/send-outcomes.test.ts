import { afterEach, describe, expect, it } from "vitest";
import { NotFoundError } from "../../streams/authz.ts";
import { __resetSendOutcomesForTest, beginSend, beginSendFor, keepMs, sendOutcomeFor } from "../send-outcomes.ts";

/** The rules of the send-outcome store; `send-status.test.ts` drives it over
 * real sockets. */
afterEach(() => { __resetSendOutcomesForTest(); });

const started = { streamId: "s1", conversationId: "c1", userMessageId: "m1" };

describe("send outcomes", () => {
  it("is pending from the moment the send is read, so an early ask waits instead of hearing unknown", async () => {
    const pending = beginSend("u1", "r1");
    // Asked while the send is still in its session check: not unknown.
    const asked = sendOutcomeFor("u1", "r1");
    expect(asked).toBeDefined();
    let settled = false;
    void asked?.then(() => { settled = true; });
    await Promise.resolve();
    expect(settled).toBe(false);

    pending.started(Promise.resolve(started));
    await expect(asked).resolves.toEqual({
      type: "turn.started",
      stream_id: "s1",
      conversation_id: "c1",
      user_message_id: "m1",
      client_ref: "r1",
    });
  });

  it("answers a run that failed to start with the error the socket was told", async () => {
    const pending = beginSend("u1", "r1");
    pending.started(Promise.reject(new NotFoundError()));
    await expect(sendOutcomeFor("u1", "r1")).resolves.toEqual({ type: "error", error: "not found", client_ref: "r1" });
  });

  it("carries a no-room refusal's code", async () => {
    const pending = beginSend("u1", "r1");
    pending.failed(Object.assign(new Error("No room"), { code: "local_model_no_room" }));
    await expect(sendOutcomeFor("u1", "r1")).resolves.toEqual({
      type: "error",
      error: "No room",
      code: "local_model_no_room",
      client_ref: "r1",
    });
  });

  it("counts only the first settlement", async () => {
    const pending = beginSend("u1", "r1");
    pending.started(Promise.resolve(started));
    pending.failed(new Error("too late"));
    await expect(sendOutcomeFor("u1", "r1")).resolves.toMatchObject({ type: "turn.started" });
  });

  it("keeps one user's sends from another, whatever the ref", () => {
    beginSend("u1", "same");
    expect(sendOutcomeFor("u2", "same")).toBeUndefined();
  });

  it("knows nothing of a send it never saw", () => {
    expect(sendOutcomeFor("u1", "never")).toBeUndefined();
  });

  it("only begins for this surface's send, naming itself", () => {
    expect(beginSendFor("u1", { type: "stream.subscribe" }, "chat")).toBeUndefined();
    expect(beginSendFor("u1", { type: "chat.send" }, "chat")).toBeUndefined();
    expect(beginSendFor("u1", { type: "chat.send", client_ref: "has spaces" } as { type: string }, "chat")).toBeUndefined();
    expect(beginSendFor("u1", { type: "agent.send", client_ref: "lm1" } as { type: string }, "agent")).toBeDefined();
    expect(sendOutcomeFor("u1", "lm1")).toBeDefined();
  });

  it("does not remember the other surface's send, which that socket never settles", () => {
    // An agent.send on the chat socket falls through the chat handler: a
    // remembered answer for it would never settle, and an ask would hang.
    expect(beginSendFor("u1", { type: "agent.send", client_ref: "lm2" } as { type: string }, "chat")).toBeUndefined();
    expect(sendOutcomeFor("u1", "lm2")).toBeUndefined();
  });

  it("keeps an answer no longer than a setTimeout can wait", () => {
    const before = process.env.STREAM_TTL_SECONDS;
    try {
      // 30 days: past 2**31 - 1 ms, where a timer delay silently becomes 1 ms.
      process.env.STREAM_TTL_SECONDS = String(30 * 86_400);
      expect(keepMs()).toBe(86_400_000);
      process.env.STREAM_TTL_SECONDS = "60";
      expect(keepMs()).toBe(60_000);
    } finally {
      if (before === undefined) Reflect.deleteProperty(process.env, "STREAM_TTL_SECONDS");
      else process.env.STREAM_TTL_SECONDS = before;
    }
  });

  it("keeps only the newest fifty per user", () => {
    for (let i = 0; i < 51; i++) beginSend("u1", `r${String(i)}`);
    expect(sendOutcomeFor("u1", "r0")).toBeUndefined();
    expect(sendOutcomeFor("u1", "r1")).toBeDefined();
    expect(sendOutcomeFor("u1", "r50")).toBeDefined();
  });
});
