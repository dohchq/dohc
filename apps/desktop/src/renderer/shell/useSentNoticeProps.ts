import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { isRefusalNoticeKind } from "../../notices/refusalNoticeKind";
import { isAutomationControlsTarget, type AutomationControlsTarget } from "@dohc/workspace-contracts/relay";
import type { ChatDispatchStoppedRun, GetRelayReceivedShareResult, NoticeRow, WorkspaceSummary } from "../../ipc/bridgeContract";
import { bridge } from "../bridge";
import { opensForLiveEditing } from "../OpenSharedView";
import { useAutomationRetry } from "../collections/useAutomationRetry";
import { useRequestSequence } from "../useRequestSequence";
import { workspaceName } from "../Titlebar";
import { AUTOMATION_NOTICE_KINDS, type SentNotice } from "../workbench/NoticeCenter";
import type { ChatsInvitation, ChatsNav } from "../workbench/ChatsView";
import { inputCount } from "../ui/inputCount";
import type { ShellErrorKind } from "./useShellError";
import { sentNoticeFolder, sentNoticePlace, serverRunOfNotice } from "./sentNoticePlace";
import { sentNoticeRef, type SentNotices } from "./useSentNotices";

export const ACCESS_ENDED_NOTE =
  "Your access to this ended. Ask the person who shared it to share it again.";
export const NOT_HERE_NOTE =
  "This workspace isn't on this computer. Join it from Manage workspaces, then choose Open again.";
export const NO_OWN_WORKSPACE_NOTE =
  "This opens in Chats, in a workspace of your own. Create one from Manage workspaces, then choose Open again.";
// The lookup failures below go to the shell's errors with their cause and Try again.
export const SHARE_LOOKUP_FAILED_NOTE = "dohc could not open this share.";
export const AUTOMATION_NOT_HERE_NOTE = "dohc cannot find this automation's Collection on this computer.";
export const AUTOMATION_LOOKUP_FAILED_NOTE = "dohc could not open this automation.";
export const RUN_THREAD_NOT_HERE_NOTE = "dohc cannot find this run's thread.";
export const RUN_THREAD_LOOKUP_FAILED_NOTE = "dohc could not open this run's thread.";

/**
 * What a notice's Open asks the workspace it switches to to open once it is
 * ready: a file, an automation's switch in the ⚡ panel, or Chats at an
 * invitation. `sharedFile` is the automations.yaml a share holds there.
 */
export type OpenOnSwitch = string | { automationControls: string; sharedFile?: string } | { chatsInvitation: ChatsInvitation };

// The shell's error for a notice whose Open failed. A later Open of the
// notice replaces it or takes it back.
const openErrorIdentity = (notice: NoticeRow) => `sent-notice-open:${notice.store}:${notice.noticeId}`;

// Main dismisses a failed run's notice once its run is queued again.
const nothingToReread = () => undefined;

const AGENT_RUN_RETRY_FAILED = "dohc could not start your agent's run again.";
const NO_STOPPED_RUNS: ReadonlyMap<string, ChatDispatchStoppedRun> = new Map();

// The run an agent run's notice names, when this computer ran it in this
// workspace.
function agentRunOfNotice(notice: NoticeRow, workspaceId: string): { threadId: string; runId: string } | null {
  const target = notice.target;
  return notice.kind === "agent-run" && notice.postedHere && notice.workspaceId === workspaceId && target?.thread && target.run
    ? { threadId: target.thread, runId: target.run }
    : null;
}

// A share a notice named, for the Open a share surface, and the notice's
// file, to open once the share is added. `controls` opens an automation's
// switch instead when the share opens as its own workspace.
export interface NoticeShare {
  resolvedShare: { shareId: string; shareCode: string };
  liveEditing: boolean;
  path: string | null;
  controls?: { automationControls: string; sharedFile: string };
}

/**
 * The shell's side of Notices sent to this person: where each one opens from
 * this workspace, and the actions the notice center offers on them. Opening
 * marks a notice read, then goes to its file here, switches to the workspace
 * that holds it, or offers to add the share it came through.
 */
