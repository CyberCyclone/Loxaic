/**
 * Commit, push, and open a pull request from the Inspector — the actions the
 * agent is deliberately never told to take itself (see agent/workspace.ts's
 * describeWorkspace: "do not push … the user does that from the interface").
 *
 * Builds on agent-github-workspace.spec.ts's flow: clone into a networked
 * sandbox, then dirty it with the same `fs_write` trigger smoke.spec.ts uses,
 * commit and push through the panel, and confirm the push landed by reading
 * the harness's own bare repository — not by trusting the UI's word for it.
 * The PR is confirmed against the mock GitHub API's own record of the call.
 */
import { execFileSync } from "node:child_process";
import { provisionAdmin, provisionUser, uniqueCreds } from "../helpers/auth.ts";
import { GIT_SERVER_DIR, mockGithubUrl } from "../../scripts/standup.ts";
import { VALID_TOKEN } from "../../scripts/mock-github.ts";
import { shot } from "../helpers/screenshot.ts";
import { tap, typeInto, waitForTextIn, waitForVisible } from "../helpers/selectors.ts";
import {
  TOOL_PROMPT,
  MOCK_TOOL_DONE,
  chooseGithubWorkspace,
  connectGithub,
  goToSurface,
  listConversations,
  patchSandboxSettings,
  resetSandboxSettings,
  sendMessage,
  signIn,
  waitForRunDone,
} from "../helpers/app.ts";

interface RecordedPull {
  number: number;
  owner: string;
  repo: string;
  head: string;
  base: string;
  title: string;
}

describe("git actions from the Inspector", () => {
  const creds = uniqueCreds();

  before(async function () {
    this.timeout(60_000);
    await provisionAdmin();
    await resetSandboxSettings();
    await patchSandboxSettings({ allowNetwork: true });
    await provisionUser(creds);
    await connectGithub(creds, VALID_TOKEN);
    await signIn(creds);
  });

  after(async () => {
    await resetSandboxSettings();
  });

  it("commits, pushes, and opens a PR — all confirmed off the server, not the UI", async function () {
    this.timeout(4 * 60_000);

    await goToSurface("agent");
    const branch = await chooseGithubWorkspace(1);

    await tap("agent.mode.manual");
    await sendMessage(TOOL_PROMPT);
    await waitForVisible("agent.permission.bar");
    await tap("agent.permission.allow");
    await waitForTextIn("chat.messageList", MOCK_TOOL_DONE);

    const [conversation] = await listConversations(creds);
    await waitForRunDone(creds, conversation.id);

    await tap("agent.inspector.toggle");
    await waitForVisible("agent.inspector.git.branch");
    await waitForTextIn("agent.inspector.git.branch", branch);
    await waitForTextIn("agent.inspector.git.changed", "1 file");
    await shot("git-actions-dirty");

    await typeInto("agent.inspector.git.commitMessage", "add notes from the agent");
    await tap("agent.inspector.git.commit");
    await waitForTextIn("agent.inspector.git.changed", "No changes");
    await waitForTextIn("agent.inspector.git.aheadBehind", "1 ahead");
    await shot("git-actions-committed");

    await tap("agent.inspector.git.push");

    // Confirmed against the harness's own bare repository, not the app —
    // "ahead"/"behind" in the panel are measured against the *base* branch
    // (see routes/git.ts), so they say nothing about whether a push
    // happened and cannot be used to wait on one. Polled instead, since the
    // push is a real network round trip whose completion the UI otherwise
    // gives no distinct signal for.
    const gitDir = `${GIT_SERVER_DIR}/bugfix-app.git`;
    const deadline = Date.now() + 30_000;
    let log = "";
    for (;;) {
      log = execFileSync("git", ["--git-dir", gitDir, "branch", "--list", branch]).toString();
      if (log.trim() !== "") break;
      if (Date.now() > deadline) throw new Error(`[e2e] branch ${branch} never appeared on the origin`);
      await new Promise((r) => setTimeout(r, 500));
    }
    log = execFileSync("git", ["--git-dir", gitDir, "log", "--oneline", branch]).toString();
    expect(log).toContain("add notes from the agent");
    await shot("git-actions-pushed");

    await typeInto("agent.inspector.git.prTitle", "Add notes");
    await tap("agent.inspector.git.openPr");
    await waitForVisible("agent.inspector.git.prLink");
    await waitForTextIn("agent.inspector.git.prLink", "Pull request #");
    await shot("git-actions-pr-opened");

    // And the mock GitHub server's own record of the call — proof the
    // request the panel fired actually reached it, with the right head and
    // base, independent of whatever the UI displays. Found by branch, not by
    // being the only entry: the mock's pull list is shared server-wide, and
    // another spec exercising the same PR flow concurrently (agent-bugfix.spec.ts
    // does) legitimately adds its own entry to the same list.
    const res = await fetch(`${mockGithubUrl()}/__e2e/pulls`);
    const recorded = (await res.json()) as RecordedPull[];
    const mine = recorded.find((p) => p.head === branch);
    expect(mine).toMatchObject({ owner: "e2e", repo: "bugfix-app", head: branch, base: "main", title: "Add notes" });
  });
});
