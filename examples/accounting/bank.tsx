import { useCallback, useEffect, useMemo, useRef, useState, type KeyboardEvent } from "react";
import { ArrowDownLeft, ArrowLeft, ArrowUpRight, Check, ChevronLeft, ChevronRight, CircleCheck, Copy, FileText, Inbox, Landmark, Link, Plus, RotateCcw, Trash2, TriangleAlert, Upload } from "dohc/icons";
import { Modal } from "dohc/ui";
import { Failure, Loading, Tablist, cx, longDate, problem, shortDate, useBooks } from "./shared";
import { AccountPicker, Empty, Kbd, Topbar, useAction, useBooksContext, useKeys, useMutate, useToast } from "./parts";
import { RULE_OUT, applyChoice, decide, enterLabel, type BankRow, type Candidate, type Choice, type Decision, type Pick, type Queue, type Split } from "./matching";
import { centsInput, money, parseAmount } from "./amounts";
import { ImportSheet } from "./importer";
import { ReconcileSheet, type Reconciled } from "./reconcile";

type Found = Omit<Candidate, "sure">;
interface BankPage {
  status: Queue;
  offset: number;
  rows: BankRow[];
  counts: Record<string, number>;
  matched: number;
  reconciled: Reconciled[];
  nextOffset: number | null;
}
interface Posted {
  posted: number;
  entries: string[];
  numbers: number[];
}

const PAGE = 100;
const focusCandidates = () => document.querySelector<HTMLInputElement>(".b-bank-insp .b-match-pick input")?.focus();