export function useSentNoticeProps(input: {
  sentNotices: SentNotices | undefined;
  workspaceId: string;
  workspaces: readonly WorkspaceSummary[];
  openFile: (path: string) => void;
  /**
   * Opens an automation's runs, at the run a notice names when this
   * computer ran it; resolves to a sentence for the row when it cannot.
   * Nothing opens once `signal` aborts.
   */
  openAutomation: (automationId: string, run: string | null, signal: AbortSignal) => Promise<string | null>;
  /**
   * Opens an automation's row in the ⚡ panel with its switch focused, to
   * turn it on again. Through a share, `sharedFile` names its automations.yaml,
   * which opens when the panel cannot show the automation. Nothing opens
   * once `signal` aborts.
   */
  openAutomationControls: (automationId: string, options: { sharedFile?: string; signal: AbortSignal }) => Promise<string | null>;
  /** Opens a conversation in a chat tab. */
  openChat: (nav: ChatsNav) => void;
  /** Shows the Chats panel at a Group invitation or message request, with its Join or Accept focused. */
  openChatsInvitation: (invitation: ChatsInvitation) => void;
  onSwitchWorkspace: (workspace: WorkspaceSummary, open?: OpenOnSwitch) => void;
  onOpenShare: (share: NoticeShare) => void;
  reportShellError: (fallback: string, error: unknown, retry?: (() => void) | null, kind?: ShellErrorKind, identity?: string) => void;
  clearShellError: (identity: string) => void;
}) {
  const {
    sentNotices, workspaceId, workspaces, openFile, openAutomation, openAutomationControls, openChat, openChatsInvitation, onSwitchWorkspace,
    onOpenShare, reportShellError, clearShellError,
  } = input;

  // A run's thread is in an agent's chat, whichever agent ran it, or in a
  // group's posts where a message named the agent. A failed lookup throws.
  const openRunThread = useCallback(
    async (threadId: string, signal: AbortSignal): Promise<string | null> => {
      let nav: ChatsNav | null = null;
      const { channels } = await bridge().listChatChannels({ workspaceId });
      const places = await Promise.all(channels.filter((channel) => channel.kind !== "dm").map(async (channel) =>
        ({ channel, threads: (await bridge().listChannelThreads({ workspaceId, channelId: channel.id })).threads })));
      for (const { channel, threads } of places) {
        const thread = threads.find((candidate) => candidate.id === threadId);
        if (thread) nav = { level: "thread", channel, thread };
      }
      if (signal.aborted) return null;
      if (!nav) return RUN_THREAD_NOT_HERE_NOTE;
      openChat(nav);
      return null;
    },
    [openChat, workspaceId],
  );

  // Each conversation's latest run, when dohc's restart or quit stopped it.
  // A notice offers Try again on that run while its conversation does.
  // When the read fails the notice just offers no Try again.
  const [stoppedRuns, setStoppedRuns] = useState(NO_STOPPED_RUNS);
  const [stoppedRunsRevision, setStoppedRunsRevision] = useState(0);
  // The runs the notices name, as a key, so a new list naming the same runs
  // reads nothing again.
  const agentRunsKey = useMemo(() => {
    const notices = [...(sentNotices?.notices ?? []), ...(sentNotices?.toast ? [sentNotices.toast] : [])];
    const runs = notices.flatMap((notice) => {
      const run = agentRunOfNotice(notice, workspaceId);
      return run ? [JSON.stringify([run.threadId, run.runId])] : [];
    });
    return `[${[...new Set(runs)].sort().join(",")}]`;
  }, [sentNotices?.notices, sentNotices?.toast, workspaceId]);
  const stoppedRunReads = useRequestSequence([workspaceId]);
  useEffect(() => {
    const request = stoppedRunReads.next();
    const threadIds = [...new Set((JSON.parse(agentRunsKey) as [string, string][]).map(([threadId]) => threadId))];
    if (threadIds.length === 0) {
      setStoppedRuns(NO_STOPPED_RUNS);
      return;
    }
    void Promise.all(threadIds.map(async (threadId) => {
      try {
        return [threadId, (await bridge().chatDispatchStateForThread({ workspaceId, threadId })).stoppedRun] as const;
      } catch {
        return [threadId, undefined] as const;
      }
    })).then((states) => {
      if (!stoppedRunReads.isCurrent(request)) return;
      setStoppedRuns(new Map(states.flatMap(([threadId, stopped]) => (stopped ? [[threadId, stopped] as const] : []))));
    });
  }, [agentRunsKey, stoppedRunReads, stoppedRunsRevision, workspaceId]);
  const retriesStoppedRun = useCallback((notice: NoticeRow) => {
    const run = agentRunOfNotice(notice, workspaceId);
    const stopped = run ? stoppedRuns.get(run.threadId) : undefined;
    return stopped !== undefined && stopped.runId === run?.runId && stopped.retryable;
  }, [stoppedRuns, workspaceId]);

  const describe = useCallback(
    (notice: NoticeRow): SentNotice => {
      const place = sentNoticePlace(notice, workspaces, workspaceId);
      // A share in this workspace's shared-with-me still comes from
      // someone else's workspace, so it names its folder.
      const here = place.kind === "workspace" &&
        place.workspace.workspaceId === workspaceId &&
        place.mount === null;
      return {
        notice,
        folder: here
          ? null
          : sentNoticeFolder(notice) ??
            (place.kind === "workspace" ? place.mount ?? workspaceName(place.workspace) : null),
        openable: place.kind !== "none",
        // Open takes a notice from another workspace there first.
        retryable: serverRunOfNotice(notice)?.workspaceId === workspaceId || retriesStoppedRun(notice),
      };
    },
    [retriesStoppedRun, workspaceId, workspaces],
  );
  const rows = useMemo(
    () => (sentNotices?.notices ?? []).filter(notice => !isRefusalNoticeKind(notice.kind) || notice.workspaceId !== workspaceId).map(describe),
    [describe, sentNotices?.notices, workspaceId],
  );
  const toast = useMemo(
    () => (sentNotices?.toast && (!isRefusalNoticeKind(sentNotices.toast.kind) || sentNotices.toast.workspaceId !== workspaceId) ? describe(sentNotices.toast) : null),
    [describe, sentNotices?.toast, workspaceId],
  );

  // A list main could not read is a failure with a way to ask again.
  const listFailure = sentNotices?.listFailure ?? null;
  const relist = sentNotices?.relist;
  useEffect(() => {
    if (!listFailure || !relist) return;
    reportShellError("dohc could not read notices sent to you.", listFailure.error, relist);
  }, [listFailure, relist, reportShellError]);

  const account = sentNotices?.account ?? null;
  const runNow = useCallback(
    async (notice: NoticeRow): Promise<string | null> =>
      (await bridge().runSkippedScheduleNow({ account, notice: sentNoticeRef(notice) })).note,
    [account],
  );
  const requestRetry = useCallback(
    (notice: NoticeRow, startOver: boolean) => {
      const run = serverRunOfNotice(notice);
      return run?.workspaceId === workspaceId
        ? bridge().retryCollectionAutomation({ ...run, startOver, onServer: true })
        : bridge().retryAutomationNotice({ account, notice: sentNoticeRef(notice), startOver });
    },
    [account, workspaceId],
  );

  const read = useCallback(
    (notices: readonly NoticeRow[]) => {
      if (!sentNotices || notices.length === 0) return;
      const refs = notices.map(sentNoticeRef);
      const attempt = () => {
        sentNotices.read(refs).catch((error: unknown) => {
          reportShellError("dohc could not mark notices read.", error, attempt);
        });
      };
      attempt();
    },
    [reportShellError, sentNotices],
  );

  // Where Open goes: the notice's file here, the workspace that holds it,
  // or the share it came through. An automation's notice here goes to the
  // ⚡ panel, on its switch with `controls`, else on its runs. A Group
  // invitation or message request goes to Chats in a workspace of this
  // person's own, where it waits with Join or Accept. A failed lookup goes to
  // the shell's errors, whose Try again goes where Open goes again; any
  // other outcome takes that error back. A lookup that answers once the
  // person has left this workspace, or after a later Open of the same notice
  // started, opens nothing, as a cancelled Open does.
  const workspace = useRequestSequence([workspaceId]);
  const latestOpens = useRef(new Map<string, number>());
  const go = useCallback(
    async function go(notice: NoticeRow, signal: AbortSignal, controls: boolean): Promise<string | null> {
      const identity = openErrorIdentity(notice);
      const epoch = workspace.current();
      const inputs = inputCount();
      const attempt = (latestOpens.current.get(identity) ?? 0) + 1;
      latestOpens.current.set(identity, attempt);
      const stale = () => signal.aborted || !workspace.isCurrent(epoch) || latestOpens.current.get(identity) !== attempt;
      let lookupFailed = false;
      const failed = (note: string, error: unknown): null => {
        lookupFailed = true;
        if (stale()) return null;
        const retry = () => {
          if (!workspace.isCurrent(epoch)) return;
          void go(notice, new AbortController().signal, controls).then((again) => {
            if (again !== null && workspace.isCurrent(epoch)) reportShellError(again, new Error(again), null, undefined, identity);
          });
        };
        reportShellError(note, error, retry, undefined, identity);
        return null;
      };
      const note = await open();
      if (!lookupFailed && !stale()) clearShellError(identity);
      return note;

      async function open(): Promise<string | null> {
        const noteOf = async (opening: Promise<string | null>, failedNote: string): Promise<string | null> => {
          let note: string | null;
          try {
            note = await opening;
          } catch (error) {
            return failed(failedNote, error);
          }
          return stale() ? null : note;
        };
        const place = sentNoticePlace(notice, workspaces, workspaceId);
        switch (place.kind) {
          case "none":
            return null;
          case "access-ended":
            return ACCESS_ENDED_NOTE;
          case "not-here":
            return NOT_HERE_NOTE;
          case "workspace": {
            const automation = AUTOMATION_NOTICE_KINDS.has(notice.kind) ? notice.target?.automation : undefined;
            // Through a share view or shared-with-me folder, the shared panel
            // finds the automation by its automations.yaml there.
            const shared = place.mount !== null || place.workspace.shareView !== undefined;
            const sharedFile = shared ? place.path ?? undefined : undefined;
            const toSwitch = controls && automation !== undefined && (!shared || sharedFile !== undefined) ? automation : null;
            if (place.workspace.workspaceId !== workspaceId) {
              onSwitchWorkspace(place.workspace, toSwitch !== null
                ? { automationControls: toSwitch, ...(sharedFile === undefined ? {} : { sharedFile }) }
                : place.path ?? undefined);
            } else if (notice.kind === "agent-run" && notice.target?.thread !== undefined) {
              return await noteOf(openRunThread(notice.target.thread, signal), RUN_THREAD_LOOKUP_FAILED_NOTE);
            } else if (toSwitch !== null) {
              return await noteOf(openAutomationControls(toSwitch, { sharedFile, signal }), AUTOMATION_LOOKUP_FAILED_NOTE);
            } else if (automation !== undefined && place.mount === null && !controls) {
              // Only the computer that ran a run holds it.
              return await noteOf(
                openAutomation(automation, notice.postedHere ? notice.target?.run ?? null : null, signal),
                AUTOMATION_LOOKUP_FAILED_NOTE,
              );
            } else if (place.path !== null) {
              openFile(place.path);
            }
            return null;
          }
          case "share": {
            let found: GetRelayReceivedShareResult;
            try {
              found = await bridge().getRelayReceivedShare({ shareId: place.shareId });
            } catch (error) {
              return failed(SHARE_LOOKUP_FAILED_NOTE, error);
            }
            if (stale()) return null;
            if (!found.found) return ACCESS_ENDED_NOTE;
            if ("chats" in found) {
              // A shared view holds no Chats, so Open goes to the workspace of
              // this person's own they opened last.
              if (workspaces.some((candidate) => candidate.workspaceId === workspaceId && candidate.shareView === undefined)) {
                openChatsInvitation({ shareId: place.shareId, inputs });
                return null;
              }
              const own = workspaces
                .filter((candidate) => candidate.shareView === undefined)
                .reduce<WorkspaceSummary | null>(
                  (latest, candidate) => (latest === null || (candidate.lastOpenedAt ?? 0) > (latest.lastOpenedAt ?? 0) ? candidate : latest),
                  null,
                );
              if (own === null) return NO_OWN_WORKSPACE_NOTE;
              onSwitchWorkspace(own, { chatsInvitation: { shareId: place.shareId, inputs } });
              return null;
            }
            const automation = controls && AUTOMATION_NOTICE_KINDS.has(notice.kind) ? notice.target?.automation : undefined;
            onOpenShare({
              resolvedShare: { shareId: found.share.shareId, shareCode: found.share.shareCode },
              liveEditing: opensForLiveEditing(found.share),
              path: place.path,
              ...(automation === undefined || place.path === null ? {} : { controls: { automationControls: automation, sharedFile: place.path } }),
            });
            return null;
          }
        }
      }
    },
    [
      clearShellError, onOpenShare, onSwitchWorkspace, openAutomation, openAutomationControls, openChatsInvitation, openFile, openRunThread,
      reportShellError, workspace, workspaceId, workspaces,
    ],
  );

  // Resolves to null once the notice opened, or to a sentence for its row.
  // Nothing opens once `signal` aborts: the panel closed, the notice was
  // dismissed, or another Open started. A switched-off automation's notice
  // opens its switch rather than its runs.
  const onOpenSentNotice = useCallback(
    (notice: NoticeRow, signal: AbortSignal): Promise<string | null> => {
      if (notice.readAtMs === null) read([notice]);
      return go(notice, signal, notice.target !== null && isAutomationControlsTarget(notice.target));
    },
    [go, read],
  );

  // Try again on a switched-off automation queues nothing and goes where
  // its Open goes, on the switch that turns it on.
  const onSwitchedOff = useCallback(
    (_controls: AutomationControlsTarget, notice: NoticeRow) => {
      const epoch = workspace.current();
      void go(notice, new AbortController().signal, true).then((note) => {
        if (note !== null && workspace.isCurrent(epoch)) reportShellError(note, new Error(note), null, undefined, openErrorIdentity(notice));
      });
    },
    [go, reportShellError, workspace],
  );
  const noticeRetry = useAutomationRetry({
    workspaceId,
    request: requestRetry,
    onError: reportShellError,
    onQueued: nothingToReread,
    onSwitchedOff,
  });

  const retryAutomationNotice = noticeRetry.retry;
  // Try again on a stopped agent run puts its request back in line, then
  // reads again whether the notice still offers it. Main queues nothing when
  // the request is already back in line, as after a second press or a Try
  // again in the conversation, so the read just takes the button away.
  const retrySentNotice = useCallback(
    (notice: NoticeRow) => {
      const run = agentRunOfNotice(notice, workspaceId);
      if (!run) {
        retryAutomationNotice(notice);
        return;
      }
      const epoch = workspace.current();
      const attempt = () => {
        void bridge().retryStoppedRun({ workspaceId, ...run }).then(
          () => {
            if (workspace.isCurrent(epoch)) setStoppedRunsRevision((revision) => revision + 1);
          },
          (error: unknown) => {
            if (workspace.isCurrent(epoch)) reportShellError(AGENT_RUN_RETRY_FAILED, error, attempt);
          },
        );
      };
      attempt();
    },
    [reportShellError, retryAutomationNotice, workspace, workspaceId],
  );

  const onDismissSentNotice = useCallback(
    (notice: NoticeRow) => {
      if (!sentNotices) return;
      const attempt = () => {
        sentNotices.dismiss(sentNoticeRef(notice)).catch((error: unknown) => {
          reportShellError("dohc could not dismiss this notice.", error, attempt);
        });
      };
      attempt();
    },
    [reportShellError, sentNotices],
  );

  const onReadSentNotice = useCallback((notice: NoticeRow) => read([notice]), [read]);

  const onReadAllSentNotices = useCallback(
    () => read((sentNotices?.notices ?? []).filter((notice) => notice.readAtMs === null)),
    [read, sentNotices?.notices],
  );

  return {
    sentNoticesAccount: sentNotices?.account ?? null,
    sentNotices: rows,
    sentNoticesLoading: sentNotices ? !sentNotices.settled : false,
    sentNoticeToast: toast,
    onHideSentNoticeToast: sentNotices?.hideToast,
    onOpenSentNotice,
    onDismissSentNotice,
    onReadSentNotice,
    onReadAllSentNotices,
    onRunSentNoticeNow: runNow,
    onRetrySentNotice: retrySentNotice,
    // The confirmation Try again asks for before a run starts over.
    retryDialog: noticeRetry.dialog,
  };
}
