import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  NOTICE_MARK_BATCH_MAX,
  type MarkNoticesPayload,
  type NoticeRef,
  type NoticeRow,
} from "../../ipc/bridgeContract";
import { bridge } from "../bridge";
import { useRequestSequence } from "../useRequestSequence";

// A sent notice this recent that arrives unread while dohc is open gets a
// toast. An older one waits in Notices.
export const SENT_NOTICE_TOAST_MS = 2 * 60_000;

export const sentNoticeRef = ({ store, noticeId }: NoticeRef): NoticeRef => ({ store, noticeId });

// A notice as the list of one account showed it. Another account's notice
// with the same id has another key, so a mark or a toast never carries over.
const noticeKey = (account: string | null, { store, noticeId }: NoticeRef): string =>
  JSON.stringify([account, store, noticeId]);

// One list from main: the signed-in account it shows, and its rows.
interface Listed {
  account: string | null;
  notices: readonly NoticeRow[];
}

// Marks shown before a list shows them: when each notice was read, and which
// notices were dismissed.
interface HeldMarks {
  read: ReadonlyMap<string, number>;
  dismissed: ReadonlySet<string>;
}
const NO_MARKS: HeldMarks = { read: new Map(), dismissed: new Set() };

// Drops the held marks a list settles: a row it shows read, a row it no
// longer has, and every mark made on another account's list.
function unconfirmed(held: HeldMarks, list: Listed): HeldMarks {
  if (held.read.size === 0 && held.dismissed.size === 0) return held;
  const listed = new Map(list.notices.map((notice) => [noticeKey(list.account, notice), notice]));
  return {
    read: new Map([...held.read].filter(([key]) => listed.get(key)?.readAtMs === null)),
    dismissed: new Set([...held.dismissed].filter((key) => listed.has(key))),
  };
}

function without(held: HeldMarks, keys: readonly string[]): HeldMarks {
  const read = new Map(held.read);
  const dismissed = new Set(held.dismissed);
  for (const key of keys) {
    read.delete(key);
    dismissed.delete(key);
  }
  return { read, dismissed };
}

export interface SentNotices {
  // The signed-in account the notices belong to.
  account: string | null;
  // Newest first, as main lists them.
  notices: readonly NoticeRow[];
  // The first list has answered, with rows or with an error.
  settled: boolean;
  // The latest list failed. A new object for each failure; null once a list
  // answers.
  listFailure: { error: unknown } | null;
  relist: () => void;
  // The newest notice that arrived while this window was open, until its
  // toast closes or it is read.
  toast: NoticeRow | null;
  hideToast: () => void;
  // Both mark notices from the list on screen, for the account it shows.
  read: (refs: readonly NoticeRef[]) => Promise<void>;
  dismiss: (ref: NoticeRef) => Promise<void>;
}

/**
 * Notices sent to the signed-in person, and this computer's own, from main's
 * cached lists. Nothing here waits on the network. It sits above the
 * workspace shell, so a workspace switch keeps the list and what already
 * arrived. Read and dismiss show at once and hold until a list shows them.
 */
