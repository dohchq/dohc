import { describe, expect, it } from "vitest";
import {
  agentNotificationId,
  clearAgentNotificationsForThread,
  clearAgentNotificationsForWorkspace,
  deriveAgentActivity,
  dismissAgentNotification,
  reduceAgentNotifications,
  type AgentActivityInput,
  type AgentNotification,
  type AgentSessionLike,
} from "./agentNotifications";
import type { MentionCandidate } from "./mentions";

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

describe("clear helpers", () => {
  const sample: AgentNotification[] = [
    {
      id: agentNotificationId("ws-a", "run-1", "finished"),
      kind: "finished",
      workspaceId: "ws-a",
      workspaceName: "Personal",
      agentName: "You's agent",
      runId: "run-1",
      title: "Your agent finished",
      body: "done",
      createdAtMs: NOW,
    },
    {
      id: agentNotificationId("ws-b", "run-9", "asked"),
      kind: "asked",
      workspaceId: "ws-b",
      workspaceName: "Work",
      agentName: "You's agent",
      runId: "run-9",
      title: "Your agent has a question",
      body: "which one?",
      createdAtMs: NOW,
      threadId: "thread-7",
    },
  ];

  it("clears every notice for a workspace", () => {
    expect(clearAgentNotificationsForWorkspace(sample, "ws-a").map((n) => n.workspaceId)).toEqual([
      "ws-b",
    ]);
  });

  it("clears notices tied to a thread", () => {
    expect(clearAgentNotificationsForThread(sample, "thread-7").map((n) => n.runId)).toEqual([
      "run-1",
    ]);
  });
});
