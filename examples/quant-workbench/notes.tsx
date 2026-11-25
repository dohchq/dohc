import { useEffect, useRef, useState, type FormEvent } from "react";
import { useDatasetMutation, useDatasetQuery } from "dohc/app";
import { Bookmark, ChartLine, ChevronLeft, ChevronRight, Globe, Share2 } from "dohc/icons";
import { Button, Callout, Field, Input, Textarea } from "dohc/ui";
import { Spark } from "./charts";
import { useSticky } from "./hooks";
import { QueryError } from "./query-error";
import {
  AXIS_COLORS,
  DAY,
  GRAIN_NAMES,
  summarize,
  type Grain,
  type Report,
  type Snapshot,
} from "./report/model";
import { count, formatInterval, formatR, formatRange } from "./report/format";
import { lagText } from "./stats";
import type { Range } from "./types";

type Note = {
  id: string;
  title: string;
  date_start: string;
  date_end: string;
  created_at_ms: number;
  grant_id: string | null;
};
type SavedReport = Report & { grant: string | null; version: number };

export type Drawer = "notes" | "share";
export type View = Range & { ids: string[]; grain: Grain; lag: number; names: string[] };
type Draft = { title: string; body: string };
type NoteInput = Omit<View, "names"> & Draft;
type Withdrawn = { id: string; grant: string; version: number };
type LinkInput = { id: string; grant: string | null; version: number };

const NOTE_PAGE_SIZE = 50;

const savedAt = new Intl.DateTimeFormat("en", {
  year: "numeric",
  month: "short",
  day: "numeric",
  hour: "2-digit",
  minute: "2-digit",
  second: "2-digit",
  hourCycle: "h23",
  timeZone: "UTC",
});

function useReportLink() {
  const mutation = useDatasetMutation<
    LinkInput,
    { id: string; previous: string | null; version: number }
  >("setReportLink");
  const [sent, setSent] = useState<{ input: LinkInput; title: string } | null>(null);
  const [withdrawn, setWithdrawn] = useState<Withdrawn | null>(null);
  function finish(attempt: LinkInput, done: Awaited<ReturnType<typeof mutation.retry>>) {
    if (!done) return false;
    if (attempt.grant === null && done.result.previous)
      setWithdrawn({ id: attempt.id, grant: done.result.previous, version: done.result.version });
    else if (attempt.grant !== null)
      setWithdrawn((current) =>
        current?.id === attempt.id || current?.grant === attempt.grant ? null : current,
      );
    return true;
  }
  async function update(input: LinkInput, title: string) {
    setSent({ input, title });
    return finish(input, await mutation.mutate(input));
  }
  async function retry() {
    return sent ? finish(sent.input, await mutation.retry()) : false;
  }
  function discard() {
    mutation.discardPending();
    setSent(null);
  }
  return { mutation, sent, withdrawn, update, retry, discard };
}

export function useNotebook() {
  const [draft, setDraft] = useState<Draft>({ title: "", body: "" });
  const save = useDatasetMutation<NoteInput, { id: string }>("saveNote");
  const sent = useRef<{ input: NoteInput; scope: string } | null>(null);
  const link = useReportLink();
  return { draft, setDraft, save, sent, link };
}

