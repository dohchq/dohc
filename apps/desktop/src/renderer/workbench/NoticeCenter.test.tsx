// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { NoticeRow, SyncStatusResult } from "../../ipc/bridgeContract";
import {
  NoticeCenter,
  WorkspaceErrorToast,
  type NoticeCopy,
  type SentNotice,
  type WorkspaceErrorNotice,
} from "./NoticeCenter";
import { deferred } from "../../testing/deferred";
import { initKeyboardNavigation, KEYBOARD_NAV_ATTRIBUTE } from "../keyboardNavigation";
import { Overlay } from "../Overlay";
function liveDeliveryIcon(surface: HTMLElement): string | undefined {
  const icon = surface.querySelector("svg");
  return [...(icon?.classList ?? [])]
    .find((name) => name.startsWith("lucide-"))
    ?.slice("lucide-".length);
}

it("shows the running step as working, with every step waiting, on the toast and the row", async () => {
  const held: WorkspaceErrorNotice = {
    id: "held",
    tone: "warning",
    title: "Access to team was widened outside dohc",
    message: "Until you choose…",
    atMs: 0,
    canRetry: false,
    seen: false,
    actionLabel: "Restore rule",
    additionalActionLabels: ["Allowing…"],
    actionBusy: 1,
    noDismiss: true,
  };
  const action = vi.fn();
  render(<WorkspaceErrorToast error={held} onAction={action} onHide={vi.fn()} />);
  const restore = screen.getByRole("button", { name: "Restore rule" });
  const allowing = screen.getByRole("button", { name: "Allowing…" });
  expect([restore.hasAttribute("disabled"), allowing.hasAttribute("disabled")]).toEqual([
    true,
    true,
  ]);
  expect([restore.getAttribute("aria-busy"), allowing.getAttribute("aria-busy")]).toEqual([
    null,
    "true",
  ]);
  cleanup();

  renderNotices({ workspaceErrors: [{ ...held, seen: true }], onWorkspaceErrorAction: action });
  await userEvent.click(screen.getByTestId("notice-center-toggle"));
  const row = screen.getByTestId("notice-held");
  expect(within(row).getByRole("button", { name: "Restore rule" }).hasAttribute("disabled")).toBe(
    true,
  );
  expect(within(row).getByRole("button", { name: "Allowing…" }).getAttribute("aria-busy")).toBe(
    "true",
  );
  expect(action).not.toHaveBeenCalled();
});

it("keeps Notices open on a step that runs in place, with focus on its row and then on its outcome", async () => {
  const held: WorkspaceErrorNotice = {
    id: "held",
    tone: "warning",
    title: "Access to team was widened outside dohc",
    message: "Until you choose…",
    atMs: 1,
    canRetry: false,
    seen: true,
    actionLabel: "Restore rule",
    additionalActionLabels: ["Allow new access"],
    actionStays: true,
    noDismiss: true,
    target: { to: "folder", path: "team" },
  };
  const action = vi.fn();
  const retry = vi.fn();
  const props = {
    onWorkspaceErrorAction: action,
    onRetryWorkspaceError: retry,
    onOpenTarget: async () => null,
  };
  const view = renderNotices({ ...props, workspaceErrors: [held] });
  await userEvent.click(screen.getByTestId("notice-center-toggle"));
  await userEvent.click(
    within(screen.getByTestId("notice-held")).getByRole("button", { name: "Allow new access" }),
  );
  expect(action).toHaveBeenCalledExactlyOnceWith("held", 1);
  const opens = (id: string) =>
    screen.getByTestId(`notice-${id}`).querySelector("[data-notice-open]");
  expect(document.activeElement).toBe(opens("held"));
  expect(within(screen.getByTestId("notice-held")).getByRole("status").textContent).toBe("");

  // Working: the row stays in Notices, its steps wait, and focus stays on it.
  const busy = { ...held, additionalActionLabels: ["Allowing…"], actionBusy: 1 };
  view.rerender(noticeElement({ ...props, workspaceErrors: [busy] }));
  expect(
    within(screen.getByTestId("notice-held"))
      .getByRole("button", { name: "Allowing…" })
      .getAttribute("aria-busy"),
  ).toBe("true");
  expect(
    within(screen.getByTestId("notice-held"))
      .getByRole("button", { name: "Restore rule" })
      .hasAttribute("disabled"),
  ).toBe(true);
  expect(document.activeElement).toBe(opens("held"));
  // A screen reader hears the step start, from a region that was there before it.
  expect(within(screen.getByTestId("notice-held")).getByRole("status").textContent).toBe(
    "Allowing…",
  );

  // Done: the outcome files while the row still waits, then the row goes.
  const done: WorkspaceErrorNotice = {
    id: "done",
    tone: "success",
    message: "Members can now edit team.",
    atMs: 2,
    canRetry: false,
    seen: true,
  };
  view.rerender(noticeElement({ ...props, workspaceErrors: [busy, done] }));
  expect(document.activeElement).toBe(opens("held"));
  view.rerender(noticeElement({ ...props, workspaceErrors: [done] }));
  expect(screen.getByTestId("notice-done").contains(document.activeElement)).toBe(true);

  // A failure puts the row back; focus stays on it beside the failure's row.
  view.rerender(noticeElement({ ...props, workspaceErrors: [held] }));
  await userEvent.click(
    within(screen.getByTestId("notice-held")).getByRole("button", { name: "Restore rule" }),
  );
  view.rerender(
    noticeElement({
      ...props,
      workspaceErrors: [{ ...held, actionLabel: "Restoring…", actionBusy: 0 }],
    }),
  );
  const failed: WorkspaceErrorNotice = {
    id: "failed",
    message: "dohc could not restore the access rule for team",
    atMs: 3,
    canRetry: true,
    retryStays: true,
    seen: true,
  };
  view.rerender(noticeElement({ ...props, workspaceErrors: [held, failed] }));
  expect(screen.getByTestId("notice-failed")).toBeTruthy();
  expect(document.activeElement).toBe(opens("held"));

  // Its Try again runs the choice again in place too: Notices stays open, and focus goes to the outcome.
  await userEvent.click(
    within(screen.getByTestId("notice-failed")).getByRole("button", { name: "Try again" }),
  );
  expect(retry).toHaveBeenCalledExactlyOnceWith("failed");
  view.rerender(
    noticeElement({
      ...props,
      workspaceErrors: [{ ...held, actionLabel: "Restoring…", actionBusy: 0 }],
    }),
  );
  expect(screen.getByTestId("notice-held")).toBeTruthy();
  view.rerender(noticeElement({ ...props, workspaceErrors: [{ ...done, id: "restored" }] }));
  expect(screen.getByTestId("notice-restored").contains(document.activeElement)).toBe(true);
});

