import { useEffect, useMemo, useRef, useState } from "react";
import type {
  EngineMomentRecord,
  ListEngineMomentsResponse,
  ListEngineMomentsResult,
} from "../../ipc/bridgeContract";
import { bridge } from "../bridge";

// The engine history page: newest-first moments, the keyset cursor for older
// pages, and the latest order of the answer on screen. A refresh replaces
// that order outright; the shell keeps its own floor for the open-file
// refresh key.
export type HistoryPage = {
  moments: EngineMomentRecord[];
  nextBeforeMomentOrder: number | null;
  latestMomentOrder: number;
  protectedTruncated: boolean;
};

// Why there is no page. A null timeline is not "no changes": it is also a
// first read still in flight, a read that failed, and a page dropped as stale
// and asked again. "No changes yet" is an assertion about the WORKSPACE, so
// only a read that answered may reach it. This says whether the newest read
// answered at all. A commit never resets it and a retraction never touches
// it: the page and the read state answer different questions.
export type HistoryReadState = "loading" | "failed" | "updating";

// A history read already spent one second in the daemon's capture-flush
// ladder before it can answer `updating`. Four renderer retries give that
// flush another 1.85 seconds of breathing room without leaving the panel in
// an unbounded spinner. After this ladder, the inline Try again remains.
const HISTORY_UPDATING_RETRY_DELAYS_MS = [100, 250, 500, 1_000] as const;
const HISTORY_PAGE_LIMIT = 200;

function waitForHistoryRetry(delayMs: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, delayMs));
}

type HeldRefresh = { token: number; activeVersionId: string; commit: () => void };

export type HistoryPageOwner = {
  // Reads the newest page under a token the shell issued. Rejects only when
  // the newest refresh failed, so the caller's catch raises the notice for a
  // failure the surface will show.
  refresh: (token: number) => Promise<void>;
  // A refresh that reads no page (no recorder, or a shared view) still
  // supersedes every older page read: their failures stay quiet and their
  // retry ladders stop.
  supersede: (token: number) => void;
  // Fetches the page before the displayed cursor. Rejects only for a failure
  // about the displayed timeline: no newer answer replaced what the page was
  // going to extend, and the user has not left the version it belongs to.
  loadMore: () => Promise<void>;
  // The authoritative statement of which version is active, from a version
  // operation or a lookup. Records it, then drops a committed page it
  // contradicts, and returns whether it dropped one: a caller with no refresh
  // already running owes one.
  observeVersion: (token: number, versionId: string) => boolean;
};

