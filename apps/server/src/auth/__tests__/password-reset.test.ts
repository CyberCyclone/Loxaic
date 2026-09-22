import { afterAll, describe, expect, it } from "vitest";
import { v4 as uuid } from "uuid";
import { db, eq, inArray } from "@loxaic/db";
import { account, session, user } from "@loxaic/db/schema";
import { auth } from "../index.ts";
import {
  clearMustChangePassword,
  findUserByEmail,
  generateTemporaryPassword,
  resetUserPassword,
  UserNotFoundError,
} from "../password-reset.ts";

/**
 * The shared reset, against the real database and real better-auth sign-in.
 *
 * The assertion that matters most is that a temporary password *signs in*:
 * it is hashed here with better-auth/crypto rather than through better-auth's
 * own endpoint, so this is what catches the two drifting apart.
 */
const PASSWORD = "original-password-1";
const TEMP_FORMAT = /^[A-HJ-NP-Za-km-z2-9]{4}(-[A-HJ-NP-Za-km-z2-9]{4}){3}$/;
const userIds: string[] = [];

async function signUp() {
  const email = `pw-reset-${uuid()}@example.test`;
  const res = await auth.api.signUpEmail({ body: { email, password: PASSWORD, name: "Reset Test" } });
  userIds.push(res.user.id);
  return { email, token: res.token ?? "", id: res.user.id };
}

const signIn = (email: string, password: string) =>
  auth.api.signInEmail({ body: { email, password } });

describe("generateTemporaryPassword", () => {
  it("is four groups of unambiguous characters, and never repeats", () => {
    const seen = new Set<string>();
    for (let i = 0; i < 100; i++) {
      const p = generateTemporaryPassword();
      expect(p).toMatch(TEMP_FORMAT);
      seen.add(p);
    }
    expect(seen.size).toBe(100);
  });
});

describe("resetUserPassword", () => {
  it("replaces the password, flags the account, and signs out every device", async () => {
    const u = await signUp();
    // A second device.
    await signIn(u.email, PASSWORD);
    const { temporaryPassword } = await resetUserPassword(u.id);
    expect(temporaryPassword).toMatch(TEMP_FORMAT);

    expect(await db.select().from(session).where(eq(session.userId, u.id))).toHaveLength(0);
    const before = await auth.api.getSession({ headers: new Headers({ authorization: `Bearer ${u.token}` }) });
    expect(before).toBeNull();

    await expect(signIn(u.email, PASSWORD)).rejects.toThrow();
    const res = await signIn(u.email, temporaryPassword);
    expect(res.user.mustChangePassword).toBe(true);
  });

  it("is cleared by a password change", async () => {
    const u = await signUp();
    const { temporaryPassword } = await resetUserPassword(u.id);
    const signedIn = await signIn(u.email, temporaryPassword);
    await auth.api.changePassword({
      body: { currentPassword: temporaryPassword, newPassword: "brand-new-password", revokeOtherSessions: true },
      headers: new Headers({ authorization: `Bearer ${signedIn.token}` }),
    });
    await clearMustChangePassword(u.id);
    const [row] = await db.select({ flag: user.mustChangePassword }).from(user).where(eq(user.id, u.id));
    expect(row.flag).toBe(false);
    const again = await signIn(u.email, "brand-new-password");
    expect(again.user.mustChangePassword).toBe(false);
  });

  it("creates a credential account for a user who has none", async () => {
    const id = `pw-reset-bare-${uuid()}`;
    const email = `${id}@example.test`;
    userIds.push(id);
    await db.insert(user).values({ id, name: id, email, emailVerified: false, createdAt: new Date(), updatedAt: new Date() });
    const { temporaryPassword } = await resetUserPassword(id);
    const res = await signIn(email, temporaryPassword);
    expect(res.user.id).toBe(id);
  });

  it("refuses an id that is not a user", async () => {
    await expect(resetUserPassword(`nobody-${uuid()}`)).rejects.toBeInstanceOf(UserNotFoundError);
  });
});

describe("findUserByEmail", () => {
  it("ignores case and surrounding space", async () => {
    const u = await signUp();
    const found = await findUserByEmail(`  ${u.email.toUpperCase()} `);
    expect(found?.id).toBe(u.id);
    expect(await findUserByEmail(`missing-${uuid()}@example.test`)).toBeNull();
  });
});

afterAll(async () => {
  if (!userIds.length) return;
  await db.delete(session).where(inArray(session.userId, userIds));
  await db.delete(account).where(inArray(account.userId, userIds));
  await db.delete(user).where(inArray(user.id, userIds));
});