it("keeps the keyboard mark when a step pressed with Enter moves focus to its row and outcome", async () => {
  const stop = initKeyboardNavigation();
  const marked = () => document.documentElement.hasAttribute(KEYBOARD_NAV_ATTRIBUTE);
  try {
    const held: WorkspaceErrorNotice = {
      id: "held",
      tone: "warning",
      title: "Access to team was widened outside dohc",
      message: "Until you choose…",
      atMs: 1,
      canRetry: false,
      seen: true,
      actionLabel: "Restore rule",
      additionalActionLabels: ["Allow new access"],
      actionStays: true,
      noDismiss: true,
      target: { to: "folder", path: "team" },
    };
    const props = { onWorkspaceErrorAction: vi.fn(), onOpenTarget: async () => null };
    const view = renderNotices({ ...props, workspaceErrors: [held] });
    await userEvent.click(screen.getByTestId("notice-center-toggle"));
    const allow = within(screen.getByTestId("notice-held")).getByRole("button", {
      name: "Allow new access",
    });
    allow.focus();
    fireEvent.keyDown(allow, { key: "Tab" });
    await userEvent.keyboard("{Enter}");
    expect(props.onWorkspaceErrorAction).toHaveBeenCalledOnce();
    expect(screen.getByTestId("notice-held").contains(document.activeElement)).toBe(true);
    expect(marked()).toBe(true);

    const done: WorkspaceErrorNotice = {
      id: "done",
      tone: "success",
      message: "Members can now edit team.",
      atMs: 2,
      canRetry: false,
      seen: true,
    };
    view.rerender(noticeElement({ ...props, workspaceErrors: [done] }));
    expect(screen.getByTestId("notice-done").contains(document.activeElement)).toBe(true);
    expect(marked()).toBe(true);
  } finally {
    stop();
    document.documentElement.removeAttribute(KEYBOARD_NAV_ATTRIBUTE);
  }
});

it("shows a row's lead above its rows and reads it out while Notices is open", async () => {
  const held: WorkspaceErrorNotice = {
    id: "held",
    tone: "warning",
    title: "The workspace's access rule was removed outside dohc",
    message: "Until you choose…",
    rows: ["Members: View → Edit"],
    atMs: 1,
    canRetry: false,
    seen: true,
    actionLabel: "Restore rule",
    additionalActionLabels: ["Remove rule"],
    actionStays: true,
    noDismiss: true,
  };
  const lead =
    "dohc didn't apply your choice because the members' level changed in Members settings.";
  const view = renderNotices({ workspaceErrors: [{ ...held, lead: "An earlier lead." }] });
  await userEvent.click(screen.getByTestId("notice-center-toggle"));
  const said = () => screen.getByTestId("notice-center-said");
  // A lead already there when Notices opens is not read out again.
  expect(said().getAttribute("role")).toBe("status");
  expect(said().textContent).toBe("");
  view.rerender(
    noticeElement({
      workspaceErrors: [{ ...held, additionalActionLabels: ["Removing…"], actionBusy: 1 }],
    }),
  );
  expect(said().textContent).toBe("");
  // The choice didn't run: the row comes back, filed again, with its reason.
  view.rerender(
    noticeElement({
      workspaceErrors: [{ ...held, id: "held-2", rows: ["Members: View, no change"], lead }],
    }),
  );
  const row = screen.getByTestId("notice-held-2");
  const shown = within(row).getByText(lead);
  expect(
    shown.compareDocumentPosition(within(row).getByText("Members: View, no change")) &
      Node.DOCUMENT_POSITION_FOLLOWING,
  ).toBeTruthy();
  expect(said().textContent).toBe(lead);
});

beforeEach(() => {
  vi.stubGlobal("dohcDesktop", {});
});

afterEach(() => {
  cleanup();
  vi.useRealTimers();
  vi.unstubAllGlobals();
  vi.clearAllMocks();
});

function noticeElement(props: Partial<Parameters<typeof NoticeCenter>[0]> = {}) {
  return (
    <NoticeCenter
      workspaceId={props.workspaceId ?? "ws-status-test"}
      {...(props.host ? { host: props.host } : {})}
      syncStatus={props.syncStatus ?? null}
      {...(props.failedSaves !== undefined ? { failedSaves: props.failedSaves } : {})}
      agentActive={props.agentActive ?? false}
      conflictSummaries={props.conflictSummaries ?? []}
      onOpenHistory={props.onOpenHistory ?? (() => {})}
      onOpenConflicts={props.onOpenConflicts ?? (() => {})}
      onRefreshShareView={props.onRefreshShareView ?? (() => {})}
      onOpenSettings={props.onOpenSettings ?? (() => {})}
      {...(props.onConnectServer ? { onConnectServer: props.onConnectServer } : {})}
      {...(props.onSignInAgain ? { onSignInAgain: props.onSignInAgain } : {})}
      {...(props.onConfirmSyncAccount ? { onConfirmSyncAccount: props.onConfirmSyncAccount } : {})}
      {...(props.onOpenSyncSettings ? { onOpenSyncSettings: props.onOpenSyncSettings } : {})}
      onRebuildEngineStore={props.onRebuildEngineStore ?? (() => {})}
      {...(props.workspaceErrors ? { workspaceErrors: props.workspaceErrors } : {})}
      {...(props.onRetryWorkspaceError
        ? { onRetryWorkspaceError: props.onRetryWorkspaceError }
        : {})}
      {...(props.onWorkspaceErrorAction
        ? { onWorkspaceErrorAction: props.onWorkspaceErrorAction }
        : {})}
      {...(props.onHideWorkspaceError ? { onHideWorkspaceError: props.onHideWorkspaceError } : {})}
      {...(props.onDismissWorkspaceError
        ? { onDismissWorkspaceError: props.onDismissWorkspaceError }
        : {})}
      {...(props.onRetryLiveDelivery ? { onRetryLiveDelivery: props.onRetryLiveDelivery } : {})}
      {...(props.onOpenLiveDocuments ? { onOpenLiveDocuments: props.onOpenLiveDocuments } : {})}
      {...(props.onOpenSharingDeclined
        ? { onOpenSharingDeclined: props.onOpenSharingDeclined }
        : {})}
      {...(props.automationHolds ? { automationHolds: props.automationHolds } : {})}
      {...(props.onAllowAutomationHold
        ? { onAllowAutomationHold: props.onAllowAutomationHold }
        : {})}
      {...(props.automationHoldsUnreadable
        ? { automationHoldsUnreadable: props.automationHoldsUnreadable }
        : {})}
      {...(props.onResetAutomationHolds
        ? { onResetAutomationHolds: props.onResetAutomationHolds }
        : {})}
      {...(props.onRevealAutomationHolds
        ? { onRevealAutomationHolds: props.onRevealAutomationHolds }
        : {})}
      {...(props.sentNotices ? { sentNotices: props.sentNotices } : {})}
      {...(props.sentNoticeToast ? { sentNoticeToast: props.sentNoticeToast } : {})}
      {...(props.onHideSentNoticeToast
        ? { onHideSentNoticeToast: props.onHideSentNoticeToast }
        : {})}
      {...(props.onOpenSentNotice ? { onOpenSentNotice: props.onOpenSentNotice } : {})}
      {...(props.sentNoticesLoading ? { sentNoticesLoading: props.sentNoticesLoading } : {})}
      {...(props.sentNoticesAccount !== undefined
        ? { sentNoticesAccount: props.sentNoticesAccount }
        : {})}
      {...(props.onDismissSentNotices ? { onDismissSentNotices: props.onDismissSentNotices } : {})}
      {...(props.onReadAllSentNotices ? { onReadAllSentNotices: props.onReadAllSentNotices } : {})}
      {...(props.onReadSentNotice ? { onReadSentNotice: props.onReadSentNotice } : {})}
      {...(props.automationStops ? { automationStops: props.automationStops } : {})}
      {...(props.onDismissAutomationStops
        ? { onDismissAutomationStops: props.onDismissAutomationStops }
        : {})}
      {...(props.onRunSentNoticeNow ? { onRunSentNoticeNow: props.onRunSentNoticeNow } : {})}
      {...(props.onRetrySentNotice ? { onRetrySentNotice: props.onRetrySentNotice } : {})}
      {...(props.onOpenTarget ? { onOpenTarget: props.onOpenTarget } : {})}
      {...(props.onReviewShareChanges ? { onReviewShareChanges: props.onReviewShareChanges } : {})}
      {...(props.crashReport ? { crashReport: props.crashReport } : {})}
      {...(props.onSendCrashReport ? { onSendCrashReport: props.onSendCrashReport } : {})}
      {...(props.keptTyping ? { keptTyping: props.keptTyping } : {})}
      {...(props.onDismissKeptTyping ? { onDismissKeptTyping: props.onDismissKeptTyping } : {})}
    />
  );
}

