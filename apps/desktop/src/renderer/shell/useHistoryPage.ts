import { useEffect, useMemo, useRef, useState } from "react";
import type {
  EngineMomentRecord,
  HistoryPolicyUnreadableResult,
  ListHistoryResult,
  TimelineCursor,
  TimelineEntry,
} from "../../ipc/bridgeContract";
import { bridge } from "../bridge";

type ReadyHistory = Extract<ListHistoryResult, { status: "ready" }>;

// The History timeline: newest-first file moments, version markers and
// Collection changes, and the cursor main hands back for older pages. The
// source fields describe the whole chain the cursor carries, so the newest
// page's values stand. Which rows a page holds says nothing about whether a
// file changed: the shell reads that separately.
export type HistoryPage = {
  entries: TimelineEntry[];
  nextCursor: TimelineCursor | null;
  unavailableSources: ReadyHistory["unavailableSources"];
  omittedSources: number;
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
const HISTORY_PAGE_LIMIT = 50;

type MomentPosition = Pick<EngineMomentRecord, "recordedAtMs" | "momentOrder" | "protected">;

// Match the engine's newest-first merge: time, text before protected, then order.
function compareMomentPositions(left: MomentPosition, right: MomentPosition): number {
  return right.recordedAtMs - left.recordedAtMs ||
    Number(left.protected === true) - Number(right.protected === true) ||
    right.momentOrder - left.momentOrder;
}

function waitForHistoryRetry(delayMs: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, delayMs));
}

// The order of the engine's newest file moment, which tells the shell an
// open file may have changed, or null while History's rules hide it (the
// page read on the same refresh shows that). An `updating` answer is retried
// on the page's ladder while `current` holds. Capture that is still working
// is not a failure: a ladder that ends still updating answers null, and the
// activity capture sends when it settles reads again. It rejects only while
// `captureFailed` holds, so the caller can say so and offer Try again.
export async function readNewestMomentOrder(
  workspaceId: string,
  current: () => boolean,
  captureFailed: () => boolean,
): Promise<number | null> {
  for (let attempt = 0; ; attempt += 1) {
    const answer = await bridge().listEngineMoments({ workspaceId, limit: 1 });
    if (!("status" in answer)) return answer.latestMomentOrder;
    if (answer.status === "policy-unreadable" || !current()) return null;
    if (attempt === HISTORY_UPDATING_RETRY_DELAYS_MS.length) {
      if (!captureFailed()) return null;
      throw new Error("Recent changes are still being added to History.");
    }
    await waitForHistoryRetry(HISTORY_UPDATING_RETRY_DELAYS_MS[attempt]);
    if (!current()) return null;
  }
}

const fileMoments = (entries: readonly TimelineEntry[]): EngineMomentRecord[] =>
  entries.flatMap((entry) => (entry.kind === "file" ? [entry.moment] : []));

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

