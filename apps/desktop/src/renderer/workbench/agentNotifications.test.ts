import { describe, expect, it } from "vitest";
import {
  deriveAgentActivity,
  dismissAgentNotification,
  reduceAgentNotifications,
  type AgentActivityInput,
  type AgentNotification,
  type AgentSessionLike,
} from "./agentNotifications";
import type { MentionCandidate } from "@dohc/workspace-contracts/chat-mentions";

const userCandidates: MentionCandidate[] = [
  { id: "user:you", kind: "user", handle: "you", label: "You" },
];

function session(overrides: Partial<AgentSessionLike> = {}): AgentSessionLike {
  return {
    status: "running",
    runId: "run-1",
    messages: [],
    pendingPermissions: [],
    ...overrides,
  };
}

const NOW = 1_700_000_000_000;

function input(overrides: Partial<AgentActivityInput> = {}): AgentActivityInput {
  return {
    workspaceId: "ws-a",
    workspaceName: "Personal",
    agentName: "You's agent",
    runId: "run-1",
    status: "running",
    ...overrides,
  };
}

function reduce(
  prev: AgentNotification[],
  activity: AgentActivityInput,
  dismissed?: Set<string>,
): AgentNotification[] {
  return reduceAgentNotifications(prev, activity, {
    nowMs: NOW,
    ...(dismissed ? { dismissed } : {}),
  });
}

describe("reduceAgentNotifications triggers", () => {
  it("raises nothing while a run is merely running", () => {
    expect(reduce([], input({ status: "running" }))).toEqual([]);
  });

  it("raises a finished notice on completion with specific copy", () => {
    const next = reduce(
      [],
      input({ status: "completed", latestSummary: "Reorganized /notes into three folders." }),
    );
    expect(next).toHaveLength(1);
    expect(next[0]!.kind).toBe("finished");
    expect(next[0]!.title).toBe("Your agent finished");
    expect(next[0]!.body).toBe("Reorganized /notes into three folders.");
  });

  it("raises a needs-input notice when blocked on a permission", () => {
    const next = reduce(
      [],
      input({ status: "waiting-permission", pendingPermissionTitle: "Run: rm notes/old.md" }),
    );
    expect(next[0]!.kind).toBe("needs-input");
    expect(next[0]!.body).toContain("rm notes/old.md");
  });

  it("promotes a completion to asked when the agent addressed the user", () => {
    const next = reduce(
      [],
      input({ status: "completed", addressedToUser: true, latestSummary: "Which draft should I keep?" }),
    );
    expect(next[0]!.kind).toBe("asked");
    expect(next[0]!.title).toBe("Your agent has a question");
  });

  it("raises an error notice with the failure reason", () => {
    const next = reduce([], input({ status: "failed", lastError: "codex exited with code 1" }));
    expect(next[0]!.kind).toBe("error");
    expect(next[0]!.body).toBe("codex exited with code 1");
  });

  it("does not raise a notice for a run with no id yet", () => {
    expect(reduce([], input({ runId: null, status: "completed" }))).toEqual([]);
  });
});

describe("reduceAgentNotifications coalescing", () => {
  it("does not duplicate or re-stamp a notice across repeated polls", () => {
    const first = reduce([], input({ status: "completed", latestSummary: "done" }));
    const second = reduceAgentNotifications(first, input({ status: "completed", latestSummary: "done" }), {
      nowMs: NOW + 5_000,
    });
    expect(second).toHaveLength(1);
    expect(second[0]).toBe(first[0]);
    expect(second[0]!.createdAtMs).toBe(NOW);
  });

  it("supersedes needs-input with finished on a state transition", () => {
    const blocked = reduce([], input({ status: "waiting-permission" }));
    const done = reduce(blocked, input({ status: "completed", latestSummary: "all set" }));
    expect(done).toHaveLength(1);
    expect(done[0]!.kind).toBe("finished");
  });

  it("keeps notices for other runs untouched", () => {
    const runOne = reduce([], input({ runId: "run-1", status: "completed", latestSummary: "one" }));
    const runTwo = reduce(runOne, input({ runId: "run-2", status: "failed", lastError: "boom" }));
    expect(runTwo.map((n) => n.runId).sort()).toEqual(["run-1", "run-2"]);
  });
});