function renderNotices(props: Partial<Parameters<typeof NoticeCenter>[0]> = {}) {
  return render(noticeElement(props));
}

async function copyDetails(
  user: { click: (element: Element) => Promise<void> },
  message: HTMLElement,
) {
  await user.click(within(message).getByRole("button", { name: "Details" }));
  await user.click(within(message).getByRole("button", { name: "Copy details" }));
}

// A clean workspace whose only news is owner live delivery. A fresh object
// every call, so a rerender models a new status read rather than the same
// snapshot handed back.
function liveDeliveryStatus(
  ownerLiveDelivery: NonNullable<SyncStatusResult["ownerLiveDelivery"]>,
  ownerLiveDeliveryReason?: SyncStatusResult["ownerLiveDeliveryReason"],
): SyncStatusResult {
  return {
    state: "synced",
    pendingChangeCount: 0,
    lastSyncedAtMs: null,
    liveSessionsGeneration: 0,
    historyRecordingUnavailable: false,
    historyShareView: false,
    ownerLiveDelivery,
    ...(ownerLiveDeliveryReason ? { ownerLiveDeliveryReason } : {}),
  };
}

type SharingDeclined = NonNullable<SyncStatusResult["sharingDeclined"]>[number];

function declined(overrides: Partial<SharingDeclined> = {}): SharingDeclined {
  return {
    path: "notes/large.md",
    objectId: "object-1",
    versionId: "main",
    lineagePruned: false,
    headBlobSha256: "a".repeat(64),
    constraint: "MAX_YDOC_UPDATE_BYTES",
    limitBytes: 262_144,
    observedBytes: 280_001,
    ...overrides,
  };
}

function declinedStatus(...sharingDeclined: SharingDeclined[]): SyncStatusResult {
  return {
    state: "synced",
    pendingChangeCount: 0,
    lastSyncedAtMs: null,
    liveSessionsGeneration: 0,
    historyRecordingUnavailable: false,
    historyShareView: false,
    sharingDeclined,
  };
}

describe("automation notices", () => {
  it("asks once to allow a step that reaches more only because an editor left", async () => {
    const hold = {
      automationId: "collection:Trip#spend",
      automationName: "Spend",
      definitionHash: "0123456789abcdef",
      step: "0",
      seq: 4,
      collection: "Trip",
      collectionPath: "Projects/Trip",
      target: "Budget",
      action: "change" as const,
      stoppedFor: "bob@dohc.test",
      fileUnread: false,
      onServer: false,
    };
    const onAllowAutomationHold = vi.fn();
    renderNotices({ automationHolds: [hold, { ...hold, onServer: true }], onAllowAutomationHold });
    await userEvent.click(screen.getByTestId("notice-center-toggle"));
    const notice = await screen.findByTestId("notice-automation-hold-collection:Trip#spend-0");
    expect(notice.textContent).toContain('Automation "Spend" is waiting');
    expect(notice.textContent).toContain(
      "A step in Trip can now change Budget. It stopped before because bob@dohc.test could not. Allow it to run?",
    );
    await userEvent.click(within(notice).getByRole("button", { name: "Allow" }));
    expect(onAllowAutomationHold).toHaveBeenCalledWith(hold);
    await userEvent.click(screen.getByTestId("notice-center-toggle"));
    const onServer = await screen.findByTestId(
      "notice-automation-hold-server-collection:Trip#spend-0",
    );
    expect(onServer.textContent).toContain('Automation "Spend" is waiting on your server');
    await userEvent.click(within(onServer).getByRole("button", { name: "Allow" }));
    expect(onAllowAutomationHold).toHaveBeenLastCalledWith({ ...hold, onServer: true });
  });

  it("sends a held web request to its Collection's card instead of allowing it unseen", async () => {
    renderNotices({
      automationHolds: [
        {
          automationId: "collection:Stats#pull",
          automationName: "Pull stats",
          definitionHash: "0123456789abcdef",
          step: "0",
          seq: 1,
          collection: "Stats",
          collectionPath: "Stats",
          target: "us.posthog.com",
          action: "send-http" as const,
          stoppedFor: null,
          fileUnread: false,
          onServer: false,
        },
      ],
      onAllowAutomationHold: vi.fn(),
    });
    await userEvent.click(screen.getByTestId("notice-center-toggle"));
    const notice = await screen.findByTestId("notice-automation-hold-collection:Stats#pull-0");
    expect(notice.textContent).toContain(
      "A step in Stats can send a request to us.posthog.com. Open Stats's Automations to see what it sends and saves, and allow it there.",
    );
    expect(within(notice).queryByRole("button", { name: "Allow" })).toBeNull();
  });

  it("keeps Allow on a held web request waiting on the server, which the card cannot allow", async () => {
    const onAllowAutomationHold = vi.fn();
    const hold = {
      automationId: "collection:Stats#pull",
      automationName: "Pull stats",
      definitionHash: "0123456789abcdef",
      step: "0",
      seq: 1,
      collection: "Stats",
      collectionPath: "Stats",
      target: "us.posthog.com",
      action: "send-http" as const,
      stoppedFor: null,
      fileUnread: false,
      onServer: true,
    };
    renderNotices({ automationHolds: [hold], onAllowAutomationHold });
    await userEvent.click(screen.getByTestId("notice-center-toggle"));
    const notice = await screen.findByTestId(
      "notice-automation-hold-server-collection:Stats#pull-0",
    );
    expect(notice.textContent).toContain(
      "Open Stats's Automations to see what it sends and saves, then allow it here.",
    );
    await userEvent.click(within(notice).getByRole("button", { name: "Allow" }));
    expect(onAllowAutomationHold).toHaveBeenLastCalledWith(hold);
  });
});