export function BankWorkbench() {
  const { route, go, accounts } = useBooksContext();
  const toast = useToast();
  const mutate = useMutate();
  const { run, pending: acting } = useAction();
  const [queue, setQueue] = useState<Queue>((["new", "matched", "duplicate", "posted", "ignored"] as const).find((id) => id === route.show) ?? "new");
  const [starts, setStarts] = useState([0]);
  const offset = starts[starts.length - 1]!;
  const [cursorId, setCursorId] = useState<string | null>(null);
  const [opened, setOpened] = useState(false);
  const [choices, setChoices] = useState<Record<string, Choice>>({});
  const [queued, setQueued] = useState<Pick[]>([]);
  const [settled, setSettled] = useState<Map<string, Queue>>(new Map());
  const [importing, setImporting] = useState(false);
  const [reconciling, setReconciling] = useState<Reconciled | true | null>(null);
  const [finding, setFinding] = useState<BankRow | null>(null);
  const flushing = useRef(false);
  const queuedRef = useRef<Pick[]>([]);
  queuedRef.current = queued;
  const list = useBooks<BankPage>("listBankRows", { status: queue, limit: PAGE, offset }, { keep: true });
  const source = queue === "matched" ? "new" : queue;
  const hidden = useMemo(
    () => new Set([...[...settled].filter(([, from]) => from === source).map(([id]) => id), ...(source === "new" ? queued.map((pick) => pick.id) : [])]),
    [settled, queued, source],
  );
  const settle = useCallback((ids: string[], from: Queue) => setSettled((map) => new Map([...map, ...ids.map((id): [string, Queue] => [id, from])])), []);
  const unsettle = useCallback((ids: string[]) => setSettled((map) => new Map([...map].filter(([id]) => !ids.includes(id)))), []);
  useEffect(() => {
    if (!list.data) return;
    const present = new Set(list.data.rows.filter((row) => row.status === source).map((row) => row.id));
    setSettled((map) => {
      const next = new Map([...map].filter(([id, from]) => from !== source || present.has(id)));
      return next.size === map.size ? map : next;
    });
  }, [list.data, source]);
  const page = list.data?.status === queue && list.data.offset === offset ? list.data : undefined;
  const rows = (page?.rows ?? []).filter((row) => row.status === source && !hidden.has(row.id));
  const index = Math.max(0, rows.findIndex((row) => row.id === cursorId));
  const current = rows[index];
  const counts = list.data?.counts ?? {};
  const listRef = useRef<HTMLUListElement>(null);
  const accountName = (id: string | null | undefined) => accounts.find((account) => account.id === id)?.name ?? id ?? "";

  const postedToast = useCallback(
    (result: Posted, pickIds: string[]) =>
      toast({
        message: result.posted === 1 ? `Posted as entry ${result.numbers[0]}` : `Posted ${result.posted} rows`,
        action: result.posted === 1 ? { label: "Open", run: () => go({ view: "register", entry: result.entries[0] }) } : undefined,
        undo: () =>
          void run("reverseJournalEntry", { entryIds: result.entries }, {
            done: result.posted === 1 ? "Reversed, the row is back in review" : `Reversed ${result.posted} entries, the rows are back in review`,
            failed: "Could not undo the post",
            after: () => unsettle(pickIds),
          }),
      }),
    [run, toast, unsettle, go],
  );
  const flush = useCallback(async () => {
    if (flushing.current || !queuedRef.current.length) return;
    flushing.current = true;
    const picks = queuedRef.current;
    queuedRef.current = [];
    setQueued([]);
    const pickIds = picks.map((pick) => pick.id);
    settle(pickIds, "new");
    try {
      postedToast(await mutate<Posted>("postBankRows", { rows: picks }), pickIds);
    } catch (error) {
      unsettle(pickIds);
      toast({
        tone: "error",
        message: `Could not post ${picks.length === 1 ? "the row" : `${picks.length} rows`}`,
        detail: problem(error),
        action: {
          label: "Try again",
          run: () => void run<Posted>("postBankRows", { rows: picks }, { failed: "Could not post the rows", after: (result) => postedToast(result, pickIds) }),
        },
      });
    } finally {
      flushing.current = false;
      if (queuedRef.current.length) void flush();
    }
  }, [mutate, run, toast, settle, unsettle, postedToast]);

  useEffect(() => {
    if (queued.length) void flush();
  }, [queued, flush]);
  const flushRef = useRef(flush);
  flushRef.current = flush;
  useEffect(() => {
    const leave = () => void flushRef.current();
    window.addEventListener("pagehide", leave);
    return () => {
      window.removeEventListener("pagehide", leave);
      leave();
    };
  }, []);
  useEffect(() => {
    listRef.current?.querySelector<HTMLElement>(`[data-id="${current?.id}"]`)?.scrollIntoView({ block: "nearest" });
  }, [current?.id]);

  const decisionFor = (row: BankRow) => decide(row, choices[row.id]);
  const choose = (row: BankRow, patch: Choice) => setChoices((all) => ({ ...all, [row.id]: applyChoice(row, all[row.id], patch) }));
  const advance = () => {
    const next = rows[index + 1] ?? rows[index - 1];
    setCursorId(next?.id ?? null);
    toQueue();
  };
  const post = (row: BankRow | undefined) => {
    if (!row || row.status !== "new") return;
    const { pick } = decisionFor(row);
    if (typeof pick === "string") {
      document.querySelector<HTMLInputElement>(".b-bank-insp .b-insp-form [role=combobox]")?.focus();
      return;
    }
    advance();
    setQueued((list) => [...list, pick]);
  };
  const enter = (row: BankRow) => {
    const focused = document.activeElement;
    const decision = decisionFor(row);
    if (focused instanceof HTMLInputElement && focused.type === "radio" && !focused.checked && focused.closest(".b-bank-insp")) focused.click();
    else if (decision.undecided) focusCandidates();
    else if (!decision.matchesOnEnter) post(row);
    else if (decision.entry) link(row, decision.entry);
    else recordPayment(row);
  };
  const link = (row: BankRow, existing: { id: string; number: number }) => {
    advance();
    settle([row.id], "new");
    void run<{ number: number }>("linkBankRow", { id: row.id, entryId: existing.id }, {
      failed: `Could not match the row to entry ${existing.number}`,
      after: (result) =>
        toast({
          message: `Matched to entry ${result.number}`,
          undo: () => void run("unlinkBankRow", { id: row.id }, { done: "Back in review", failed: "Could not undo the match", after: () => unsettle([row.id]) }),
        }),
    }).then((result) => {
      if (!result) unsettle([row.id]);
    });
  };
  const unlink = (row: BankRow) => {
    advance();
    settle([row.id], "posted");
    void run("unlinkBankRow", { id: row.id }, { done: "Back in review", failed: "Could not undo the match" }).then((result) => {
      if (result === undefined) unsettle([row.id]);
    });
  };
  const recordPayment = (row: BankRow) => {
    const { invoice: match, undecided, notMatched, needsRest, choice } = decisionFor(row);
    if (!match) return;
    if (undecided) {
      focusCandidates();
      return;
    }
    const restAccountId = choice.restAccountId;
    if (needsRest) {
      document.querySelector<HTMLInputElement>(".b-apply-rest [role=combobox]")?.focus();
      return;
    }
    advance();
    settle([row.id], "new");
    void run<{ paymentEntryId: string; balanceCents: number; restCents: number }>(
      "recordPayment",
      {
        id: match.id,
        expectedVersion: match.version,
        bankRowId: row.id,
        ...(row.candidates.length ? { notMatched } : {}),
        ...(row.amountCents > match.balanceCents ? { restAccountId } : {}),
      },
      {
      failed: `Could not record the payment for ${match.number}`,
      after: (result) =>
        toast({
          message: result.balanceCents
            ? `Recorded ${money(row.amountCents, row.currency)} for ${match.number}, ${money(result.balanceCents, row.currency)} still due`
            : result.restCents
              ? `${match.number} is paid in full, ${money(result.restCents, row.currency)} went to ${accountName(restAccountId)}`
              : `${match.number} is paid in full`,
          undo: () =>
            void run("reverseJournalEntry", { entryId: result.paymentEntryId }, {
              done: `Reversed, invoice ${match.number} is open again`,
              failed: "Could not undo the payment",
              after: () => unsettle([row.id]),
            }),
        }),
      },
    ).then((result) => {
      if (!result) unsettle([row.id]);
    });
  };
  const ignore = (row: BankRow | undefined, ignored = true) => {
    if (!row) return;
    advance();
    settle([row.id], ignored ? "new" : "ignored");
    void run("setBankRowsIgnored", { ids: [row.id], ignored }, {
      failed: ignored ? "Could not skip the row" : "Could not restore the row",
      after: () =>
        toast({
          message: ignored ? "Skipped" : "Back in review",
          undo: ignored
            ? () => void run("setBankRowsIgnored", { ids: [row.id], ignored: false }, { after: () => unsettle([row.id]) })
            : undefined,
        }),
    }).then((result) => {
      if (result === undefined) unsettle([row.id]);
    });
  };
  const keepDuplicate = (row: BankRow) => {
    advance();
    settle([row.id], "duplicate");
    void run("keepDuplicateBankRow", { id: row.id }, { done: "Moved to review", failed: "Could not keep the row" }).then((result) => {
      if (result === undefined) unsettle([row.id]);
    });
  };
  const confirmDuplicate = (row: BankRow, confirmed: boolean) => {
    if (confirmed) advance();
    void run("confirmDuplicateBankRow", { id: row.id, confirmed }, {
      done: confirmed ? undefined : "Back to check",
      failed: confirmed ? "Could not confirm the duplicate" : "Could not undo the confirmation",
      after: () =>
        confirmed
          ? toast({
              message: "Confirmed as a duplicate",
              undo: row.closed
                ? undefined
                : () => void run("confirmDuplicateBankRow", { id: row.id, confirmed: false }, { done: "Back to check", failed: "Could not undo the confirmation" }),
            })
          : undefined,
    });
  };

  const toQueue = () => {
    if (!listRef.current?.contains(document.activeElement)) listRef.current?.focus({ preventScroll: true });
  };
  useKeys((event) => {
    if (event.key === "j" || event.key === "ArrowDown") {
      event.preventDefault();
      toQueue();
      setCursorId(rows[Math.min(rows.length - 1, index + 1)]?.id ?? null);
    } else if (event.key === "k" || event.key === "ArrowUp") {
      event.preventDefault();
      toQueue();
      setCursorId(rows[Math.max(0, index - 1)]?.id ?? null);
    } else if (!current || event.repeat) return;
    else if (event.key === "Enter") {
      event.preventDefault();
      if (current.status === "new") enter(current);
      else if (current.status === "duplicate") {
        if (!current.confirmed) confirmDuplicate(current, true);
      }
      else if (current.status === "ignored") {
        if (!current.closed) ignore(current, false);
      }
      else if (current.journalEntryId) go({ view: "register", entry: current.journalEntryId });
    } else if (event.key === "i" || event.key === "x") {
      if (current.status === "new") {
        event.preventDefault();
        ignore(current);
      }
    } else if (event.key === "a" && current.status === "new") {
      event.preventDefault();
      const { undecided, matchesOnEnter } = decisionFor(current);
      if (undecided) return focusCandidates();
      if (matchesOnEnter) choose(current, RULE_OUT);
      requestAnimationFrame(() => document.querySelector<HTMLInputElement>(".b-bank-insp .b-insp-form [role=combobox]")?.focus());
    } else if (event.key === "s" && current.status === "new") {
      event.preventDefault();
      if (decisionFor(current).undecided) focusCandidates();
      else startSplit(current);
    } else if (event.key === "f" && current.status === "new") {
      event.preventDefault();
      setFinding(current);
    }
  });

  const startSplit = (row: BankRow) => {
    const { choice, matchesOnEnter } = decisionFor(row);
    if (choice.splits) return;
    choose(row, {
      ...(row.candidates.length || matchesOnEnter ? RULE_OUT : {}),
      splits: [
        { key: 1, accountId: choice.accountId ?? "", amount: centsInput(Math.abs(row.amountCents), row.currency), memo: "" },
        { key: 2, accountId: "", amount: "", memo: "", auto: true },
      ],
    });
  };

  const tabs: Array<{ id: Queue; label: string; count?: number }> = [
    { id: "new", label: "Review", count: counts.review ?? 0 },
    { id: "matched", label: "Suggested", count: list.data?.matched ?? 0 },
    { id: "duplicate", label: "Duplicates", count: counts.duplicate ?? 0 },
    { id: "posted", label: "Posted", count: counts.posted ?? 0 },
    { id: "ignored", label: "Skipped", count: counts.ignored ?? 0 },
  ];
  const nothing = page && !rows.length;
  const decision = current ? decisionFor(current) : undefined;
  const hint = current && decision ? enterLabel(current, decision) : null;
  return (
    <>
      <Topbar title="Bank">
        {queued.length ? <span className="b-subtle">Posting {queued.length}…</span> : null}
        {(list.data?.reconciled ?? []).map((item) =>
          item.holds ? (
            <span key={item.id} className="b-reconciled">
              <CircleCheck size={14} aria-hidden />
              {item.accountName} reconciled through {shortDate(item.date, true)}
            </span>
          ) : (
            <button
              key={item.id}
              type="button"
              className="b-reconciled is-warn"
              title={
                item.waiting
                  ? `${item.waiting} statement ${item.waiting === 1 ? "row" : "rows"} on or before this date ${item.waiting === 1 ? "is" : "are"} not reviewed yet`
                  : "An entry on or before this date changed after the reconciliation"
              }
              onClick={() => setReconciling(item)}
            >
              <TriangleAlert size={14} aria-hidden />
              {item.accountName} changed since {shortDate(item.date, true)}
            </button>
          ),
        )}
        <button type="button" className="b-btn" onClick={() => setReconciling(true)}>
          Reconcile
        </button>
        <button type="button" className="b-btn" onClick={() => setImporting(true)}>
          <Upload size={14} aria-hidden />
          Import statement
        </button>
      </Topbar>
      <div className="b-filters">
        <Tablist
          label="Bank rows"
          value={queue}
          onChange={(next) => {
            if (next === queue) return;
            void flush();
            setQueue(next);
            setStarts([0]);
            setCursorId(null);
          }}
          items={tabs}
        />
        {list.refreshing ? <span className="b-spinner" aria-label="Updating" /> : null}
        <span className="b-filters-end b-subtle">
          <Kbd>J</Kbd> <Kbd>K</Kbd> move
          {hint ? (
            <>
              {" "}
              · <Kbd>↵</Kbd> {hint}
            </>
          ) : null}
          {queue === "new" || queue === "matched" ? (
            <>
              {" "}
              · <Kbd>I</Kbd> skip
            </>
          ) : null}
        </span>
      </div>
      <div className={cx("b-split b-bank", current && "has-inspector", opened && "is-open")}>
        <div className="b-queue-wrap">
          {list.error && !list.data ? (
            <div className="b-pad">
              <Failure error={list.error} retry={list.reload} title="Could not load bank rows" />
            </div>
          ) : !page ? (
            <div className="b-pad">
              <Loading rows={12} />
            </div>
          ) : nothing ? (
            <Empty
              icon={queue === "new" ? <Check size={20} aria-hidden /> : <Inbox size={20} aria-hidden />}
              title={queue === "new" ? "All caught up" : `No ${tabs.find((tab) => tab.id === queue)!.label.toLowerCase()} rows`}
              action={
                queue === "new" ? (
                  <button type="button" className="b-btn" onClick={() => setImporting(true)}>
                    <Upload size={14} aria-hidden />
                    Import statement
                  </button>
                ) : undefined
              }
            >
              {queue === "new"
                ? (list.data?.matched ?? 0) + (counts.duplicate ?? 0)
                  ? `Every row here is decided. ${[
                      list.data?.matched ? `${list.data.matched} suggested ${list.data.matched === 1 ? "match waits" : "matches wait"}` : "",
                      counts.duplicate ? `${counts.duplicate} possible ${counts.duplicate === 1 ? "duplicate waits" : "duplicates wait"}` : "",
                    ]
                      .filter(Boolean)
                      .join(" and ")} in the other tabs.`
                  : "Every imported bank row is posted or skipped."
                : null}
            </Empty>
          ) : (
            <ul className="b-queue" ref={listRef} role="listbox" aria-label="Bank rows" tabIndex={0} aria-activedescendant={current ? `bank-row-${current.id}` : undefined}>
              {rows.map((row) => (
                <li
                  key={row.id}
                  id={`bank-row-${row.id}`}
                  data-id={row.id}
                  role="option"
                  aria-selected={row.id === current?.id}
                  className={cx("b-queue-row", row.id === current?.id && "is-cursor", row.confirmed && "is-settled")}
                  onClick={() => (setCursorId(row.id), setOpened(true))}
                >
                  <span className={cx("b-flow", row.amountCents > 0 && "is-in")} aria-hidden>
                    {row.amountCents > 0 ? <ArrowDownLeft size={13} /> : <ArrowUpRight size={13} />}
                  </span>
                  <span className="b-queue-main">
                    <span className="b-queue-desc">{row.description || "No description"}</span>
                    <span className="b-queue-sub">
                      {shortDate(row.date)}
                      {row.match ? <span className="b-tag is-good">Invoice {row.match.number}</span> : null}
                      {row.status === "new" && !row.match && !row.candidates.length && row.payables[0]?.balanceCents === row.amountCents ? (
                        <span className="b-tag">Maybe {row.payables[0].number}</span>
                      ) : null}
                      {row.candidates.length ? (
                        <span className={cx("b-tag", row.candidates.some((candidate) => candidate.sure) && "is-good")}>
                          {row.candidates.some((candidate) => candidate.sure)
                            ? row.candidates.length === 1
                              ? `Entry ${row.candidates[0]!.number}`
                              : `${row.candidates.length} entries`
                            : row.candidates.length === 1
                              ? `Maybe entry ${row.candidates[0]!.number}`
                              : `Maybe ${row.candidates.length} entries`}
                        </span>
                      ) : null}
                      {row.status === "new" && !row.match && !row.candidates.length && (choices[row.id]?.accountId ?? row.suggestedAccountId) ? (
                        <span className="b-queue-account">{accountName(choices[row.id]?.accountId ?? row.suggestedAccountId)}</span>
                      ) : null}
                      {row.journalNumber ? <span className="b-queue-account">Entry {row.journalNumber}</span> : null}
                      {row.confirmed ? <span className="b-tag is-good">Confirmed</span> : null}
                    </span>
                  </span>
                  <span className={cx("b-num b-queue-amt", row.amountCents > 0 && "is-positive")}>{money(row.amountCents, row.currency)}</span>
                </li>
              ))}
            </ul>
          )}
          {page && (offset > 0 || page.nextOffset !== null) ? (
            <div className="b-pager">
              <span className="b-muted">
                {offset + 1}–{offset + page.rows.length}
              </span>
              <button type="button" className="b-icon-btn" aria-label="Previous page" disabled={offset === 0} onClick={() => setStarts((list) => list.slice(0, -1))}>
                <ChevronLeft size={16} aria-hidden />
              </button>
              <button type="button" className="b-icon-btn" aria-label="Next page" disabled={page.nextOffset === null} onClick={() => page.nextOffset !== null && setStarts((list) => [...list, page.nextOffset!])}>
                <ChevronRight size={16} aria-hidden />
              </button>
            </div>
          ) : null}
        </div>
        {current && decision ? (
          <BankInspector
            key={current.id}
            row={current}
            decision={decision}
            onChoose={(patch) => choose(current, patch)}
            onPost={() => post(current)}
            onPay={() => recordPayment(current)}
            onLink={() => decision.entry && link(current, decision.entry)}
            onUnlink={() => unlink(current)}
            onEnter={() => enter(current)}
            onIgnore={(ignored) => ignore(current, ignored)}
            onKeep={() => keepDuplicate(current)}
            onConfirm={(confirmed) => confirmDuplicate(current, confirmed)}
            onFind={() => setFinding(current)}
            onSplit={() => startSplit(current)}
            onClose={() => setOpened(false)}
            busy={acting !== null}
          />
        ) : null}
      </div>
      {finding ? (
        <FindSheet
          row={finding}
          onClose={() => setFinding(null)}
          onMatch={(entry) => {
            const row = finding;
            setFinding(null);
            requestAnimationFrame(() => link(row, entry));
          }}
        />
      ) : null}
      {importing ? <ImportSheet onClose={() => setImporting(false)} onDone={() => (setQueue("new"), setStarts([0]))} /> : null}
      {reconciling ? (
        <ReconcileSheet
          last={list.data?.reconciled ?? []}
          initial={reconciling === true ? null : reconciling}
          onClose={() => setReconciling(null)}
          onReview={(next) => (setReconciling(null), setQueue(next), setStarts([0]))}
        />
      ) : null}
    </>
  );
}