export function useSentNotices(enabled: boolean): SentNotices {
  const [listed, setListed] = useState<Listed>({ account: null, notices: [] });
  const [settled, setSettled] = useState(false);
  const [listFailure, setListFailure] = useState<{ error: unknown } | null>(null);
  const [toastKey, setToastKey] = useState<string | null>(null);
  // Every notice this window has listed for one account. The first list for
  // an account only records what was already there.
  const known = useRef<{ account: string | null; keys: Set<string> } | null>(null);
  const [held, setHeld] = useState<HeldMarks>(NO_MARKS);
  const requests = useRequestSequence();

  const refresh = useCallback(async () => {
    const request = requests.next();
    let list: Listed;
    try {
      list = await bridge().listNotices({});
    } catch (error) {
      if (!requests.isCurrent(request)) return;
      setSettled(true);
      setListFailure({ error });
      return;
    }
    if (!requests.isCurrent(request)) return;
    const nowMs = Date.now();
    const seen = known.current?.account === list.account ? known.current.keys : null;
    const arrived = seen === null
      ? undefined
      : list.notices.find((notice) =>
          !seen.has(noticeKey(list.account, notice)) &&
          notice.readAtMs === null &&
          nowMs - notice.createdAtMs < SENT_NOTICE_TOAST_MS);
    const keys = seen ?? new Set<string>();
    for (const notice of list.notices) keys.add(noticeKey(list.account, notice));
    known.current = { account: list.account, keys };
    setListed(list);
    setSettled(true);
    setListFailure(null);
    setHeld((current) => unconfirmed(current, list));
    // A list for another account ends the toast, so coming back to the
    // first account does not bring it back.
    if (arrived) setToastKey(noticeKey(list.account, arrived));
    else if (seen === null) setToastKey(null);
  }, [requests]);
  const relist = useCallback(() => void refresh(), [refresh]);

  useEffect(() => {
    if (!enabled) return;
    const unsubscribe = bridge().onNoticesChanged(relist);
    relist();
    return unsubscribe;
  }, [enabled, relist]);

  // Lists again once main has the marks. A list that left before them
  // cannot undo them on screen; a mark main refused lets go at once.
  const settle = useCallback(
    async (keys: readonly string[], send: () => Promise<void>) => {
      try {
        await send();
      } catch (error) {
        setHeld((current) => without(current, keys));
        throw error;
      } finally {
        await refresh();
      }
    },
    [refresh],
  );

  // Marks go out for the account whose list is on screen. Main marks that
  // account's rows only while it is still signed in.
  const { account } = listed;
  const send = useCallback(
    async (mark: MarkNoticesPayload["mark"], refs: readonly NoticeRef[]) => {
      for (let start = 0; start < refs.length; start += NOTICE_MARK_BATCH_MAX) {
        await bridge().markNotices({
          account,
          mark,
          notices: refs.slice(start, start + NOTICE_MARK_BATCH_MAX).map(sentNoticeRef),
        });
      }
    },
    [account],
  );

  const read = useCallback(
    async (refs: readonly NoticeRef[]) => {
      if (refs.length === 0) return;
      const keys = refs.map((ref) => noticeKey(account, ref));
      const atMs = Date.now();
      setToastKey((current) => (current !== null && keys.includes(current) ? null : current));
      setHeld((current) => {
        const read = new Map(current.read);
        for (const key of keys) read.set(key, atMs);
        return { ...current, read };
      });
      await settle(keys, () => send("read", refs));
    },
    [account, send, settle],
  );

  const dismiss = useCallback(
    async (ref: NoticeRef) => {
      const key = noticeKey(account, ref);
      setHeld((current) => ({ ...current, dismissed: new Set(current.dismissed).add(key) }));
      await settle([key], () => send("dismissed", [ref]));
    },
    [account, send, settle],
  );

  const notices = useMemo(
    () =>
      held.read.size === 0 && held.dismissed.size === 0
        ? listed.notices
        : listed.notices.flatMap((notice) => {
            const key = noticeKey(listed.account, notice);
            if (held.dismissed.has(key)) return [];
            const readAtMs = held.read.get(key);
            return readAtMs !== undefined && notice.readAtMs === null ? [{ ...notice, readAtMs }] : [notice];
          }),
    [listed, held],
  );
  // Read on another computer, dismissed, or listed for another account ends
  // the toast too.
  const toast = useMemo(
    () =>
      toastKey === null
        ? null
        : notices.find((notice) => notice.readAtMs === null && noticeKey(listed.account, notice) === toastKey) ?? null,
    [listed.account, notices, toastKey],
  );
  const hideToast = useCallback(() => setToastKey(null), []);

  return useMemo(
    () => ({ account, notices, settled, listFailure, relist, toast, hideToast, read, dismiss }),
    [account, notices, settled, listFailure, relist, toast, hideToast, read, dismiss],
  );
}