describe("notice center", () => {
  it("offers typing kept from a workspace no longer listed until the person dismisses it", async () => {
    const user = userEvent.setup();
    const kept = {
      workspaceId: "joined-then-failed",
      recordId: "a".repeat(64),
      path: "notes/plan.md",
      text: "typed while joining",
    };
    const onDismissKeptTyping = vi.fn(async () => undefined);
    const view = renderNotices({ keptTyping: [kept], onDismissKeptTyping });
    expect(screen.getByTestId("notice-center-toggle").textContent).toContain("1");
    await user.click(screen.getByTestId("notice-center-toggle"));
    const row = screen.getByTestId("notice-kept-typing");
    expect(row.textContent).toContain("Typing kept from a workspace no longer in your list");
    expect(row.textContent).toContain("notes/plan.md");
    await user.click(within(row).getByRole("button", { name: "Copy typing" }));
    expect(await navigator.clipboard.readText()).toBe("typed while joining");
    expect(onDismissKeptTyping).not.toHaveBeenCalled();

    // Dismiss deletes the only copy, so it asks first.
    await user.click(within(row).getByTestId("recovery-dismiss"));
    expect(onDismissKeptTyping).not.toHaveBeenCalled();
    await user.click(within(row).getByTestId("recovery-dismiss-confirm"));
    expect(onDismissKeptTyping).toHaveBeenCalledWith(kept);

    view.rerender(noticeElement({ keptTyping: [], onDismissKeptTyping }));
    expect(screen.queryByTestId("notice-kept-typing")).toBeNull();
  });

  it("clears every row with its own × after one confirm, and keeps what cannot be dismissed", async () => {
    const user = userEvent.setup();
    const error = (id: string, noDismiss: boolean): WorkspaceErrorNotice => ({
      id,
      tone: "warning",
      title: `Failure ${id}`,
      message: "",
      atMs: 0,
      canRetry: false,
      seen: true,
      noDismiss,
    });
    const onDismissWorkspaceError = vi.fn();
    const onDismissSentNotices = vi.fn();
    const onDismissKeptTyping = vi.fn(async () => undefined);
    renderNotices({
      workspaceErrors: [error("gone", false), error("stays", true)],
      onDismissWorkspaceError,
      sentNotices: [sentRow("a"), sentRow("wake", { kind: "automation-wake" })],
      onDismissSentNotices,
      keptTyping: [
        { workspaceId: "left", recordId: "a".repeat(64), path: "plan.md", text: "typed" },
      ],
      onDismissKeptTyping,
    });
    await user.click(screen.getByTestId("notice-center-toggle"));

    await user.click(screen.getByTestId("notice-center-clear-all"));
    expect(screen.getByTestId("notice-center-clear-confirm").textContent).toBe("Clear 2 Notices");
    expect(document.activeElement).toBe(screen.getByTestId("notice-center-clear-cancel"));
    await user.keyboard("{Escape}");
    expect(screen.queryByTestId("notice-center-clear-confirm")).toBeNull();
    expect(document.activeElement).toBe(screen.getByTestId("notice-center-clear-all"));
    expect(screen.getByTestId("notice-center")).toBeTruthy();
    await user.click(screen.getByTestId("notice-center-clear-all"));
    await user.keyboard("{ArrowDown}{Escape}");
    expect(screen.queryByTestId("notice-center-clear-confirm")).toBeNull();
    expect(screen.getByTestId("notice-center")).toBeTruthy();

    await user.click(screen.getByTestId("notice-center-clear-all"));
    await user.click(screen.getByTestId("notice-center-clear-confirm"));
    expect(onDismissWorkspaceError).toHaveBeenCalledExactlyOnceWith("gone");
    expect(onDismissSentNotices).toHaveBeenCalledExactlyOnceWith([sentRow("a").notice]);
    expect(onDismissKeptTyping).not.toHaveBeenCalled();
    expect(screen.getByTestId("notice-center")).toBeTruthy();
  });

  it("keeps a dismissal across a rename and announces a refusal after a new save", async () => {
    const user = userEvent.setup();
    const { rerender } = renderNotices({ syncStatus: declinedStatus(declined()) });

    await user.click(screen.getByTestId("notice-center-toggle"));
    await user.click(screen.getByTestId("notice-sharing-declined-main:object-1-dismiss"));
    expect(screen.queryByTestId("notice-sharing-declined-main:object-1")).toBeNull();
    await user.click(screen.getByTestId("notice-center-toggle"));
    expect(screen.queryByTestId("sharing-declined-toast")).toBeNull();

    rerender(noticeElement({ syncStatus: declinedStatus(declined({ path: "notes/renamed.md" })) }));
    expect(screen.queryByTestId("sharing-declined-toast")).toBeNull();

    rerender(
      noticeElement({
        syncStatus: declinedStatus(
          declined({ path: "notes/renamed.md", headBlobSha256: "b".repeat(64) }),
        ),
      }),
    );
    expect(screen.getByTestId("sharing-declined-toast").textContent).toContain(
      "People you share renamed.md with",
    );
    await user.click(screen.getByTestId("notice-center-toggle"));
    expect(screen.getByTestId("notice-sharing-declined-main:object-1")).toBeTruthy();
  });

  // A store this build could not migrate is intact. The notice names the
  // failure and the next step, and offers no rebuild that would lose it.
  it("names a migration failure without offering the rebuild", async () => {
    const onRebuildEngineStore = vi.fn();
    renderNotices({
      syncStatus: {
        state: "synced",
        pendingChangeCount: 0,
        lastSyncedAtMs: null,
        liveSessionsGeneration: 0,
        historyCaptureFailed: true,
        engineStoreRefused: "migration-failed",
        historyRecordingUnavailable: false,
        historyShareView: false,
      },
      onRebuildEngineStore,
    });

    await userEvent.click(screen.getByTestId("notice-center-toggle"));
    const notice = screen.getByTestId("notice-engine-store-refused");
    expect(notice.textContent).toContain(
      "dohc could not update this workspace's data store to this version.",
    );
    expect(notice.textContent).toContain("Update dohc to continue. Your files are unchanged.");
    expect(within(notice).queryByRole("button", { name: "Rebuild" })).toBeNull();
    expect(onRebuildEngineStore).not.toHaveBeenCalled();
  });

  it("hands focus back to where F6 left the dialog when the focused toast goes away", async () => {
    const error = {
      id: "shell-error-1",
      message: "Could not refresh history. The engine did not answer.",
      copy: { report: "Error: Could not refresh history." },
      atMs: 1_000,
      canRetry: true,
      seen: false,
    };
    const props = (seen: boolean) => ({
      workspaceErrors: [{ ...error, seen }],
      onRetryWorkspaceError: vi.fn(),
      onHideWorkspaceError: vi.fn(),
    });
    const view = (seen: boolean) => (
      <>
        {noticeElement(props(seen))}
        <Overlay onClose={() => undefined}>
          <button type="button">Close</button>
          <button type="button">Restore file</button>
        </Overlay>
      </>
    );
    const { rerender } = render(view(false));
    const restore = screen.getByRole("button", { name: "Restore file" });
    restore.focus();
    fireEvent.keyDown(restore, { key: "F6" });
    expect(document.activeElement).toBe(
      within(screen.getByTestId("notice-toasts")).getByRole("button", { name: "Try again" }),
    );

    rerender(view(true));
    await waitFor(() => expect(document.activeElement).toBe(restore));
  });

  it("shows a workspace error as a toast and a notice with retry and copy", async () => {
    const onRetryWorkspaceError = vi.fn();
    const onDismissWorkspaceError = vi.fn();
    const user = userEvent.setup();
    const error = {
      id: "shell-error-1",
      message: "Could not refresh history. The engine did not answer.",
      copy: {
        report: "Error: Could not refresh history. The engine did not answer.\nWorkspace: personal",
      },
      atMs: 1_000,
      canRetry: true,
      canUndo: false,
      seen: false,
    };
    const barProps = (seen: boolean) => ({
      workspaceErrors: [{ ...error, seen }],
      onRetryWorkspaceError,
      onHideWorkspaceError: vi.fn(),
      onDismissWorkspaceError,
    });
    const { rerender } = renderNotices(barProps(false));

    const toast = screen.getByTestId("workspace-shell-error");
    expect(toast.textContent).toContain("Could not refresh history.");
    await copyDetails(user, toast);
    expect(await navigator.clipboard.readText()).toContain("Workspace: personal");
    expect(screen.getAllByRole("status").some((el) => el.textContent === "Copied")).toBe(true);
    await user.click(within(toast).getByRole("button", { name: "Dismiss workspace error" }));
    rerender(noticeElement(barProps(true)));
    expect(screen.queryByTestId("workspace-shell-error")).toBeNull();
    await waitFor(() =>
      expect(document.activeElement).toBe(screen.getByTestId("notice-center-toggle")),
    );

    await user.click(screen.getByTestId("notice-center-toggle"));
    const row = screen.getByTestId("notice-shell-error-1");
    expect(row.textContent).toContain("Could not refresh history.");
    await user.click(within(row).getByRole("button", { name: "Try again" }));
    expect(onRetryWorkspaceError).toHaveBeenCalledWith("shell-error-1");
    await user.click(screen.getByTestId("notice-center-toggle"));
    await user.click(
      within(screen.getByTestId("notice-shell-error-1")).getByRole("button", {
        name: "Dismiss notice",
      }),
    );
    expect(onDismissWorkspaceError).toHaveBeenCalledWith("shell-error-1");
  });

  it("leads a notice with its rows, right under the title, on the toast and the row", async () => {
    const user = userEvent.setup();
    const rows = ["Members: View → Edit", "sam@example.com: No access → Edit"];
    renderNotices({
      workspaceErrors: [
        {
          id: "shell-error-4",
          tone: "warning",
          title: "Access to team was widened outside dohc",
          message: "Until you choose, dohc does not record or share changes in team.",
          rows,
          atMs: 1_000,
          canRetry: false,
          seen: false,
        },
      ],
      onHideWorkspaceError: vi.fn(),
      onDismissWorkspaceError: vi.fn(),
    });
    // Title, then each row, then the message.
    const order = (testId: string) => {
      const listed = screen.getByTestId(`${testId}-rows`);
      expect([...listed.querySelectorAll("li")].map((item) => item.textContent)).toEqual(rows);
      const title = within(listed.parentElement!.parentElement!).getByText(
        "Access to team was widened outside dohc",
      );
      const message = within(listed.parentElement!).getByText(/^Until you choose/);
      expect(title.compareDocumentPosition(listed) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
      expect(
        listed.compareDocumentPosition(message) & Node.DOCUMENT_POSITION_FOLLOWING,
      ).toBeTruthy();
    };
    order("workspace-shell-toast");
    await user.click(screen.getByTestId("notice-center-toggle"));
    order("notice-shell-error-4");
  });

  // A retry with no reason raises its toast and row only once it has lasted 15 s.
  const outlastQuietRetry = () => act(() => vi.advanceTimersByTime(15_000));
  const serverUnreachable = {
    state: "sync-failed" as const,
    syncFailure: {
      cause: "server-unreachable" as const,
      detail: "dohc could not reach the server.",
      sinceMs: 1,
      attempts: 1,
    },
  };

  // A document the server stopped waits for its owner. The way to try again
  // is its Resume in the live documents list, from the toast and the row.
  // Nothing retries meanwhile, so both show the warning, not the retry mark.
  // A document the server cannot start also needs its owner to open it first,
  // and the notice says so, because a Resume alone would fail again.
  it.each([
    {
      reason: "session-host-refused" as const,
      title: "Live editing stopped",
      body: "The server stopped live editing for a document in this workspace. Your copy and its History are unchanged. Others cannot edit it live. Open Live documents to try again.",
    },
    {
      reason: "live-document-without-lineage" as const,
      title: "Live editing cannot start",
      body: "The server cannot start live editing for a document until you open it once in dohc. Notes larger than 256 KB do not open as live documents. Open Live documents to see which document it is, make it smaller or split it if needed, open it in dohc, and then resume live editing.",
    },
    // A diverged server copy offers no Resume: only the server's operator can continue it.
    {
      reason: "session-host-diverged" as const,
      title: "Live editing stopped",
      body: "The server stopped live editing because its copy of this workspace no longer matches the synced one. Live edits may not have reached your files, and others cannot edit them live. Contact the server's operator.",
    },
    // A document whose server copy is missing an owner edit resumes there too:
    // its Resume tries that edit again.
    {
      reason: "live-edit-unadmitted" as const,
      title: "Live editing stopped",
      body: "The server has not applied an edit to a document in this workspace. You can keep editing it in dohc, but others cannot edit it live. Open Live documents to resume live editing.",
    },
    // Its Resume in Live documents tries again now.
    {
      reason: "live-history-over-budget" as const,
      title: "Live editing cannot start",
      body: "A document in this workspace has too much edit history for the server to check, so live editing cannot start. Your edits are saved and keep syncing. Open Live documents to try again.",
    },
    // The server keeps trying it, so it keeps the retry mark.
    {
      reason: "live-start-failing" as const,
      title: "Live editing cannot start",
      body: "The server cannot start live editing for a document in this workspace and keeps trying. Open Live documents to see which one.",
      icon: "refresh-cw",
    },
    {
      reason: "note-format-off" as const,
      title: "Live editing stopped",
      body: "The server turned off the newer note format a document in this workspace uses, so live editing stopped. Your copy and its History are unchanged. Ask the server's operator to turn the format back on.",
    },
    {
      reason: "conflict-parent-withheld" as const,
      title: "Live editing cannot resume",
      body: "A conflict was resolved in a document, so live editing cannot resume for it. People with the link can still read the last shared version, but your edits may not reach them. Open Live documents to make a copy that can go live.",
    },
  ] as {
    reason: SyncStatusResult["ownerLiveDeliveryReason"];
    title: string;
    body: string;
    icon?: string;
  }[])(
    "sends a $reason document to the live documents list",
    async ({ reason, title, body, icon = "triangle-alert" }) => {
      const onOpenLiveDocuments = vi.fn();
      const onRetryLiveDelivery = vi.fn();
      const user = userEvent.setup();
      renderNotices({
        syncStatus: liveDeliveryStatus("retrying", reason),
        onOpenLiveDocuments,
        onRetryLiveDelivery,
      });

      const toast = screen.getByTestId("owner-live-delivery-toast");
      expect(toast.textContent).toContain(`${title}. ${body}`);
      expect(liveDeliveryIcon(toast)).toBe(icon);
      expect(within(toast).queryByRole("button", { name: "Try again" })).toBeNull();
      expect(within(toast).getByRole("button", { name: "Live documents" })).toBeTruthy();
      await user.click(screen.getByTestId("owner-live-delivery-toast-action"));
      expect(onOpenLiveDocuments).toHaveBeenCalledOnce();

      await user.click(screen.getByTestId("notice-center-toggle"));
      const notice = screen.getByTestId("notice-owner-live-delivery");
      expect(notice.textContent).toContain(title);
      expect(liveDeliveryIcon(notice)).toBe(icon);
      expect(notice.textContent).toContain(body);
      expect(within(notice).queryByRole("button", { name: "Try again" })).toBeNull();
      await copyDetails(user, notice);
      const copied = await navigator.clipboard.readText();
      expect(copied).toContain(`Live editing: ${title}`);
      expect(copied).toContain(`Reason: ${reason}`);
      await user.click(within(notice).getByRole("button", { name: "Live documents" }));
      expect(onOpenLiveDocuments).toHaveBeenCalledTimes(2);
      expect(onRetryLiveDelivery).not.toHaveBeenCalled();
    },
  );

  it("clears the live delivery toast and notice when delivery recovers", async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    const { rerender } = renderNotices({ syncStatus: liveDeliveryStatus("retrying") });
    outlastQuietRetry();
    expect(screen.getByTestId("owner-live-delivery-toast")).toBeTruthy();

    rerender(noticeElement({ syncStatus: liveDeliveryStatus("active") }));
    expect(screen.queryByTestId("owner-live-delivery-toast")).toBeNull();

    await userEvent.click(screen.getByTestId("notice-center-toggle"));
    expect(screen.queryByTestId("notice-owner-live-delivery")).toBeNull();
    expect(screen.getByTestId("notice-center").textContent).toContain("All clear");
  });

  it("announces an identical live delivery failure in another workspace", () => {
    vi.useFakeTimers();
    const { rerender } = renderNotices({ syncStatus: liveDeliveryStatus("retrying") });
    outlastQuietRetry();
    fireEvent.click(screen.getByRole("button", { name: "Dismiss live editing notice" }));
    expect(screen.queryByTestId("owner-live-delivery-toast")).toBeNull();

    // The other workspace's retry waits its own 15 s.
    rerender(
      noticeElement({
        workspaceId: "ws-status-other",
        syncStatus: liveDeliveryStatus("retrying"),
      }),
    );
    expect(screen.queryByTestId("owner-live-delivery-toast")).toBeNull();
    act(() => vi.advanceTimersByTime(14_999));
    expect(screen.queryByTestId("owner-live-delivery-toast")).toBeNull();
    fireEvent.click(screen.getByTestId("notice-center-toggle"));
    expect(screen.queryByTestId("notice-owner-live-delivery")).toBeNull();
    act(() => vi.advanceTimersByTime(1));
    expect(screen.getByTestId("notice-owner-live-delivery")).toBeTruthy();
    fireEvent.click(screen.getByTestId("notice-center-toggle"));
    expect(screen.getByTestId("owner-live-delivery-toast")).toBeTruthy();
  });

  // A server that can't be reached for live editing, or doesn't host it, can be a moment's answer, so it waits as a
  // retry with no reason does. Once it lasts, its row says why.
  it.each([
    ["server-unreachable", "dohc can't reach the server's live editing."],
    ["live-hosting-unavailable", "This server doesn't host live editing for this workspace"],
  ] as const)("names a lasting %s retry only after 15 s", (reason, words) => {
    vi.useFakeTimers();
    const { rerender } = renderNotices({ syncStatus: liveDeliveryStatus("retrying", reason) });
    act(() => vi.advanceTimersByTime(14_999));
    expect(screen.queryByTestId("owner-live-delivery-toast")).toBeNull();
    act(() => vi.advanceTimersByTime(1));
    expect(screen.getByTestId("owner-live-delivery-toast").textContent).toContain(words);
    rerender(noticeElement({ syncStatus: liveDeliveryStatus("active") }));
    expect(screen.queryByTestId("owner-live-delivery-toast")).toBeNull();
  });

  it("counts a lasting live retry from its start while its cause changes", () => {
    vi.useFakeTimers();
    const { rerender } = renderNotices({ syncStatus: liveDeliveryStatus("retrying") });
    act(() => vi.advanceTimersByTime(5_000));
    rerender(noticeElement({ syncStatus: liveDeliveryStatus("retrying", "server-unreachable") }));
    act(() => vi.advanceTimersByTime(5_000));
    rerender(
      noticeElement({ syncStatus: liveDeliveryStatus("retrying", "live-hosting-unavailable") }),
    );
    act(() => vi.advanceTimersByTime(4_999));
    expect(screen.queryByTestId("owner-live-delivery-toast")).toBeNull();
    act(() => vi.advanceTimersByTime(1));
    expect(screen.getByTestId("owner-live-delivery-toast").textContent).toContain(
      "This server doesn't host live editing for this workspace",
    );
  });

  // A healthy recovery tries again within about 10 s of the server coming
  // back, so it never toasts or adds a row.
  it("never announces a live retry that recovers within 15 s of the server coming back", () => {
    vi.useFakeTimers();
    const { rerender } = renderNotices({
      syncStatus: { ...liveDeliveryStatus("retrying"), ...serverUnreachable },
    });
    act(() => vi.advanceTimersByTime(20_000));
    rerender(noticeElement({ syncStatus: liveDeliveryStatus("retrying") }));
    act(() => vi.advanceTimersByTime(10_000));
    rerender(noticeElement({ syncStatus: liveDeliveryStatus("active") }));
    act(() => vi.advanceTimersByTime(60_000));
    expect(screen.queryByTestId("owner-live-delivery-toast")).toBeNull();
    fireEvent.click(screen.getByTestId("notice-center-toggle"));
    expect(screen.queryByTestId("notice-owner-live-delivery")).toBeNull();
  });

  // Enrollment refusals are one boolean on the status: however many shares it
  // covers, the user gets one announcement and one row, and the list is the
  // only surface that can name the files.
  describe("owner live refusals", () => {
    function refusalsStatus(hasOwnerLiveRefusals: boolean): SyncStatusResult {
      return {
        state: "synced",
        pendingChangeCount: 0,
        lastSyncedAtMs: null,
        liveSessionsGeneration: 0,
        historyRecordingUnavailable: false,
        historyShareView: false,
        hasOwnerLiveRefusals,
      };
    }

    // The toast and the row are the same fact, so they must paste the same
    // generic report — no share id, no engine code, no engine message.
    it("copies matching safe details from the toast and the row", async () => {
      const user = userEvent.setup();
      renderNotices({ syncStatus: refusalsStatus(true), onOpenLiveDocuments: vi.fn() });

      await copyDetails(user, screen.getByTestId("owner-live-refusals-toast"));
      const fromToast = await navigator.clipboard.readText();
      expect(fromToast).toContain("Live editing: Some shares could not start live editing");
      expect(fromToast).toContain("Workspace id: ws-status-test");

      await user.click(screen.getByTestId("notice-center-toggle"));
      await copyDetails(user, screen.getByTestId("notice-owner-live-refusals"));
      expect(await navigator.clipboard.readText()).toBe(fromToast);
    });
  });
});