function FindSheet({ row, onClose, onMatch }: { row: BankRow; onClose: () => void; onMatch: (entry: Found) => void }) {
  const found = useBooks<{ days: number; entries: Found[] }>("findBankMatches", { id: row.id });
  const apart = (date: string) => {
    const days = Math.round((Date.parse(date) - Date.parse(row.date)) / 86400000);
    return days === 0 ? "same day" : `${Math.abs(days)} ${Math.abs(days) === 1 ? "day" : "days"} ${days < 0 ? "earlier" : "later"}`;
  };
  const picks = useRef<HTMLDivElement>(null);
  const count = found.data?.entries.length ?? 0;
  useEffect(() => {
    if (!count) return;
    const frame = requestAnimationFrame(() => picks.current?.querySelector("button")?.focus());
    return () => cancelAnimationFrame(frame);
  }, [count]);
  const move = (event: KeyboardEvent<HTMLDivElement>) => {
    const step = event.key === "ArrowDown" || event.key === "j" ? 1 : event.key === "ArrowUp" || event.key === "k" ? -1 : 0;
    if (!step) return;
    event.preventDefault();
    const items = [...(picks.current?.querySelectorAll<HTMLButtonElement>("button") ?? [])];
    const at = items.indexOf(document.activeElement as HTMLButtonElement);
    items[(at + step + items.length) % items.length]?.focus();
  };
  return (
    <Modal open title="Find the entry for this row" onClose={onClose}>
      <div onKeyDown={move}>
      <p className="b-find-row">
        <span className="b-date">{shortDate(row.date)}</span>
        <span className="b-candidate-memo">{row.description || "No description"}</span>
        <span className={cx("b-num", row.amountCents > 0 && "is-positive")}>{money(row.amountCents, row.currency)}</span>
      </p>
      {found.error && !found.data ? (
        <Failure error={found.error} retry={found.reload} title="Could not search the books" />
      ) : !found.data ? (
        <Loading rows={4} />
      ) : !found.data.entries.length ? (
        <p className="b-find-none">
          <strong>No entry to match.</strong> No unmatched entry within {found.data.days} days moves {money(row.amountCents, row.currency)} through this account.
        </p>
      ) : (
        <div ref={picks} className="b-candidates b-find" role="group" aria-label="Entries with the same amount">
          {found.data.entries.map((item) => (
            <button type="button" key={item.id} className="b-candidate" onClick={() => onMatch(item)}>
              <span className="b-mono">#{item.number}</span>
              <span className="b-date">{shortDate(item.date)}</span>
              <span className="b-candidate-memo">
                {item.memo || "No memo"}
                {item.accounts ? <span className="b-subtle"> · {item.accounts}</span> : null}
              </span>
              <span className="b-subtle">{apart(item.date)}</span>
            </button>
          ))}
        </div>
      )}
      </div>
    </Modal>
  );
}