describe("reduceAgentNotifications reference stability", () => {
  // The hook polls every ~1.5s for the app's life and feeds the result into
  // setState; a no-op tick MUST return the SAME array so React bails out.
  it("returns the identical array on an idle (no-run) tick", () => {
    const prev: AgentNotification[] = [];
    expect(reduce(prev, input({ runId: null, status: "running" }))).toBe(prev);
  });

  it("returns the identical array while a run merely keeps running", () => {
    const prev: AgentNotification[] = [];
    expect(reduce(prev, input({ status: "running" }))).toBe(prev);
  });

  it("returns the identical array on a steady completed re-poll (no change)", () => {
    const done = reduce([], input({ status: "completed", latestSummary: "done" }));
    const second = reduce(done, input({ status: "completed", latestSummary: "done" }));
    expect(second).toBe(done);
  });

  it("returns the identical array when the desired notice is already dismissed", () => {
    const done = reduce([], input({ status: "completed", latestSummary: "done" }));
    const dismissed = new Set([done[0]!.id]);
    const cleared = dismissAgentNotification(done, done[0]!.id);
    const next = reduce(cleared, input({ status: "completed", latestSummary: "done" }), dismissed);
    expect(next).toBe(cleared);
  });

  it("allocates a NEW array when a real change occurs", () => {
    const prev: AgentNotification[] = [];
    const next = reduce(prev, input({ status: "completed", latestSummary: "done" }));
    expect(next).not.toBe(prev);
    expect(next).toHaveLength(1);
  });

  it("allocates a NEW array when a run resumes and clears its notice", () => {
    const blocked = reduce([], input({ status: "waiting-permission" }));
    const resumed = reduce(blocked, input({ status: "running" }));
    expect(resumed).not.toBe(blocked);
    expect(resumed).toEqual([]);
  });
});

describe("reduceAgentNotifications auto-clear", () => {
  it("clears a needs-input notice when the run resumes", () => {
    const blocked = reduce([], input({ status: "waiting-permission" }));
    expect(blocked).toHaveLength(1);
    const resumed = reduce(blocked, input({ status: "running" }));
    expect(resumed).toEqual([]);
  });

  it("does not re-raise a dismissed state", () => {
    const done = reduce([], input({ status: "completed", latestSummary: "done" }));
    const dismissed = new Set([done[0]!.id]);
    const afterDismiss = dismissAgentNotification(done, done[0]!.id);
    const nextPoll = reduce(afterDismiss, input({ status: "completed", latestSummary: "done" }), dismissed);
    expect(nextPoll).toEqual([]);
  });

  it("re-raises after a NEW run reaches the same state", () => {
    const done = reduce([], input({ status: "completed", latestSummary: "done" }));
    const dismissed = new Set([done[0]!.id]);
    const cleared = dismissAgentNotification(done, done[0]!.id);
    const newRun = reduce(cleared, input({ runId: "run-2", status: "completed", latestSummary: "again" }), dismissed);
    expect(newRun).toHaveLength(1);
    expect(newRun[0]!.runId).toBe("run-2");
  });

  it("re-raises needs-input for a NEW permission on the same run after the first was dismissed", () => {
    // Permission A blocks the run.
    const blockedA = reduce(
      [],
      input({
        status: "waiting-permission",
        pendingPermissionTitle: "Run: rm a.md",
        pendingPermissionId: "perm-a",
      }),
    );
    expect(blockedA).toHaveLength(1);
    // The user dismisses it.
    const dismissed = new Set([blockedA[0]!.id]);
    const afterDismiss = dismissAgentNotification(blockedA, blockedA[0]!.id);
    // The run resumes — needs-input auto-clears.
    const resumed = reduce(afterDismiss, input({ status: "running" }), dismissed);
    expect(resumed).toEqual([]);
    // The run hits a DIFFERENT permission — a fresh notice IS raised (not
    // suppressed by the dismissed permission-A id).
    const blockedB = reduce(
      resumed,
      input({
        status: "waiting-permission",
        pendingPermissionTitle: "Run: rm b.md",
        pendingPermissionId: "perm-b",
      }),
      dismissed,
    );
    expect(blockedB).toHaveLength(1);
    expect(blockedB[0]!.kind).toBe("needs-input");
    expect(blockedB[0]!.body).toContain("rm b.md");
  });

  it("still suppresses a re-poll of the SAME dismissed permission", () => {
    const blocked = reduce(
      [],
      input({ status: "waiting-permission", pendingPermissionTitle: "Run: rm a.md", pendingPermissionId: "perm-a" }),
    );
    const dismissed = new Set([blocked[0]!.id]);
    const afterDismiss = dismissAgentNotification(blocked, blocked[0]!.id);
    const repoll = reduce(
      afterDismiss,
      input({ status: "waiting-permission", pendingPermissionTitle: "Run: rm a.md", pendingPermissionId: "perm-a" }),
      dismissed,
    );
    expect(repoll).toEqual([]);
  });
});