function sentRow(
  noticeId: string,
  overrides: Partial<NoticeRow> = {},
  folder: string | null = null,
): SentNotice {
  return {
    notice: {
      store: "account",
      noticeId,
      kind: "mention",
      workspaceId: "ws-status-test",
      recipientShareId: null,
      senderKind: "person",
      senderLabel: "Ana",
      title: `Ana mentioned you in Trip ${noticeId}`,
      body: "Can you check day 2?",
      target: { path: "Trip/day-2.md" },
      createdAtMs: 1_700_000_000_000,
      readAtMs: null,
      postedHere: false,
      ...overrides,
    },
    folder,
    openable: true,
    retryable: false,
  };
}

// The relay settles a chat Notice whose chat the person can no longer
// reach: it keeps no target, and its title says the chat is gone.
it("shows a chat Notice whose chat is gone with the chat mark, not its sender's", async () => {
  renderNotices({
    sentNotices: [
      sentRow("gone", {
        kind: "chat-message",
        title: "dohc could not find this chat.",
        body: "",
        target: null,
      }),
      sentRow("live", { kind: "chat-message", target: { thread: "t1" } }),
    ],
    onOpenSentNotice: vi.fn(),
  });
  await userEvent.click(screen.getByTestId("notice-center-toggle"));
  const gone = screen.getByTestId("sent-notice-gone");
  expect(gone.querySelector("[data-sender-shape]")).toBeNull();
  expect(gone.querySelector("[data-notice-mark='chat']")).not.toBeNull();
  expect(
    screen.getByTestId("sent-notice-live").querySelector("[data-sender-shape='round']"),
  ).not.toBeNull();
});

