/**
 * Test-user provisioning.
 *
 * Every run invents its own user rather than sharing a fixture account, so
 * suites never collide over one account's conversation list and a fresh
 * checkout needs no manual seeding. better-auth is configured without email
 * verification, so a signed-up user is immediately usable.
 */
import { BASE_URL, E2E_ADMIN_EMAIL } from '../../scripts/standup.ts';

export interface Credentials {
  email: string;
  password: string;
  name: string;
}

export function uniqueCreds(): Credentials {
  const stamp = `${String(Date.now())}-${Math.random().toString(36).slice(2, 8)}`;
  return {
    // .test is reserved by RFC 2606 and can never resolve to a real mailbox.
    email: `e2e+${stamp}@example.test`,
    password: 'Password123!', // better-auth enforces a minimum of 8 characters.
    name: 'E2E User',
  };
}

/**
 * Creates a user straight through the API, for suites whose subject isn't the
 * sign-up screen itself. The smoke suite deliberately does NOT use this — it
 * signs up through the UI, because that flow is part of what it covers.
 */
export async function provisionUser(creds: Credentials = uniqueCreds()): Promise<Credentials> {
  const res = await fetch(`${BASE_URL}/api/auth/sign-up`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(creds),
  });
  if (!res.ok) {
    throw new Error(`sign-up failed (${String(res.status)}): ${await res.text()}`);
  }
  return creds;
}

/**
 * A fixed account granted the admin role via ADMIN_EMAILS on the server
 * standup.ts spawns (see there) — sandbox specs need a real admin session,
 * and "whoever signs up first" is unreliable against a DB standup reuses
 * across runs, unlike provisionUser()'s per-run unique accounts.
 *
 * Sign-up-or-sign-in: the first sandbox spec to run creates the account,
 * every later one (this run or a previous one against a reused DB) just
 * signs in to the same one. Only meaningful when standup.ts started the
 * server this run talks to — a manually-pointed or coincidentally-reused
 * server must already grant admin to this email itself.
 */
export function adminCreds(): Credentials {
  return { email: E2E_ADMIN_EMAIL, password: 'Password123!', name: 'E2E Admin' };
}

export async function provisionAdmin(): Promise<Credentials> {
  const creds = adminCreds();
  await fetch(`${BASE_URL}/api/auth/sign-up`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(creds),
  }); // Failure here almost always means the account already exists — signIn (by the caller) is the real check.
  return creds;
}