describe("deriveAgentActivity", () => {
  const base = {
    workspaceId: "ws-a",
    workspaceName: "Personal",
    agentName: "You's agent",
    userCandidates,
  };

  it("returns null when there is no session", () => {
    expect(deriveAgentActivity({ ...base, session: null })).toBeNull();
  });

  it("summarizes the latest assistant message's first line", () => {
    const activity = deriveAgentActivity({
      ...base,
      session: session({
        status: "completed",
        messages: [
          { role: "reasoning", text: "thinking..." },
          { role: "assistant", text: "Reorganized /notes.\nDetails below." },
        ],
      }),
    });
    expect(activity?.latestSummary).toBe("Reorganized /notes.");
    expect(activity?.addressedToUser).toBe(false);
  });

  it("flags a message that @mentions the user as addressed", () => {
    const activity = deriveAgentActivity({
      ...base,
      session: session({ messages: [{ role: "assistant", text: "@you which draft wins" }] }),
    });
    expect(activity?.addressedToUser).toBe(true);
  });

  it("flags a trailing question as addressed", () => {
    const activity = deriveAgentActivity({
      ...base,
      session: session({ messages: [{ role: "assistant", text: "Should I delete the old draft?" }] }),
    });
    expect(activity?.addressedToUser).toBe(true);
  });

  it("carries the pending permission title and id through", () => {
    const activity = deriveAgentActivity({
      ...base,
      session: session({
        status: "waiting-permission",
        pendingPermissions: [{ title: "Run: rm old.md", requestId: "perm-42" }],
      }),
    });
    expect(activity?.pendingPermissionTitle).toBe("Run: rm old.md");
    expect(activity?.pendingPermissionId).toBe("perm-42");
  });

  it("does not treat an @mention inside code as addressing the user", () => {
    const activity = deriveAgentActivity({
      ...base,
      session: session({
        status: "completed",
        messages: [{ role: "assistant", text: "Edit the config: `@you = owner`." }],
      }),
    });
    expect(activity?.addressedToUser).toBe(false);
  });
});

describe("a login the agent's harness asks for", () => {
  it("raises its own notice, with the harness's own instruction", () => {
    const raised = reduce(
      [],
      input({
        status: "running",
        loginRequired: true,
        loginNotice: "The login expired. Run `fixture-harness login`.",
      }),
    );

    // MUTATION (login-required does not outrank the run's own state): a
    // running session raises nothing, and the failure that follows says the
    // agent hit a problem instead of naming the sign-in it needs.
    expect(raised).toHaveLength(1);
    expect(raised[0]?.kind).toBe("login-required");
    expect(raised[0]?.title).toBe("Your agent needs you to sign in");
    expect(raised[0]?.body).toBe("The login expired. Run `fixture-harness login`.");
  });

  it("tells the user what to do when the harness said nothing", () => {
    const raised = reduce([], input({ status: "failed", loginRequired: true }));
    expect(raised[0]?.body)
      .toBe("Sign in with the provider CLI, then start the agent again.");
  });

  it("outranks the failure the expired login caused", () => {
    const raised = reduce(
      [],
      input({ status: "failed", lastError: "the agent stopped", loginRequired: true }),
    );
    expect(raised.map((notice) => notice.kind)).toEqual(["login-required"]);
  });

  it("carries the harness's latest notice out of the session snapshot", () => {
    const activity = deriveAgentActivity({
      workspaceId: "ws-a",
      workspaceName: "Personal",
      agentName: "You's agent",
      userCandidates,
      session: session({
        loginRequired: true,
        authNotices: ["rate-limits", "The login expired."],
      }),
    });
    expect(activity?.loginRequired).toBe(true);
    expect(activity?.loginNotice).toBe("The login expired.");
  });
});