describe("failed run notices", () => {
  const failed = (id: string, target: NoticeRow["target"], postedHere = true) =>
    sentRow(id, {
      kind: "automation-failed",
      senderKind: "automation",
      title: 'Automation "Stamp the finish date" failed',
      body: "ana@dohc.test cannot edit Budget. It ran on Ice's laptop.",
      target,
      postedHere,
    });
  const run = {
    automation: "collection:Tasks#stamp",
    path: "Tasks/automations.yaml",
    run: "atc_1",
  };

  it("offers Try again, copy, and Open automation where the run is, and no Try again for a run it cannot name or run", async () => {
    const onRetrySentNotice = vi.fn();
    renderNotices({
      sentNotices: [
        failed("f", run),
        failed("c", { automation: "collection:Tasks#nudge", path: "Tasks/automations.yaml" }),
        failed("o", run, false),
      ],
      onOpenSentNotice: vi.fn(async () => null),
      onRetrySentNotice,
    });
    await userEvent.click(screen.getByTestId("notice-center-toggle"));
    expect(screen.getByTestId("sent-notice-f").textContent).toContain("It ran on Ice's laptop.");
    expect(screen.queryByTestId("sent-notice-f-open"), "the row is its own Open").toBeNull();
    expect(screen.getByTestId("sent-notice-f-open-row")).toBeTruthy();
    expect(screen.queryByTestId("sent-notice-c-retry"), "a chain stop cannot run again").toBeNull();
    expect(
      screen.queryByTestId("sent-notice-o-retry"),
      "another computer holds the run",
    ).toBeNull();
    expect(screen.getByTestId("sent-notice-o").textContent).toContain("It ran on Ice's laptop.");
    await copyDetails(userEvent, screen.getByTestId("sent-notice-f"));
    expect(await navigator.clipboard.readText()).toContain("Run: atc_1");
    await userEvent.click(screen.getByTestId("sent-notice-f-retry"));
    expect(onRetrySentNotice).toHaveBeenCalledWith(expect.objectContaining({ noticeId: "f" }));
  });
});

