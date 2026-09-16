import { describe, expect, it } from "vitest";
import { describeGithubPermissionFailure, isGithubPermissionFailure } from "../permissions.ts";

/**
 * The strings this module has to recognise are the real ones, verbatim, from
 * the failure that prompted it: a fine-grained token holding `Metadata: read`
 * and nothing else.
 */
const CLONE_STDERR =
  "git clone failed (exit 128): remote: Write access to repository not granted.\n" +
  "fatal: unable to access 'https://github.com/o/r/': The requested URL returned error: 403";
const FORBIDDEN_BODY = 'GitHub API 403: {"message":"Resource not accessible by personal access token"}';
const RATE_LIMITED = 'GitHub API 403: {"message":"API rate limit exceeded for user ID 1."}';

describe("isGithubPermissionFailure", () => {
  it("recognises a refusal that arrives with no status at all", () => {
    // The clone case. It reaches us as git's stderr through the sandbox
    // provider, so there is no HTTP status anywhere to key on — matching the
    // text is the only way this one is ever caught.
    expect(isGithubPermissionFailure(undefined, CLONE_STDERR)).toBe(true);
  });

  it("recognises GitHub's own 403 body", () => {
    expect(isGithubPermissionFailure(403, FORBIDDEN_BODY)).toBe(true);
  });

  it("does not mistake a rate limit for a permission problem", () => {
    // GitHub spends 403 on both. Keying on the status alone would send someone
    // to edit a token that was never the problem, to fix something editing it
    // cannot fix.
    expect(isGithubPermissionFailure(403, RATE_LIMITED)).toBe(false);
  });

  it("leaves everything else alone", () => {
    expect(isGithubPermissionFailure(404, 'GitHub API 404: {"message":"Not Found"}')).toBe(false);
    expect(isGithubPermissionFailure(500, "GitHub API 500: upstream error")).toBe(false);
    expect(isGithubPermissionFailure(0, "This operation was aborted")).toBe(false);
  });
});

describe("describeGithubPermissionFailure", () => {
  it("answers a read refusal by naming Contents, not the write access GitHub mentions", () => {
    const text = describeGithubPermissionFailure({
      message: CLONE_STDERR,
      repo: "octo/real",
      need: "contents-read",
    });
    expect(text).toContain("octo/real");
    expect(text).toContain("Contents: Read");
    // The correction itself is the point: someone reading git's message alone
    // would grant write access and still be unable to clone.
    expect(text).toMatch(/read-only clone/);
    expect(text).toContain("repo scope");
  });

  it("names the right permission for a push and for a pull request", () => {
    const push = describeGithubPermissionFailure({
      message: "remote: Write access to repository not granted.",
      repo: "octo/real",
      need: "contents-write",
    });
    expect(push).toContain("Contents: Read and write");

    const pr = describeGithubPermissionFailure({ status: 403, message: FORBIDDEN_BODY, repo: "octo/real", need: "pull-requests" });
    expect(pr).toContain("Pull requests: Read and write");
  });

  it("reads naturally when no repository is in hand", () => {
    // The connection screen has no repository in mind at all.
    const text = describeGithubPermissionFailure({ status: 403, message: FORBIDDEN_BODY, need: "contents-read" });
    expect(text).toContain("that repository");
  });

  it("always says where to go and what to do next", () => {
    const text = describeGithubPermissionFailure({ status: 403, message: FORBIDDEN_BODY, need: "contents-read" });
    expect(text).toMatch(/reconnect GitHub in Settings/);
  });

  it("returns null for anything it cannot actually diagnose", () => {
    // Null rather than a guess: every caller has a message of its own, and
    // mislabelling an outage as a missing scope is worse than saying nothing.
    for (const input of [
      { status: 403, message: RATE_LIMITED },
      { status: 404, message: 'GitHub API 404: {"message":"Not Found"}' },
      { status: 500, message: "GitHub API 500: upstream error" },
      { status: 0, message: "This operation was aborted" },
    ]) {
      expect(describeGithubPermissionFailure({ ...input, need: "contents-read" })).toBeNull();
    }
  });
});
