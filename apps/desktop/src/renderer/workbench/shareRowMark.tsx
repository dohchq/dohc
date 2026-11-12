import { useLayoutEffect, useRef } from "react";

// While a reveal waits for its invitation, Chats hands each row that stands
// for a share a reporter. The row reports itself when it mounts, and again
// when a newer reveal brings a new reporter.
export type ShareRowReport = ((shareId: string, row: HTMLElement) => void) | null;

// Place inside the row's element. The row is the mark's parent.
export function ShareRowMark({ shareId, report }: { shareId: string | null | undefined; report: ShareRowReport }) {
  const mark = useRef<HTMLSpanElement>(null);
  useLayoutEffect(() => {
    const row = mark.current?.parentElement;
    if (report && shareId && row) report(shareId, row);
  }, [report, shareId]);
  return <span ref={mark} hidden />;
}
