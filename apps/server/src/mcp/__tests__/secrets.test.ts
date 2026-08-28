import { beforeAll, describe, expect, it } from "vitest";
import { decryptSecrets, encryptSecrets, redact, secretKeys } from "../secrets.ts";

beforeAll(() => {
  process.env.MCP_ENCRYPTION_KEY = "test-encryption-key";
});

describe("mcp secrets", () => {
  it("round-trips a secret map", () => {
    const blob = encryptSecrets({ BRAVE_API_KEY: "BSA-abc123", OTHER: "x-longer-value" });
    expect(blob.startsWith("v1:")).toBe(true);
    expect(blob).not.toContain("BSA-abc123");
    expect(decryptSecrets(blob)).toEqual({ BRAVE_API_KEY: "BSA-abc123", OTHER: "x-longer-value" });
  });

  it("uses a fresh salt and IV per blob", () => {
    const a = encryptSecrets({ K: "same-value" });
    const b = encryptSecrets({ K: "same-value" });
    expect(a).not.toEqual(b);
  });

  it("rejects tampered ciphertext", () => {
    const blob = encryptSecrets({ K: "value-goes-here" });
    const parts = blob.split(":");
    const ct = Buffer.from(parts[4], "base64");
    ct[0] ^= 0xff;
    parts[4] = ct.toString("base64");
    expect(() => decryptSecrets(parts.join(":"))).toThrow();
  });

  it("rejects malformed blobs", () => {
    expect(() => decryptSecrets("v2:a:b:c:d")).toThrow(/format/);
    expect(() => decryptSecrets("nonsense")).toThrow();
  });

  it("exposes only key names via secretKeys", () => {
    const blob = encryptSecrets({ BRAVE_API_KEY: "BSA-abc123" });
    expect(secretKeys(blob)).toEqual(["BRAVE_API_KEY"]);
    expect(secretKeys(null)).toEqual([]);
    expect(secretKeys("garbage")).toEqual([]);
  });

  it("redacts secret values from error text", () => {
    const secrets = { BRAVE_API_KEY: "BSA-abc123" };
    const text = "401 Unauthorized for key BSA-abc123 (header X-Subscription-Token: BSA-abc123)";
    const out = redact(text, secrets);
    expect(out).not.toContain("BSA-abc123");
    expect(out).toContain("[redacted]");
  });

  it("does not mangle text over too-short secret values", () => {
    expect(redact("abc abc abc", { K: "abc" })).toBe("abc abc abc");
  });
});
