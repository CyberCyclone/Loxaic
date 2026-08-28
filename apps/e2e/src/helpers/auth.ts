/**
 * Test-user provisioning.
 *
 * Every run invents its own user rather than sharing a fixture account, so
 * suites never collide over one account's conversation list and a fresh
 * checkout needs no manual seeding. better-auth is configured without email
 * verification, so a signed-up user is immediately usable.
 */
import { BASE_URL } from '../../scripts/standup.ts';

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