describe("notices sent to you", () => {
  it("keeps a held row read when its store mark arrives and after remount", () => {
    const held = {
      id: "held-save",
      tone: "warning" as const,
      title: "Held a change to note.md",
      message: "Saving it would also change parts dohc can't show.",
      copy: { report: "note.md" },
      atMs: 1,
      canRetry: false,
      actionLabel: "Open note",
      seen: false,
    };
    const props = (seen: boolean, read = seen) => ({
      workspaceErrors: [{ ...held, seen, read }],
      onWorkspaceErrorAction: vi.fn(),
    });
    const first = renderNotices(props(false));
    fireEvent.click(screen.getByTestId("notice-center-toggle"));
    expect(screen.getByTestId("notice-held-save-unread")).toBeTruthy();
    expect(screen.getByTestId("notice-center-count").textContent).toBe("1");
    // Closing the toast keeps the row unread.
    first.rerender(noticeElement(props(true, false)));
    expect(screen.getByTestId("notice-held-save-unread")).toBeTruthy();
    expect(screen.getByTestId("notice-center-count").textContent).toBe("1");
    first.rerender(noticeElement(props(true)));
    const expectRead = () => {
      expect(screen.getByTestId("notice-held-save")).toBeTruthy();
      expect(screen.queryByTestId("notice-held-save-unread")).toBeNull();
      expect(screen.queryByTestId("notice-center-count")).toBeNull();
      expect(screen.queryByRole("button", { name: "Mark all read" })).toBeNull();
      expect(screen.getByTestId("notice-center-toggle").getAttribute("aria-label")).toBe("Notices");
    };
    expectRead();
    first.unmount();
    renderNotices(props(true));
    expect(screen.queryByTestId("workspace-shell-notice")).toBeNull();
    fireEvent.click(screen.getByTestId("notice-center-toggle"));
    expectRead();
  });

  describe("an Open that has to wait", () => {
    function waitingOpen() {
      const answers: Array<ReturnType<typeof deferred<string | null>>> = [];
      const signals: AbortSignal[] = [];
      const onOpenSentNotice = vi.fn((_notice: NoticeRow, signal: AbortSignal) => {
        const answer = deferred<string | null>();
        answers.push(answer);
        signals.push(signal);
        return answer.promise;
      });
      return { answers, signals, onOpenSentNotice };
    }

    it("says it is opening and ignores a second click", async () => {
      const { answers, onOpenSentNotice } = waitingOpen();
      renderNotices({
        sentNotices: [sentRow("a")],
        onOpenSentNotice,
        onDismissSentNotices: vi.fn(),
      });
      await userEvent.click(screen.getByTestId("notice-center-toggle"));
      await userEvent.click(screen.getByTestId("sent-notice-a-open-row"));
      const open = screen.getByTestId("sent-notice-a-open-row");
      // Focus stays on the row, so the word must not hide for its ×.
      expect(screen.getByTestId("sent-notice-a-opening").textContent).toBe("Opening…");
      expect(screen.getByTestId("sent-notice-a-opening").className).not.toContain("invisible");
      expect(open.getAttribute("aria-busy")).toBe("true");
      await userEvent.click(open);
      expect(onOpenSentNotice).toHaveBeenCalledOnce();

      await act(async () => answers[0]?.resolve("dohc could not open this share."));
      expect(screen.queryByTestId("sent-notice-a-opening")).toBeNull();
      expect(screen.getByTestId("sent-notice-a-open").textContent).toBe("Open");
      expect(within(screen.getByTestId("sent-notice-a")).getByRole("status").textContent).toBe(
        "dohc could not open this share.",
      );
      expect(screen.getByTestId("notice-center")).toBeTruthy();
    });

    it("stops when another account signs in, and leaves that account's notice free to open", async () => {
      const { answers, signals, onOpenSentNotice } = waitingOpen();
      const { rerender } = renderNotices({
        sentNotices: [sentRow("a")],
        onOpenSentNotice,
        sentNoticesAccount: "ana",
      });
      await userEvent.click(screen.getByTestId("notice-center-toggle"));
      await userEvent.click(screen.getByTestId("sent-notice-a-open-row"));
      expect(screen.getByTestId("sent-notice-a-opening").textContent).toBe("Opening…");

      // Ben's list has a notice with the same id.
      rerender(
        noticeElement({
          sentNotices: [sentRow("a", { title: "Ben's notice" })],
          onOpenSentNotice,
          sentNoticesAccount: "ben",
        }),
      );
      expect(signals[0]?.aborted).toBe(true);
      expect(screen.queryByTestId("sent-notice-a-opening")).toBeNull();
      await userEvent.click(screen.getByTestId("sent-notice-a-open-row"));
      expect(onOpenSentNotice).toHaveBeenCalledTimes(2);
      expect(signals[1]?.aborted).toBe(false);

      await act(async () => answers[0]?.resolve("Your access to this ended."));
      expect(within(screen.getByTestId("sent-notice-a")).queryByRole("status")).toBeNull();
    });
  });

  it("moves between rows with the arrows, opens with Enter, dismisses with Delete, and closes with Escape", async () => {
    const onOpenSentNotice = vi.fn(async () => null);
    const onDismissSentNotices = vi.fn();
    const onOpenHistory = vi.fn();
    const onOpenTarget = vi.fn(async () => null);
    renderNotices({
      agentActive: true,
      onOpenHistory,
      onOpenTarget,
      sentNotices: [sentRow("a"), sentRow("b")],
      onOpenSentNotice,
      onDismissSentNotices,
    });
    await userEvent.click(screen.getByTestId("notice-center-toggle"));
    expect(document.activeElement).toBe(screen.getByTestId("notice-center"));

    await userEvent.keyboard("{ArrowDown}");
    expect(document.activeElement).toBe(screen.getByTestId("notice-agent-active-open-row"));
    await userEvent.keyboard("{ArrowDown}");
    expect(document.activeElement).toBe(screen.getByTestId("sent-notice-a-open-row"));
    await userEvent.keyboard("{ArrowDown}{ArrowDown}");
    expect(document.activeElement).toBe(screen.getByTestId("sent-notice-b-open-row"));
    await userEvent.keyboard("{ArrowUp}");
    expect(document.activeElement).toBe(screen.getByTestId("sent-notice-a-open-row"));

    await userEvent.keyboard("{Delete}");
    expect(onDismissSentNotices).toHaveBeenCalledWith([sentRow("a").notice]);
    expect(document.activeElement).toBe(screen.getByTestId("sent-notice-b-open-row"));

    await userEvent.keyboard("{Enter}");
    expect(onOpenSentNotice).toHaveBeenCalledWith(sentRow("b").notice, expect.any(AbortSignal));
    await waitFor(() => expect(screen.queryByTestId("notice-center")).toBeNull());

    await userEvent.click(screen.getByTestId("notice-center-toggle"));
    await userEvent.keyboard("{ArrowDown}{Enter}");
    expect(onOpenTarget).toHaveBeenCalledExactlyOnceWith(
      { to: "history" },
      expect.any(AbortSignal),
    );
    expect(onOpenHistory).not.toHaveBeenCalled();

    await userEvent.click(screen.getByTestId("notice-center-toggle"));
    await userEvent.keyboard("{ArrowDown}{Escape}");
    expect(screen.queryByTestId("notice-center")).toBeNull();
    expect(document.activeElement).toBe(screen.getByTestId("notice-center-toggle"));
  });
});

