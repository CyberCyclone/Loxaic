/**
 * Test-user provisioning.
 *
 * Every run invents its own user rather than sharing a fixture account, so
 * suites never collide over one account's conversation list and a fresh
 * checkout needs no manual seeding. better-auth is configured without email
 * verification, so a signed-up user is immediately usable.
 */
import { existsSync, readFileSync } from 'node:fs';
import { ADMIN_FILE, BASE_URL } from '../../scripts/standup.ts';

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
  if (!existsSync(ADMIN_FILE)) {
    throw new Error(
      `[e2e] no admin credentials at ${ADMIN_FILE}. They are generated per run by ` +
        'scripts/standup.ts, so the sandbox specs need a stack this harness started ' +
        '(a plain `pnpm dev` server has no ADMIN_EMAILS and cannot grant the role).',
    );
  }
  const { email, password } = JSON.parse(readFileSync(ADMIN_FILE, 'utf8')) as {
    email: string;
    password: string;
  };
  return { email, password, name: 'E2E Admin' };
}

export async function provisionAdmin(): Promise<Credentials> {
  const creds = adminCreds();
  // Sign in first: within one run several specs provision the same account,
  // and the credentials survive in artifacts/.run for the `standup` +
  // E2E_NO_STANDUP workflow. Only create it when it genuinely isn't there.
  const signIn = await fetch(`${BASE_URL}/api/auth/sign-in`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ email: creds.email, password: creds.password }),
  });
  if (signIn.ok) return creds;

  const res = await fetch(`${BASE_URL}/api/auth/sign-up`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(creds),
  });
  // Surfaced rather than deferred: letting a real failure (password policy,
  // wrong BASE_URL, network blip) fall through to the caller's signIn turns a
  // clear sign-up error into an opaque "invalid credentials" one.
  if (!res.ok) {
    throw new Error(`admin sign-up failed (${String(res.status)}): ${await res.text()}`);
  }
  return creds;
}