interface InspectorProps {
  row: BankRow;
  decision: Decision;
  onChoose: (patch: Choice) => void;
  onPost: () => void;
  onPay: () => void;
  onLink: () => void;
  onUnlink: () => void;
  onEnter: () => void;
  onIgnore: (ignored: boolean) => void;
  onKeep: () => void;
  onConfirm: (confirmed: boolean) => void;
  onFind: () => void;
  onSplit: () => void;
  onClose: () => void;
  busy: boolean;
}

function BankInspector({ row, decision, onChoose, onPost, onPay, onLink, onUnlink, onEnter, onIgnore, onKeep, onConfirm, onFind, onSplit, onClose, busy }: InspectorProps) {
  const { choice, entry, invoice, matchesOnEnter, undecided } = decision;
  const { accounts, go } = useBooksContext();
  const bank = accounts.find((account) => account.id === row.bankAccountId);
  const blocked = row.status === "new" && typeof decision.pick === "string" ? decision.pick : null;
  const splits = choice.splits;
  const other = invoice && invoice.id !== row.match?.id ? invoice : undefined;
  const gone = choice.invoiceId !== undefined && !invoice;
  const nextKey = useRef(Math.max(10, ...(splits ?? []).map((split) => split.key + 1)));
  const keys = (event: KeyboardEvent) => {
    if (event.key === "Enter" && !event.shiftKey && row.status === "new" && (event.target as HTMLElement).tagName === "INPUT") {
      event.preventDefault();
      if (!event.repeat) onEnter();
    } else if (event.key === "Escape") {
      (event.target as HTMLElement).blur?.();
    }
  };
  const remaining = splits
    ? Math.abs(row.amountCents) - splits.reduce((sum, split) => sum + (parseAmount(split.amount, row.currency) ?? 0), 0)
    : 0;
  const setSplit = (index: number, patch: Partial<Split>) => {
    const next = splits!.map((split, at) => (at === index ? { ...split, ...patch, ...(patch.amount === undefined ? {} : { auto: false }) } : split));
    const open = next.filter((split) => split.auto);
    if (patch.amount === undefined || open.length !== 1) return onChoose({ splits: next });
    const left = Math.abs(row.amountCents) - next.reduce((sum, split) => sum + (split.auto ? 0 : parseAmount(split.amount, row.currency) ?? 0), 0);
    onChoose({ splits: next.map((split) => (split.auto ? { ...split, amount: left > 0 ? centsInput(left, row.currency) : "" } : split)) });
  };
  return (
    <aside className="b-inspector b-bank-insp" aria-label={`Bank row ${row.description}`} onKeyDown={keys}>
      <header className="b-insp-head">
        <button type="button" className="b-icon-btn b-insp-back" aria-label="Back to the queue" onClick={onClose}>
          <ArrowLeft size={16} aria-hidden />
        </button>
        <strong>
          <Landmark size={14} aria-hidden /> {bank ? `${bank.id} ${bank.name}` : row.bankAccountId}
        </strong>
        <span className="b-insp-tags">
          <span className="b-subtle">Line {row.lineNo}</span>
        </span>
      </header>
      <div className="b-insp-scroll">
        <div className="b-insp-hero">
          <p className="b-muted">{longDate(row.date)}</p>
          <h2>{row.description || "No description"}</h2>
          <p className={cx("b-insp-amount b-mono", row.amountCents > 0 && "is-positive")}>{money(row.amountCents, row.currency)}</p>
          <p className="b-subtle">{row.amountCents > 0 ? "Money in" : "Money out"}</p>
        </div>
        {row.status === "new" && row.candidates.length === 1 && row.candidates[0]!.sure && entry ? (
          <section className="b-match">
            <Link size={16} aria-hidden />
            <div>
              <strong>Already in the books as entry {entry.number}</strong>
              <span className="b-muted">
                {shortDate(entry.date)} · {entry.memo || "No memo"}
              </span>
            </div>
            <button type="button" className={cx("b-btn", matchesOnEnter && "b-btn-primary")} disabled={busy} onClick={onLink}>
              Match {matchesOnEnter ? <Kbd>↵</Kbd> : null}
            </button>
          </section>
        ) : null}
        {row.status === "new" && row.candidates.length && !(row.candidates.length === 1 && row.candidates[0]!.sure && entry) ? (
          <section className={cx("b-match b-match-pick", !row.candidates.some((candidate) => candidate.sure) && "is-maybe")}>
            <Link size={16} aria-hidden />
            <div>
              <strong>
                {row.candidates.some((candidate) => candidate.sure)
                  ? `${row.candidates.length} entries in the books match this row`
                  : row.candidates.length === 1
                    ? "Same amount within a week. The same money?"
                    : `${row.candidates.length} entries have the same amount within a week`}
              </strong>
              <div className="b-candidates" role="radiogroup" aria-label="Entry to match">
                {row.candidates.map((candidate) => (
                  <label key={candidate.id} className={cx("b-candidate", candidate.id === entry?.id && "is-on")}>
                    <input
                      type="radio"
                      name={`match-${row.id}`}
                      checked={candidate.id === entry?.id}
                      onChange={() => onChoose({ entryId: candidate.id, invoiceId: undefined, accountId: undefined, splits: undefined, override: false, none: false })}
                    />
                    <span className="b-mono">#{candidate.number}</span>
                    <span className="b-date">{shortDate(candidate.date)}</span>
                    <span className="b-candidate-memo">
                      {candidate.memo || "No memo"}
                      {candidate.accounts ? <span className="b-subtle"> · {candidate.accounts}</span> : null}
                    </span>
                  </label>
                ))}
                <label className={cx("b-candidate", !entry && !undecided && "is-on")}>
                  <input
                    type="radio"
                    name={`match-${row.id}`}
                    checked={!entry && !undecided}
                    onChange={() => onChoose({ entryId: undefined, none: true })}
                  />
                  <span className="b-candidate-memo">{row.candidates.length === 1 ? "Not this entry" : "None of these"}</span>
                </label>
              </div>
            </div>
            {entry ? (
              <button type="button" className={cx("b-btn", matchesOnEnter && "b-btn-primary")} disabled={busy} onClick={onLink}>
                Match {matchesOnEnter ? <Kbd>↵</Kbd> : null}
              </button>
            ) : null}
          </section>
        ) : null}
        {row.status === "new" && row.match && invoice?.id === row.match.id ? (
          <section className="b-match">
            <FileText size={16} aria-hidden />
            <div>
              <strong>{row.amountCents < row.match.balanceCents ? `Pays part of ${row.match.number}` : `Matches invoice ${row.match.number}`}</strong>
              <span className="b-muted">
                {row.match.clientName} ·{" "}
                {row.amountCents < row.match.balanceCents
                  ? `leaves ${money(row.match.balanceCents - row.amountCents, row.currency)} due`
                  : `${money(row.match.balanceCents, row.currency)} due ${shortDate(row.match.dueDate)}`}
              </span>
            </div>
            <button type="button" className={cx("b-btn", matchesOnEnter && !entry && "b-btn-primary")} disabled={busy || undecided} onClick={onPay}>
              Record payment {matchesOnEnter && !entry ? <Kbd>↵</Kbd> : null}
            </button>
          </section>
        ) : null}
        {row.status === "new" &&
        row.payables.length > 0 &&
        (gone || !row.match || row.payables.some((item) => item.id !== row.match?.id)) &&
        !(entry && row.candidates.some((candidate) => candidate.sure)) ? (
          <details className="b-apply" open={Boolean(other || gone) || undefined}>
            <summary>
              <ChevronRight size={14} className="b-apply-chevron" aria-hidden />
              Pay an open invoice instead
            </summary>
            <div className="b-apply-body">
              {gone ? <p className="b-hint">The invoice you chose is no longer open. Choose again.</p> : null}
              <div className="b-candidates" role="radiogroup" aria-label="Invoice to pay">
                {row.payables.map((item) => (
                  <label key={item.id} className={cx("b-candidate is-invoice", item.id === invoice?.id && "is-on")}>
                    <input
                      type="radio"
                      name={`pay-${row.id}`}
                      checked={item.id === invoice?.id}
                      onChange={() => onChoose({ invoiceId: item.id, entryId: undefined, accountId: undefined, splits: undefined, override: false, none: true })}
                    />
                    <span className="b-mono">{item.number}</span>
                    <span className="b-candidate-memo">
                      {item.clientName}
                      {item.named ? null : <span className="b-subtle"> · amount only</span>}
                    </span>
                    <span className="b-date">
                      {item.balanceCents === row.amountCents
                        ? "pays in full"
                        : item.balanceCents > row.amountCents
                          ? `leaves ${money(item.balanceCents - row.amountCents, row.currency)}`
                          : `${money(row.amountCents - item.balanceCents, row.currency)} extra`}
                    </span>
                  </label>
                ))}
              </div>
              {other && row.amountCents > other.balanceCents ? (
                <label className="b-field b-apply-rest">
                  <span className="b-field-label">The extra {money(row.amountCents - other.balanceCents, row.currency)} goes to</span>
                  <AccountPicker
                    accounts={accounts}
                    value={choice.restAccountId ?? ""}
                    onChange={(restAccountId) => onChoose({ restAccountId: restAccountId || undefined })}
                    label="Account for the extra"
                    filter={(account) => !account.isBank && account.role !== "receivable"}
                  />
                </label>
              ) : null}
              {other ? (
                <button
                  type="button"
                  className={cx("b-btn", matchesOnEnter && !entry && "b-btn-primary")}
                  disabled={busy || undecided || (row.amountCents > other.balanceCents && !choice.restAccountId)}
                  onClick={onPay}
                >
                  Record payment {matchesOnEnter && !entry ? <Kbd>↵</Kbd> : null}
                </button>
              ) : null}
            </div>
          </details>
        ) : null}
        {row.status === "new" && (matchesOnEnter || undecided) ? (
          <div className="b-insp-actions b-match-alt">
            {undecided ? null : (
              <button
                type="button"
                className="b-link"
                onClick={() => {
                  onChoose(RULE_OUT);
                  requestAnimationFrame(() => document.querySelector<HTMLInputElement>(".b-bank-insp .b-insp-form [role=combobox]")?.focus());
                }}
              >
                {row.match || row.candidates.length ? "Not this one, post it instead" : "Post to an account instead"}
              </button>
            )}
            <button type="button" className="b-link" onClick={onFind}>
              Find another entry
            </button>
            <button type="button" className="b-btn b-btn-ghost b-btn-sm" onClick={() => onIgnore(true)}>
              Skip <Kbd>I</Kbd>
            </button>
          </div>
        ) : row.status === "new" ? (
          <section className="b-insp-form">
            {splits ? (
              <div className="b-splits">
                <div className="b-splits-head">
                  <span>Split across accounts</span>
                  <button type="button" className="b-link" onClick={() => onChoose({ splits: undefined })}>
                    Use one account
                  </button>
                </div>
                {splits.map((split, at) => (
                  <div className="b-split-row" key={split.key}>
                    <AccountPicker
                      accounts={accounts}
                      value={split.accountId}
                      onChange={(accountId) => setSplit(at, { accountId })}
                      label={`Account on split ${at + 1}`}
                      filter={(account) => account.id !== row.bankAccountId && account.role !== "receivable"}
                    />
                    <input
                      className={cx("b-input b-input-amount", parseAmount(split.amount, row.currency) === null && "is-invalid")}
                      aria-label={`Amount on split ${at + 1}`}
                      inputMode="decimal"
                      value={split.amount}
                      onChange={(event) => setSplit(at, { amount: event.target.value })}
                      onKeyDown={(event) => {
                        if (event.key === "=") {
                          event.preventDefault();
                          const own = parseAmount(split.amount, row.currency) ?? 0;
                          setSplit(at, { amount: centsInput(Math.max(0, own + remaining), row.currency) });
                        }
                      }}
                    />
                    <button
                      type="button"
                      className="b-icon-btn"
                      aria-label={`Remove split ${at + 1}`}
                      disabled={splits.length <= 2}
                      onClick={() => onChoose({ splits: splits.filter((_, index) => index !== at) })}
                    >
                      <Trash2 size={14} aria-hidden />
                    </button>
                  </div>
                ))}
                <div className="b-splits-foot">
                  <button
                    type="button"
                    className="b-btn b-btn-ghost b-btn-sm"
                    onClick={() =>
                      onChoose({
                        splits: [
                          ...splits.map((split) => ({ ...split, auto: false })),
                          { key: nextKey.current++, accountId: "", amount: remaining > 0 ? centsInput(remaining, row.currency) : "", memo: "", auto: true },
                        ],
                      })
                    }
                  >
                    <Plus size={14} aria-hidden />
                    Add split
                  </button>
                  <span className={cx("b-mono", remaining ? "is-negative" : "b-subtle")}>
                    {remaining ? `${money(Math.abs(remaining), row.currency)} ${remaining > 0 ? "left" : "over"}` : blocked ?? "Fully allocated"}
                  </span>
                </div>
              </div>
            ) : (
              <label className="b-field">
                <span className="b-field-label">
                  {row.amountCents > 0 ? "Where the money came from" : "What it was for"}
                  {row.suggestedAccountId && choice.accountId === row.suggestedAccountId ? <span className="b-tag">Suggested</span> : null}
                </span>
                <AccountPicker
                  accounts={accounts}
                  value={choice.accountId ?? ""}
                  onChange={(accountId) => onChoose({ accountId })}
                  label="Other account"
                  placeholder="Search accounts"
                  filter={(account) => account.id !== row.bankAccountId && account.role !== "receivable"}
                />
              </label>
            )}
            <label className="b-field">
              <span className="b-field-label">Memo</span>
              <input
                className="b-input"
                value={choice.memo ?? ""}
                placeholder={row.description}
                maxLength={500}
                onChange={(event) => onChoose({ memo: event.target.value })}
              />
            </label>
            <div className="b-insp-actions">
              <button type="button" className="b-btn b-btn-primary" disabled={Boolean(blocked)} title={blocked ?? undefined} onClick={onPost}>
                Post <Kbd>↵</Kbd>
              </button>
              {splits ? null : (
                <button type="button" className="b-btn" onClick={onSplit}>
                  Split <Kbd>S</Kbd>
                </button>
              )}
              <button type="button" className="b-btn" onClick={() => onIgnore(true)}>
                Skip <Kbd>I</Kbd>
              </button>
              <button type="button" className="b-btn b-btn-ghost" onClick={onFind}>
                Find entry <Kbd>F</Kbd>
              </button>
            </div>
            {blocked && choice.accountId && !splits ? <p className="b-hint is-warn">{blocked}</p> : null}
          </section>
        ) : row.status === "duplicate" ? (
          <section className="b-insp-form">
            <p className="b-insp-note">
              <Copy size={14} aria-hidden />
              {row.confirmed
                ? "Confirmed as a duplicate. It stays out of the books, and the import keeps it on record."
                : row.original && row.original.description.toLowerCase() !== row.description.toLowerCase()
                  ? "Same date and amount as a row imported before."
                  : "Same date, amount, and description as a row imported before."}
            </p>
            {row.original ? (
              <div className="b-original">
                <span className="b-subtle">Imported before</span>
                <strong>{row.original.description || "No description"}</strong>
                <span className="b-muted">
                  {shortDate(row.date)} · {money(row.amountCents, row.currency)}
                </span>
                <span className="b-muted">
                  {row.original.journalNumber
                    ? `In the books as entry ${row.original.journalNumber}`
                    : row.original.status === "ignored"
                      ? "Skipped"
                      : "In review"}
                </span>
              </div>
            ) : null}
            <div className="b-insp-actions">
              {row.confirmed ? (
                row.closed ? null : (
                  <button type="button" className="b-btn" disabled={busy} onClick={() => onConfirm(false)}>
                    <RotateCcw size={14} aria-hidden />
                    Unconfirm
                  </button>
                )
              ) : (
                <button type="button" className="b-btn b-btn-primary" disabled={busy} onClick={() => onConfirm(true)}>
                  Confirm duplicate <Kbd>↵</Kbd>
                </button>
              )}
              {row.closed || row.confirmed ? null : (
                <button type="button" className="b-btn" disabled={busy} onClick={onKeep}>
                  Keep as new
                </button>
              )}
            </div>
            {row.closed && !row.confirmed ? <p className="b-hint">Its month is closed, so it can only stay out of the books.</p> : null}
          </section>
        ) : row.status === "ignored" ? (
          <section className="b-insp-form">
            <p className="b-insp-note">{row.closed ? "Skipped, and its month is closed, so it stays out of the books." : "Skipped rows stay out of the books."}</p>
            {row.closed ? null : (
              <div className="b-insp-actions">
                <button type="button" className="b-btn" disabled={busy} onClick={() => onIgnore(false)}>
                  <RotateCcw size={14} aria-hidden />
                  Restore <Kbd>↵</Kbd>
                </button>
              </div>
            )}
          </section>
        ) : (
          <section className="b-insp-form">
            <p className="b-insp-note">
              {row.reversedByNumber
                ? `Entry ${row.journalNumber} was reversed by entry ${row.reversedByNumber} after this row's date, so the row stays posted. Post a new entry if the money belongs somewhere else.`
                : row.linked
                  ? `Matched to entry ${row.journalNumber}, which was already in the books.${row.closed ? " Its month is closed, so the match stays." : ""}`
                  : row.closed
                    ? `Posted as entry ${row.journalNumber}. Its month is closed, so the entry stays.`
                    : `Posted as entry ${row.journalNumber}. Reversing it on its own date sends this row back to review.`}
            </p>
            <div className="b-insp-actions">
              {row.journalEntryId ? (
                <button type="button" className="b-btn b-btn-primary" onClick={() => go({ view: "register", entry: row.journalEntryId! })}>
                  Open entry {row.journalNumber} <Kbd>↵</Kbd>
                </button>
              ) : null}
              {row.linked && !row.reversedByNumber && !row.closed ? (
                <button type="button" className="b-btn" disabled={busy} onClick={onUnlink}>
                  <RotateCcw size={14} aria-hidden />
                  Undo match
                </button>
              ) : null}
            </div>
          </section>
        )}
        {row.status === "new" ? <PayeeHistory row={row} /> : null}
        <details className="b-insp-section b-row-source">
          <summary>Source</summary>
          <dl className="b-facts">
            <div>
              <dt>Statement</dt>
              <dd className="b-mono">{row.importId.slice(0, 20)}</dd>
            </div>
            <div>
              <dt>Row fingerprint</dt>
              <dd className="b-mono">{row.rowHash.slice(0, 16)}</dd>
            </div>
          </dl>
        </details>
      </div>
    </aside>
  );
}