export function Notes({
  mode,
  onMode,
  onClose,
  onOpen,
  modal,
  notebook,
  view,
  canSave,
}: {
  mode: Drawer;
  onMode: (mode: Drawer) => void;
  onClose: () => void;
  onOpen: (snapshot: Snapshot) => void;
  modal: boolean;
  notebook: ReturnType<typeof useNotebook>;
  view: View;
  canSave: boolean;
}) {
  const { draft, setDraft, save, sent, link } = notebook;
  const { names, ...current } = view;
  const [offset, setOffset] = useState(0);
  const notes = useDatasetQuery<Note[]>("listNotes", { offset });
  const [selected, setSelected] = useState(link.withdrawn?.id ?? "");
  const [grant, setGrant] = useState("");
  const showing = useRef(selected);
  showing.current = selected;
  const { withdrawn } = link;
  const report = useDatasetQuery<SavedReport | null>(
    "readNote",
    { id: selected },
    { enabled: Boolean(selected) },
  );
  const linkBusy = link.mutation.pending || link.mutation.uncertain || report.loading;
  useEffect(() => {
    if (mode === "notes") document.getElementById("note-title")?.focus();
    else document.getElementById("share-title")?.focus();
  }, [mode]);

  useEffect(() => {
    if (!selected && notes.data?.[0]) setSelected(notes.data[0].id);
  }, [notes.data, selected]);

  const scope = !view.start
    ? ""
    : `${formatRange(view.start, view.end)} · ${GRAIN_NAMES[view.grain]} buckets · ${names.join(" vs ")}${view.ids.length === 2 ? ` · lag ${lagText(view.lag)}` : ""}`;
  const held = (save.pending || save.uncertain) && sent.current ? sent.current : null;
  const shown = held?.input ?? draft;

  async function saveNote(event: FormEvent) {
    event.preventDefault();
    const input = { ...current, ...draft };
    if (!save.uncertain) sent.current = { input, scope };
    try {
      const saved = save.uncertain ? await save.retry() : await save.mutate(input);
      if (!saved) return;
      sent.current = null;
      setDraft({ title: "", body: "" });
      setSelected(saved.result.id);
      setGrant("");
      setOffset(0);
      notes.reload();
    } catch {
      return;
    }
  }

  async function changeLink(id: string, run: () => Promise<boolean>) {
    const done = await run().catch(() => false);
    if (done && showing.current === id) setGrant("");
    notes.reload();
    report.reload();
  }

  const saved = useSticky(report.data, selected);
  const finding = saved?.snapshot.comparison ? summarize(saved.snapshot.comparison) : null;

  const updateLink = (value: string | null, version = saved?.version ?? 0) =>
    changeLink(selected, () =>
      link.update({ id: selected, grant: value, version }, saved?.title ?? ""),
    );
  return (
    <aside
      className="drawer"
      role="dialog"
      aria-modal={modal}
      aria-labelledby="notes-title"
      onKeyDown={(event) => {
        if (event.key === "Escape") {
          event.stopPropagation();
          onClose();
        }
      }}
    >
      <header className="drawer-head">
        <h2 id="notes-title" className="sb-sr">
          {mode === "share" ? "Share a report" : "Research notes"}
        </h2>
        <div className="sb-segments" role="group" aria-label="Drawer view">
          <button type="button" aria-pressed={mode === "notes"} onClick={() => onMode("notes")}>
            Notes
          </button>
          <button type="button" aria-pressed={mode === "share"} onClick={() => onMode("share")}>
            Share
          </button>
        </div>
        {modal ? (
          <Button size="sm" onClick={onClose}>
            Done
          </Button>
        ) : (
          <button
            type="button"
            className="icon-only"
            aria-label="Close drawer"
            title="Close (Esc)"
            onClick={onClose}
          >
            <ChevronRight size={16} aria-hidden="true" />
          </button>
        )}
      </header>
      <div className="drawer-body">
        {mode === "share" && (
          <section className="share-steps" aria-labelledby="share-title">
            <h3 id="share-title" tabIndex={-1}>
              Publish a read-only report
            </h3>
            <ol>
              <li>
                In dohc, share <code>quant-workbench/report</code> with a Can view link. Open its
                Link options and choose Copy link ID.
              </li>
              <li>
                Pick a saved snapshot below, paste the ID under Report link ID, and choose Link
                report.
              </li>
              <li>
                In dohc, open the report app, choose Publish on a share link, pick that link,
                approve it, and choose Copy app link.
              </li>
            </ol>
          </section>
        )}
        {mode === "notes" && (
          <form className="note-form" onSubmit={saveNote}>
            <Field label="Title" htmlFor="note-title">
              <Input
                id="note-title"
                value={shown.title}
                maxLength={120}
                required
                readOnly={Boolean(held)}
                onChange={(event) => setDraft({ ...draft, title: event.target.value })}
                placeholder="What did you find?"
              />
            </Field>
            <Field label="Note" htmlFor="note-body">
              <Textarea
                id="note-body"
                value={shown.body}
                maxLength={6000}
                rows={4}
                required
                readOnly={Boolean(held)}
                onChange={(event) => setDraft({ ...draft, body: event.target.value })}
              />
            </Field>
            <p className="note-scope">
              {held
                ? held.scope
                : canSave
                  ? scope
                  : "Choose a range with observations to save a snapshot"}
            </p>
            {save.error && <Callout tone="danger">{save.error.message}</Callout>}
            <Button
              type="submit"
              variant="primary"
              disabled={(!canSave && !save.uncertain) || save.pending}
            >
              <Bookmark size={14} aria-hidden="true" />
              {save.pending ? "Saving…" : save.uncertain ? "Retry save" : "Save snapshot"}
            </Button>
            {save.uncertain && !save.pending && (
              <Button
                type="button"
                variant="secondary"
                title="The first save may have gone through. Check Saved snapshots before saving again."
                onClick={() => {
                  sent.current = null;
                  save.discardPending();
                }}
              >
                Edit again
              </Button>
            )}
          </form>
        )}
        <section className="note-library" aria-labelledby="library-title">
          <h3 id="library-title">Saved snapshots</h3>
          {notes.error && (
            <QueryError
              error={notes.error}
              reload={notes.reload}
              message="Could not load snapshots"
            />
          )}
          {!notes.data && notes.loading && (
            <p className="drawer-empty" role="status">
              Loading snapshots
            </p>
          )}
          {offset === 0 && notes.data?.length === 0 && (
            <p className="drawer-empty">
              No snapshots yet
              {mode === "share" && (
                <>
                  {" · "}
                  <button type="button" className="link-button" onClick={() => onMode("notes")}>
                    Save one in Notes
                  </button>
                </>
              )}
            </p>
          )}
          <div className="note-entries">
            {notes.data?.slice(0, NOTE_PAGE_SIZE).map((entry) => (
              <button
                key={entry.id}
                type="button"
                className="note-row"
                aria-pressed={selected === entry.id}
                onClick={() => {
                  setSelected(entry.id);
                  setGrant("");
                }}
              >
                <span>
                  <strong>{entry.title}</strong>
                  <small>
                    {formatRange(entry.date_start, entry.date_end)} · saved{" "}
                    {savedAt.format(entry.created_at_ms)} UTC
                  </small>
                </span>
                {entry.grant_id && <Globe size={13} aria-label="Linked report" />}
              </button>
            ))}
          </div>
          {(offset > 0 || (notes.data?.length ?? 0) > NOTE_PAGE_SIZE) && (
            <div className="note-page">
              {offset > 0 && (
                <Button
                  size="sm"
                  variant="ghost"
                  onClick={() => setOffset(offset - NOTE_PAGE_SIZE)}
                >
                  <ChevronLeft size={14} aria-hidden="true" /> Newer
                </Button>
              )}
              {(notes.data?.length ?? 0) > NOTE_PAGE_SIZE && (
                <Button
                  size="sm"
                  variant="ghost"
                  onClick={() => setOffset(offset + NOTE_PAGE_SIZE)}
                >
                  Older <ChevronRight size={14} aria-hidden="true" />
                </Button>
              )}
            </div>
          )}
        </section>
        {((link.mutation.uncertain && link.sent) || report.error) && (
          <div className="drawer-alerts">
            {link.mutation.uncertain && link.sent && (
              <Callout
                tone="danger"
                title={`${link.sent.input.grant === null ? "Withdrawing" : "Linking"} the report for “${link.sent.title}” may not have saved`}
                action={
                  <>
                    <Button
                      size="sm"
                      variant="secondary"
                      disabled={link.mutation.pending}
                      onClick={() => void changeLink(link.sent?.input.id ?? selected, link.retry)}
                    >
                      Try again
                    </Button>
                    <Button
                      size="sm"
                      variant="ghost"
                      disabled={link.mutation.pending}
                      title="The change may already have gone through. Dismissing reloads the snapshot so you can check."
                      onClick={() => {
                        link.discard();
                        notes.reload();
                        report.reload();
                      }}
                    >
                      Dismiss
                    </Button>
                  </>
                }
              >
                {link.mutation.error?.message ?? "Check the connection, then try again."}
              </Callout>
            )}
            {report.error && (
              <QueryError
                error={report.error}
                reload={report.reload}
                message="Could not load this snapshot"
              />
            )}
          </div>
        )}
        {selected && saved === undefined && !report.error && (
          <p className="drawer-empty" role="status">
            Loading snapshot
          </p>
        )}
        {saved && (
          <article className="note-preview" aria-labelledby="preview-title">
            <h3 id="preview-title">{saved.title}</h3>
            <p className="note-meta">
              {formatRange(saved.snapshot.start, saved.snapshot.end)} ·{" "}
              {GRAIN_NAMES[saved.snapshot.grain]} buckets
            </p>
            <p className="note-body">{saved.body}</p>
            <div className="snapshot-series">
              {saved.snapshot.series.map((series, index) => (
                <div key={series.id}>
                  <span>
                    <i style={{ background: AXIS_COLORS[index] }} />
                    {series.name}
                  </span>
                  <Spark
                    points={series.bars.map((bar) => [
                      (Date.parse(series.bars.at(-1)!.bucket) - Date.parse(bar.bucket)) / DAY,
                      bar.mean,
                    ])}
                    color={AXIS_COLORS[index]}
                    label={`${series.name} snapshot`}
                  />
                </div>
              ))}
            </div>
            {finding?.kind === "few" && (
              <p className="note-meta num">
                Too few paired days ({count(finding.n)}) to estimate r at lag {lagText(finding.lag)}
              </p>
            )}
            {finding?.kind === "constant" && (
              <p className="note-meta num">
                No r at lag {lagText(finding.lag)}: one series is constant across {count(finding.n)}{" "}
                paired days
              </p>
            )}
            {finding?.kind === "fit" && (
              <p className="note-meta num">
                r {formatR(finding.r)} at lag {lagText(finding.lag)} · {count(finding.n)} paired
                days
                {finding.effective !== null &&
                  `, ≈${count(Math.round(finding.effective))} independent`}
                {finding.ci && (
                  <>
                    {" · "}
                    <span className="nowrap">95% CI {formatInterval(finding.ci)}</span> for this lag
                    alone, not corrected for trying other lags
                  </>
                )}
              </p>
            )}
            <Button size="sm" variant="secondary" onClick={() => onOpen(saved.snapshot)}>
              <ChartLine size={14} aria-hidden="true" />
              Open in workbench
            </Button>
            <div className="link-form">
              <h4>
                <Share2 size={13} aria-hidden="true" /> Report link
              </h4>
              {saved.grant !== null ? (
                <div className="link-state">
                  <span className="published">
                    <Globe size={13} aria-hidden="true" /> Report linked
                  </span>
                  <Button
                    size="sm"
                    variant="secondary"
                    disabled={linkBusy}
                    onClick={() => void updateLink(null)}
                  >
                    Withdraw report
                  </Button>
                </div>
              ) : (
                <>
                  {withdrawn?.id === selected && (
                    <div className="link-state">
                      <span>Report withdrawn</span>
                      <Button
                        size="sm"
                        variant="secondary"
                        disabled={linkBusy}
                        onClick={() => void updateLink(withdrawn.grant, withdrawn.version)}
                      >
                        Undo
                      </Button>
                    </div>
                  )}
                  <form
                    onSubmit={(event) => {
                      event.preventDefault();
                      if (linkBusy) return;
                      void updateLink(grant.trim());
                    }}
                  >
                    <Field label="Report link ID" htmlFor="report-grant">
                      <Input
                        id="report-grant"
                        value={grant}
                        maxLength={128}
                        required
                        onChange={(event) => setGrant(event.target.value)}
                      />
                    </Field>
                    <Button type="submit" size="sm" variant="secondary" disabled={linkBusy}>
                      Link report
                    </Button>
                  </form>
                </>
              )}
              {!link.mutation.uncertain &&
                link.mutation.error &&
                link.sent?.input.id === selected && (
                  <Callout tone="danger">{link.mutation.error.message}</Callout>
                )}
            </div>
          </article>
        )}
      </div>
    </aside>
  );
}