describe("Details", () => {
  const MESSAGE = "dohc could not save Trip/day-2.md.";
  const REPORT = `Error: ${MESSAGE}\nFile: Trip/day-2.md\nTime: 2026-11-07T09:00:00.000Z`;
  const failure = (
    copy: NoticeCopy | undefined,
    extra: Partial<WorkspaceErrorNotice> = {},
  ): WorkspaceErrorNotice => ({
    id: "e1",
    message: MESSAGE,
    ...(copy ? { copy } : {}),
    atMs: 1,
    canRetry: true,
    seen: false,
    ...extra,
  });

  it("opens the report under the message, keeps focus on Details, and the next Tab reaches its Copy", async () => {
    const user = userEvent.setup();
    render(
      <WorkspaceErrorToast
        error={failure({ report: REPORT })}
        onRetry={vi.fn()}
        onHide={vi.fn()}
      />,
    );
    const details = screen.getByRole("button", { name: "Details" });
    expect(details.getAttribute("aria-expanded")).toBe("false");
    expect(document.getElementById(details.getAttribute("aria-controls") ?? "")).toBeNull();
    expect(details.parentElement?.lastElementChild).toBe(details);

    await user.click(details);
    expect(document.activeElement).toBe(details);
    expect(details.getAttribute("aria-expanded")).toBe("true");
    expect(details.textContent).toBe("Hide details");
    const block = document.getElementById(details.getAttribute("aria-controls") ?? "")!;
    expect(block.querySelector("pre")?.textContent).toBe(REPORT);

    await user.tab();
    const copy = within(block).getByRole("button", { name: "Copy details" });
    expect(document.activeElement).toBe(copy);
    await navigator.clipboard.writeText("");
    await user.click(copy);
    expect(await navigator.clipboard.readText()).toBe(REPORT);

    await user.click(details);
    expect(details.getAttribute("aria-expanded")).toBe("false");
    expect(details.textContent).toBe("Details");
    expect(document.getElementById(details.getAttribute("aria-controls") ?? "")).toBeNull();
  });
});