interface PastEntry {
  id: string;
  number: number;
  date: string;
  memo: string;
  accounts: string | null;
  totalCents: number;
  currency: string;
}

function PayeeHistory({ row }: { row: BankRow }) {
  const { accounts, go } = useBooksContext();
  const bankName = accounts.find((account) => account.id === row.bankAccountId)?.name;
  const payee = row.description.slice(0, 12).trim();
  const past = useBooks<{ entries: PastEntry[] }>("listEntries", { accountId: row.bankAccountId, currency: row.currency, q: payee, to: row.date, limit: 6 }, { enabled: payee.length >= 3 });
  const entries = (past.data?.entries ?? []).filter((entry) => entry.id !== row.journalEntryId).slice(0, 5);
  if (!entries.length) return null;
  return (
    <section className="b-insp-section b-payee" aria-label="Earlier from this payee">
      <h3>Earlier from this payee</h3>
      <ul>
        {entries.map((entry) => (
          <li key={entry.id}>
            <button type="button" className="b-payee-row" onClick={() => go({ view: "register", entry: entry.id })}>
              <span className="b-date">{shortDate(entry.date)}</span>
              <span className="b-payee-accounts">{(entry.accounts ?? "").split(" · ").filter((name) => name !== bankName).join(" · ")}</span>
              <span className="b-num">{money(entry.totalCents, entry.currency)}</span>
            </button>
          </li>
        ))}
      </ul>
    </section>
  );
}
