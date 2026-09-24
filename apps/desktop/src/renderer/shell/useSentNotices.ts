import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  NOTICE_READ_BATCH_MAX,
  type NoticeRef,
  type NoticeRow,
} from "../../ipc/bridgeContract";
import { bridge } from "../bridge";
import { useRequestSequence } from "../useRequestSequence";

// A sent notice this recent that arrives unread while dohc is open gets a
// toast. An older one waits in Notices.
export const SENT_NOTICE_TOAST_MS = 2 * 60_000;

export const sentNoticeKey = ({ store, noticeId }: NoticeRef): string => `${store}:${noticeId}`;
export const sentNoticeRef = ({ store, noticeId }: NoticeRef): NoticeRef => ({ store, noticeId });

// Marks shown before main has them: when each notice was read, and which
// notices were dismissed.
interface HeldMarks {
  read: ReadonlyMap<string, number>;
  dismissed: ReadonlySet<string>;
}
const NO_MARKS: HeldMarks = { read: new Map(), dismissed: new Set() };

// Drops the held marks a list already shows: a read row, or a row it no
// longer has.
function unconfirmed(held: HeldMarks, notices: readonly NoticeRow[]): HeldMarks {
  if (held.read.size === 0 && held.dismissed.size === 0) return held;
  const listed = new Map(notices.map((notice) => [sentNoticeKey(notice), notice]));
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
  // Newest first, as main lists them.
  notices: readonly NoticeRow[];
  // The newest notice that arrived while this window was open, until its
  // toast closes or it is read.
  toast: NoticeRow | null;
  hideToast: () => void;
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
  const [listed, setListed] = useState<readonly NoticeRow[]>([]);
  const [toastKey, setToastKey] = useState<string | null>(null);
  // Every notice id this window has listed. Null until the first list, which
  // only records what was already there.
  const known = useRef<Set<string> | null>(null);
  const [held, setHeld] = useState<HeldMarks>(NO_MARKS);
  const requests = useRequestSequence();

  const refresh = useCallback(async () => {
    const request = requests.next();
    const { notices } = await bridge().listNotices({});
    if (!requests.isCurrent(request)) return;
    const nowMs = Date.now();
    const seen = known.current;
    const arrived = seen === null
      ? undefined
      : notices.find((notice) =>
          !seen.has(notice.noticeId) &&
          notice.readAtMs === null &&
          nowMs - notice.createdAtMs < SENT_NOTICE_TOAST_MS);
    known.current ??= new Set();
    for (const notice of notices) known.current.add(notice.noticeId);
    setListed(notices);
    setHeld((current) => unconfirmed(current, notices));
    if (arrived) setToastKey(sentNoticeKey(arrived));
  }, [requests]);

  useEffect(() => {
    if (!enabled) return;
    const unsubscribe = bridge().onNoticesChanged(() => {
      void refresh().catch((error: unknown) => console.warn("[notices] list failed", error));
    });
    void refresh().catch((error: unknown) => console.warn("[notices] list failed", error));
    return unsubscribe;
  }, [enabled, refresh]);

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
        await refresh().catch(() => undefined);
      }
    },
    [refresh],
  );

  const read = useCallback(
    async (refs: readonly NoticeRef[]) => {
      if (refs.length === 0) return;
      const keys = refs.map(sentNoticeKey);
      const atMs = Date.now();
      setToastKey((current) => (current !== null && keys.includes(current) ? null : current));
      setHeld((current) => {
        const read = new Map(current.read);
        for (const key of keys) read.set(key, atMs);
        return { ...current, read };
      });
      await settle(keys, async () => {
        for (let start = 0; start < refs.length; start += NOTICE_READ_BATCH_MAX) {
          await bridge().readNotices({
            notices: refs.slice(start, start + NOTICE_READ_BATCH_MAX).map(sentNoticeRef),
          });
        }
      });
    },
    [settle],
  );

  const dismiss = useCallback(
    async (ref: NoticeRef) => {
      const key = sentNoticeKey(ref);
      setHeld((current) => ({ ...current, dismissed: new Set(current.dismissed).add(key) }));
      await settle([key], () => bridge().dismissNotice(sentNoticeRef(ref)));
    },
    [settle],
  );

  const notices = useMemo(
    () =>
      held.read.size === 0 && held.dismissed.size === 0
        ? listed
        : listed.flatMap((notice) => {
            const key = sentNoticeKey(notice);
            if (held.dismissed.has(key)) return [];
            const readAtMs = held.read.get(key);
            return readAtMs !== undefined && notice.readAtMs === null ? [{ ...notice, readAtMs }] : [notice];
          }),
    [listed, held],
  );
  // Read on another computer, or dismissed, ends the toast too.
  const toast = useMemo(
    () =>
      toastKey === null
        ? null
        : notices.find((notice) => notice.readAtMs === null && sentNoticeKey(notice) === toastKey) ?? null,
    [notices, toastKey],
  );
  const hideToast = useCallback(() => setToastKey(null), []);

  return useMemo(
    () => ({ notices, toast, hideToast, read, dismiss }),
    [notices, toast, hideToast, read, dismiss],
  );
}
