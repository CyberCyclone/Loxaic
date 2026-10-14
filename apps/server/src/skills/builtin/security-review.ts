export const SECURITY_REVIEW_SKILL = `---
name: security-review
description: Find exploitable vulnerabilities by tracing untrusted input to dangerous sinks. Use when asked for a security review or audit.
argument-hint: "[what to review]"
---
# Security review

Find vulnerabilities an attacker could actually exploit. Every finding needs an
attack: who sends what, and what they gain.

## 1. Scope

- Review what you were asked to (a diff, a pull request, a directory, a whole
  service). For a change, read the diff and then the code around it, as in the
  \`code-review\` skill.
- Learn the trust boundaries first: who can call this code (anonymous users,
  signed-in users, admins, other services), and what data crosses in.

## 2. Find the sources

Untrusted input includes request bodies, query strings, headers, cookies, file
uploads and their names, webhooks, message queues, data read back from a
database that a user wrote, environment the attacker controls, and anything
fetched from the network — including model output.

## 3. Trace each source to its sinks

| Sink | Look for |
|---|---|
| SQL / NoSQL queries | string concatenation instead of parameters |
| Shell commands | input in a command line; \`shell: true\`; unquoted arguments |
| File paths | \`..\`, absolute paths, symlinks; joins without a containment check |
| Outgoing requests | user-chosen URLs reaching internal addresses (SSRF), redirects |
| HTML / templates | unescaped output (XSS); \`dangerouslySetInnerHTML\`; unsafe content types |
| Deserialisation | \`eval\`, \`pickle\`, YAML/XML loaders with unsafe options, prototype pollution |
| Redirects | open redirects through a user-supplied target |
| Regular expressions | patterns that backtrack catastrophically on user input |

## 4. Check access control

- Is every route authenticated that should be?
- Is authorisation checked on the *object*, not only the route? Can user A read
  or change user B's record by changing an id?
- Are admin-only actions really restricted?
- Do sessions, tokens and password resets expire and get revoked correctly?

## 5. Check secrets and cryptography

- Secrets in source, logs, error messages, URLs or client bundles.
- Weak or home-made cryptography, predictable tokens (\`Math.random\`), missing
  constant-time comparison of secrets.
- Missing TLS verification.

## 6. Report

Most severe first. For each finding:

- **Where:** \`path/to/file:line\`
- **Vulnerability:** its class, in one sentence.
- **Attack:** the concrete request or input, and what the attacker gains.
- **Severity:** critical, high, medium or low, with a reason.
- **Fix:** what to change.

Do not report theoretical issues with no reachable attack, or best-practice
nits, as vulnerabilities; list them separately as hardening suggestions if they
are worth mentioning at all. If you found nothing exploitable, say so and say
what you examined.
`;