// The engine history page, judged by the same issue counter the shell's
// status lanes, opening, agent observation and version callbacks share. The
// shell issues refresh and version tokens; only pagination and cleanup take
// tokens here.
//
// Two orders decide everything:
//
// - Success is latest COMMITTED wins. A request in flight has answered
//   nothing, and one that fails never will, so superseding on ISSUE would
//   throw away the only answer there was. Only an answer older than what is
//   already displayed is dropped.
// - Failure, `updating` and the retry ladder are newest refresh ISSUED wins.
//   Only the newest refresh may call the surface unloadable: an older read
//   failing while a newer one is still in flight has settled nothing.
//
// `markReady` is captured when a refresh is issued, so a held refresh that
// commits later marks the selection generation it was issued under.
export function useHistoryPage(
  issue: { current: number },
  workspaceId: string,
  markReady: () => void,
): {
  page: HistoryPage | null;
  loadingMore: boolean;
  readState: HistoryReadState;
} & HistoryPageOwner {
  const [page, setPageState] = useState<HistoryPage | null>(null);
  const [loadingMore, setLoadingMoreState] = useState(false);
  const [readState, setReadState] = useState<HistoryReadState>("loading");
  // Mirrors of the two values a pagination reads synchronously: the cursor it
  // fetches from, and whether one is already out. Written only beside their
  // state, never inside an updater.
  const latestPage = useRef<HistoryPage | null>(null);
  const loadingMoreNow = useRef(false);
  // The newest history refresh ISSUED, including one that reads no page.
  const newestRefresh = useRef(0);
  // The request whose answer is displayed, and the version it describes, so
  // a pagination can prove its page extends the timeline it appends to.
  const committed = useRef(0);
  const committedVersionId = useRef<string | null>(null);
  // A pagination in flight, or 0. Its page is fetched from a cursor into the
  // displayed timeline, so an older refresh must not reset the timeline under
  // it. Cleared when the pagination settles, so a failed one stops holding
  // anything back.
  const pendingPage = useRef(0);
  // A refresh blocked by that pagination, held until it settles. Blocked is
  // not refuted: the pagination may fail, and then this is again the only
  // answer anyone has.
  const heldRefresh = useRef<HeldRefresh | null>(null);
  // The newest authoritative statement of which version is active, and the
  // request that carried it. The engine stamps every history answer with the
  // version it served, and a version operation names its own; both are the
  // same kind of fact, ordered by the same counter, so the newer one wins.
  const activeVersion = useRef<{ token: number; versionId: string | null }>({
    token: 0,
    versionId: null,
  });

  const owner = useMemo<HistoryPageOwner>(() => {
    const setPage = (next: HistoryPage | null) => {
      latestPage.current = next;
      setPageState(next);
    };
    const setLoadingMore = (next: boolean) => {
      loadingMoreNow.current = next;
      setLoadingMoreState(next);
    };
    const noteVersion = (token: number, versionId: string) => {
      if (token > activeVersion.current.token) {
        activeVersion.current = { token, versionId };
      }
    };
    // Staleness is one question: does this answer describe a version that a
    // newer statement has already replaced? An answer issued after that
    // statement can never be stale; the engine served it after the switch.
    const isStale = (token: number, versionId: string) =>
      versionId !== activeVersion.current.versionId &&
      token < activeVersion.current.token;
    // Retries an `updating` answer while this refresh is still the newest one
    // issued. A superseded refresh stops at the next check, before and after
    // each timer.
    const readNewestPage = async (token: number): Promise<ListEngineMomentsResponse> => {
      for (let attempt = 0; ; attempt += 1) {
        const response = await bridge().listEngineMoments({
          workspaceId,
          limit: HISTORY_PAGE_LIMIT,
        });
        if (!("status" in response)) return response;
        if (
          attempt === HISTORY_UPDATING_RETRY_DELAYS_MS.length ||
          token !== newestRefresh.current
        ) {
          return response;
        }
        await waitForHistoryRetry(HISTORY_UPDATING_RETRY_DELAYS_MS[attempt]);
        if (token !== newestRefresh.current) return response;
      }
    };

    const refresh = async (token: number): Promise<void> => {
      newestRefresh.current = token;
      // A read is on the way, so the surface does not know yet, which is a
      // different thing from knowing the last read failed. Saying so here is
      // also what makes the retry control show that it is working.
      setReadState("loading");
      let response: ListEngineMomentsResponse;
      try {
        response = await readNewestPage(token);
      } catch (error) {
        if (token !== newestRefresh.current) return;
        setReadState("failed");
        throw error;
      }
      if ("status" in response) {
        if (token === newestRefresh.current) setReadState("updating");
        return;
      }
      const answer: ListEngineMomentsResult = response;
      if (token <= committed.current) return;
      // An answer describing the version the user left is not late. It is
      // about somewhere else.
      if (isStale(token, answer.activeVersionId)) return;
      noteVersion(token, answer.activeVersionId);
      const commit = () => {
        committed.current = token;
        committedVersionId.current = answer.activeVersionId;
        // A refresh returns to the newest page; older pages reload on demand,
        // so any load-more it supersedes is over.
        setLoadingMore(false);
        setPage({
          moments: answer.moments,
          nextBeforeMomentOrder: answer.nextBeforeMomentOrder,
          latestMomentOrder: answer.latestMomentOrder,
          protectedTruncated: answer.protectedTruncated,
        });
        // Readiness belongs to the page that actually commits. A newer
        // activity refresh can beat the workspace-open refresh; marking only
        // the caller's promise left the profiler waiting even though the
        // current History page was already visible.
        markReady();
      };
      // Blocked by a newer pagination: hold this answer instead of throwing
      // it away, and let the pagination's settlement decide. The newest held
      // answer is kept, since an older one could never win afterwards.
      if (token < pendingPage.current) {
        const held = heldRefresh.current;
        if (!held || token > held.token) {
          heldRefresh.current = { token, activeVersionId: answer.activeVersionId, commit };
        }
        return;
      }
      commit();
    };

    const loadMore = async (): Promise<void> => {
      const cursor = latestPage.current?.nextBeforeMomentOrder;
      if (cursor === null || cursor === undefined || loadingMoreNow.current) return;
      const token = ++issue.current;
      // The version this page belongs to: the one the displayed timeline
      // shows, because that is the timeline the cursor points into.
      const pageVersionId = committedVersionId.current;
      pendingPage.current = token;
      setLoadingMore(true);
      try {
        const answer = await bridge().listEngineMoments({
          workspaceId,
          limit: HISTORY_PAGE_LIMIT,
          beforeMomentOrder: cursor,
        });
        // The displayed page remains the honest last answer while capture is
        // settling. Releasing the button below gives the user a bounded
        // retry; this expected progress result is never a global error.
        if ("status" in answer) return;
        // The committed-answer rule, applied to this page as well, plus the
        // one question an append owes: the page must describe the same
        // version as the timeline it extends.
        const stale = isStale(token, answer.activeVersionId);
        if (!stale) noteVersion(token, answer.activeVersionId);
        const current = latestPage.current;
        if (
          current &&
          token > committed.current &&
          !stale &&
          answer.activeVersionId === committedVersionId.current
        ) {
          committed.current = token;
          setPage({
            moments: [...current.moments, ...answer.moments],
            nextBeforeMomentOrder: answer.nextBeforeMomentOrder,
            latestMomentOrder: Math.max(current.latestMomentOrder, answer.latestMomentOrder),
            protectedTruncated: current.protectedTruncated || answer.protectedTruncated,
          });
        }
      } catch (error) {
        // A failure IS an answer for the version rule: it answers about
        // somewhere the user has left, and the switch does not move the
        // committed watermark, so the version is the only thing that can
        // tell it apart.
        const forALeftVersion = pageVersionId !== null && isStale(token, pageVersionId);
        if (token > committed.current && !forALeftVersion) throw error;
      } finally {
        // Settlement, not success, releases what this pagination held: the
        // pending slot, the refresh it blocked, and the button. A pagination
        // superseded by a newer one releases nothing; that newer one owns
        // all three now. The held answer is judged here, by the same two
        // questions every answer faces, so a version switch in between drops
        // it and a merge that never changed the version does not.
        if (pendingPage.current === token) {
          pendingPage.current = 0;
          const held = heldRefresh.current;
          heldRefresh.current = null;
          if (
            held &&
            held.token > committed.current &&
            !isStale(held.token, held.activeVersionId)
          ) {
            held.commit();
          }
          setLoadingMore(false);
        }
      }
    };

    // A statement can arrive after the page it contradicts is already on
    // screen, and the admission guard only stops a bad answer from being
    // admitted; nothing takes back a page admitted before the switch. A
    // committed page the newest statement contradicts describes a timeline
    // nobody is on, so drop it and let the surface say it does not know.
    // Returns false after cleanup by construction: the committed mark then
    // sits at the bumped counter, which no statement is newer than.
    const observeVersion = (token: number, versionId: string): boolean => {
      noteVersion(token, versionId);
      if (
        committedVersionId.current === null ||
        !isStale(committed.current, committedVersionId.current)
      ) {
        return false;
      }
      committedVersionId.current = null;
      setPage(null);
      return true;
    };

    return {
      refresh,
      supersede: (token) => {
        newestRefresh.current = token;
      },
      loadMore,
      observeVersion,
    };
  }, [issue, markReady, workspaceId]);

  // The owner is gone, so every read in flight is stale: the counter moves
  // past every issued token, both marks jump to it, and nothing held or
  // pending survives. Not a disposed flag: StrictMode replays this cleanup
  // and then the effects, and the next refresh simply issues above the bump.
  // The page itself stays, so a late statement retracts nothing.
  useEffect(
    () => () => {
      issue.current += 1;
      committed.current = issue.current;
      newestRefresh.current = issue.current;
      heldRefresh.current = null;
      pendingPage.current = 0;
    },
    [issue],
  );

  return { page, loadingMore, readState, ...owner };
}