// The History page, judged by the same issue counter the shell's status
// lanes, opening, agent observation and version callbacks share. The shell
// issues refresh and version tokens; only pagination and cleanup take tokens
// here. An answer must also name this hook's workspace. A received share
// keeps only its file History.
//
// One order decides a refresh: the newest refresh ISSUED wins. Only its
// answer may commit, and only it may call the surface unloadable. An older
// answer is superseded whether the newer read is still in flight or has
// failed; a failed newer read keeps the rows on screen. A pagination extends
// the rows on screen, so it commits while nothing newer has committed.
//
// `markReady` is captured when a refresh is issued, so a held refresh that
// commits later marks the selection generation it was issued under.
export function useHistoryPage(
  issue: { current: number },
  workspaceId: string,
  markReady: () => void,
  receivedShare = false,
): {
  page: HistoryPage | null;
  loadingMore: boolean;
  readState: HistoryReadState;
  policyError: HistoryPolicyUnreadableResult | null;
} & HistoryPageOwner {
  const [page, setPageState] = useState<HistoryPage | null>(null);
  const [loadingMore, setLoadingMoreState] = useState(false);
  const [policyError, setPolicyError] = useState<HistoryPolicyUnreadableResult | null>(null);
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

  const { owner, hideForPolicy } = useMemo(() => {
    const setPage = (next: HistoryPage | null) => {
      latestPage.current = next;
      setPageState(next);
    };
    const hideForPolicy = (token: number, result: HistoryPolicyUnreadableResult) => {
      committed.current = token;
      committedVersionId.current = null;
      heldRefresh.current = null;
      setPage(null);
      setLoadingMore(false);
      setPolicyError(result);
      setReadState("failed");
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
    // Reads one page from the cursor main handed back, unchanged. Retries an
    // `updating` answer while the read that asked is still current; one that
    // is no longer current stops at the next check, before and after each
    // timer.
    const readPage = async (
      cursor: TimelineCursor | undefined,
      current: () => boolean,
    ): Promise<ListHistoryResult> => {
      for (let attempt = 0; ; attempt += 1) {
        const response = await bridge().listHistory({
          workspaceId,
          limit: HISTORY_PAGE_LIMIT,
          ...(cursor ? { cursor } : {}),
        });
        if (response.status !== "updating") return response;
        if (attempt === HISTORY_UPDATING_RETRY_DELAYS_MS.length || !current()) return response;
        await waitForHistoryRetry(HISTORY_UPDATING_RETRY_DELAYS_MS[attempt]);
        if (!current()) return response;
      }
    };
    // A received share has only its imported file History, so nothing else
    // reaches its timeline.
    const pageOf = (answer: ReadyHistory): HistoryPage => {
      const entries = receivedShare
        ? answer.entries.filter((entry) => entry.kind === "file")
        : answer.entries;
      return {
        entries,
        nextCursor: answer.nextCursor,
        unavailableSources: receivedShare ? [] : answer.unavailableSources,
        omittedSources: receivedShare ? 0 : answer.omittedSources,
      };
    };

    const refresh = async (token: number): Promise<void> => {
      newestRefresh.current = token;
      // A read is on the way, so the surface does not know yet, which is a
      // different thing from knowing the last read failed. Saying so here is
      // also what makes the retry control show that it is working. A History
      // still taking in changes says so until a page or a failure replaces it.
      setReadState((state) => (state === "updating" ? state : "loading"));
      let response: ListHistoryResult;
      try {
        response = await readPage(undefined, () => token === newestRefresh.current);
      } catch (error) {
        if (token !== newestRefresh.current) return;
        setReadState("failed");
        throw error;
      }
      if (response.status !== "ready") {
        if (token === newestRefresh.current) {
          if (response.status === "policy-unreadable") {
            if (token > committed.current) hideForPolicy(token, response);
          }
          else setReadState("updating");
        }
        return;
      }
      const answer = response;
      // A page for another workspace answers nothing here, and a refresh
      // someone has asked again has been superseded.
      if (answer.workspaceId !== workspaceId) return;
      if (token !== newestRefresh.current || token <= committed.current) return;
      // An answer describing the version the user left is not late. It is
      // about somewhere else.
      if (isStale(token, answer.versionId)) return;
      noteVersion(token, answer.versionId);
      const commit = () => {
        committed.current = token;
        committedVersionId.current = answer.versionId;
        setPolicyError(null);
        // The page replaces History still taking in changes, so a page
        // dropped later reads as not known yet.
        setReadState("loading");
        // A refresh returns to the newest page and starts a new source
        // chain; older pages reload on demand, so any load-more it
        // supersedes is over.
        setLoadingMore(false);
        setPage(pageOf(answer));
        // Readiness belongs to the page that actually commits. A newer
        // activity refresh can beat the workspace-open refresh; marking only
        // the caller's promise left the profiler waiting even though the
        // current History page was already visible.
        markReady();
      };
      // Blocked by a newer pagination: hold this answer instead of throwing
      // it away, and let the pagination's settlement decide.
      if (token < pendingPage.current) {
        heldRefresh.current = { token, activeVersionId: answer.versionId, commit };
        return;
      }
      commit();
    };

    const loadMore = async (): Promise<void> => {
      const cursor = latestPage.current?.nextCursor;
      if (cursor === null || cursor === undefined || loadingMoreNow.current) return;
      const token = ++issue.current;
      // The version this page belongs to: the one the displayed timeline
      // shows, because that is the timeline the cursor points into.
      const pageVersionId = committedVersionId.current;
      pendingPage.current = token;
      setLoadingMore(true);
      try {
        const answer = await readPage(
          cursor,
          () => pendingPage.current === token && token > committed.current,
        );
        // The displayed page remains the honest last answer while capture is
        // settling. Releasing the button below gives the user a bounded
        // retry; this expected progress result is never a global error.
        if (answer.status !== "ready") {
          if (answer.status === "policy-unreadable" && token > committed.current &&
            token >= newestRefresh.current && (pageVersionId === null || !isStale(token, pageVersionId))) {
            hideForPolicy(token, answer);
          }
          return;
        }
        if (answer.workspaceId !== workspaceId) return;
        // The committed-answer rule, applied to this page as well, plus the
        // one question an append owes: the page must describe the same
        // version as the timeline it extends.
        const stale = isStale(token, answer.versionId);
        if (!stale) noteVersion(token, answer.versionId);
        const current = latestPage.current;
        if (
          current &&
          token > committed.current &&
          !stale &&
          answer.versionId === committedVersionId.current
        ) {
          committed.current = token;
          const earlier = pageOf(answer);
          setPage({ ...earlier, entries: [...current.entries, ...earlier.entries] });
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
            held.token === newestRefresh.current &&
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

    const owner: HistoryPageOwner = {
      refresh,
      supersede: (token) => {
        newestRefresh.current = token;
      },
      loadMore,
      observeVersion,
    };
    return { owner, hideForPolicy };
  }, [issue, markReady, workspaceId, receivedShare]);

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

  const [namesRevision, setNamesRevision] = useState<{ workspaceId: string } | null>(null);
  const namedRevision = useRef<typeof namesRevision>(null);
  useEffect(() => bridge().onHistoryNamesChanged?.(event => {
    if (event.workspaceId === workspaceId) setNamesRevision({ workspaceId });
  }), [workspaceId]);
  useEffect(() => {
    const shown = latestPage.current;
    const shownMoments = shown ? fileMoments(shown.entries) : [];
    if (
      namesRevision?.workspaceId !== workspaceId || namedRevision.current === namesRevision ||
      loadingMore || shown === null || shownMoments.length === 0
    ) return;
    let liveRequest = true;
    const watermark = committed.current;
    const version = committedVersionId.current;
    const refreshAtStart = newestRefresh.current;
    const live = () => liveRequest && !loadingMoreNow.current && latestPage.current === shown && committed.current === watermark && committedVersionId.current === version;
    const oldest = shownMoments.reduce((last, moment) => compareMomentPositions(moment, last) > 0 ? moment : last);
    // Deletion can move a page cut past its original cursor. Bound the scan
    // by the file position the cursor reached, including progress through
    // filtered, marker-only or Collection-only pages. At equal times, markers
    // follow both moment streams.
    const reachedEnd = ({ engine, engineDone }: TimelineCursor) =>
      engineDone || engine === null ||
      (engine.text !== null && compareMomentPositions(engine.text, oldest) >= 0) ||
      (engine.protected !== null && compareMomentPositions({ ...engine.protected, protected: true }, oldest) >= 0) ||
      (engine.marker !== null && engine.marker.createdAtMs <= oldest.recordedAtMs);
    const scan = async () => {
      const named = new Map<string, EngineMomentRecord>();
      const remaining = new Set(shownMoments.map(moment => moment.id));
      const seenCursors = new Set<string>();
      let cursor: TimelineCursor | undefined;
      do {
        const response = await bridge().listHistory({ workspaceId, limit: HISTORY_PAGE_LIMIT, ...(cursor ? { cursor } : {}) });
        if (!live()) return false;
        // The rules turned unreadable under the shown rows. Hide them as a
        // refresh would, unless a newer refresh is already asking.
        if (response.status === "policy-unreadable") {
          if (newestRefresh.current === refreshAtStart) {
            namedRevision.current = namesRevision;
            hideForPolicy(++issue.current, response);
          }
          return true;
        }
        if (response.status !== "ready" || response.workspaceId !== workspaceId || response.versionId !== version) return false;
        for (const moment of fileMoments(response.entries)) {
          named.set(moment.id, moment);
          remaining.delete(moment.id);
        }
        if (remaining.size === 0 || response.nextCursor === null || reachedEnd(response.nextCursor)) break;
        const position = JSON.stringify(response.nextCursor);
        if (seenCursors.has(position)) return false;
        seenCursors.add(position);
        cursor = response.nextCursor;
      } while (live());
      if (!live()) return false;
      const next = { ...shown, entries: shown.entries.map((entry) => {
        const renamed = entry.kind === "file" ? named.get(entry.moment.id) : undefined;
        return renamed ? { kind: "file" as const, moment: renamed } : entry;
      }) };
      latestPage.current = next;
      // An append keeps earlier rows. Consume the event only once their
      // names reach the page; an interrupted scan runs on the new page.
      namedRevision.current = namesRevision;
      setPageState(next);
      return true;
    };
    void (async () => {
      for (let attempt = 0; attempt < 2 && live(); attempt++) {
        try { if (await scan()) return; } catch { /* Retry once while this page is still current. */ }
      }
    })();
    return () => { liveRequest = false; };
  }, [workspaceId, owner, hideForPolicy, issue, page, loadingMore, namesRevision]);

  return { page, loadingMore, readState, policyError, ...owner };
}
