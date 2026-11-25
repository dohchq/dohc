import {
  useEffect,
  useRef,
  useState,
  type FormEvent,
  type MouseEvent,
  type ReactNode,
} from "react";
import { useApp } from "dohc/app";
import { Check, MessageSquare, Pencil, RotateCcw, Trash2 } from "dohc/icons";
import { errorMessage, readName, refusalCode, saveName, type Note, type PhotoSource } from "./api";
import { useToast } from "./toast";

const drafts = new Map<
  string,
  {
    spot: Draft;
    body: string;
    sent?: {
      key: string;
      body: string;
      authorName: string;
      known: ReadonlySet<string>;
      pending?: boolean;
      dismiss?: () => void;
    };
  }
>();
const lists = new Map<string, Note[]>();
const countsOf = (list: readonly Note[]) => ({
  noteCount: list.length,
  openNoteCount: list.filter((note) => !note.resolved).length,
});
const noteWrites = new Map<string, Promise<unknown>>();
const retryable = (error: unknown, retry: () => void) => (refusalCode(error) ? undefined : retry);

function inOrder<T>(noteId: string, work: () => Promise<T>): Promise<T> {
  const run = (noteWrites.get(noteId) ?? Promise.resolve()).then(work);
  const settled = run.then(
    () => undefined,
    () => undefined,
  );
  noteWrites.set(noteId, settled);
  void settled.then(() => {
    if (noteWrites.get(noteId) === settled) noteWrites.delete(noteId);
  });
  return run;
}

export interface NoteRules {
  load(photo: PhotoSource): Promise<Note[]>;
  add?(
    photo: PhotoSource,
    draft: { xPct: number; yPct: number; authorName: string; body: string },
    key: string,
  ): Promise<Note>;
  resolve?(note: Note, resolved: boolean): Promise<void>;
  update?(note: Note, body: string): Promise<Note>;
  remove?(note: Note): Promise<void>;
  restore?(note: Note): Promise<Note>;
  counted?(assetId: string, counts: { noteCount: number; openNoteCount: number }): void;
  closedReason?: string;
  authorName?: string;
  tick?: number;
}

export interface Draft {
  readonly xPct: number;
  readonly yPct: number;
}

export interface NotesState {
  readonly list: readonly Note[] | null;
  readonly error: string | null;
  readonly hovered: string | null;
  readonly selected: { readonly id: string } | null;
  readonly draft: Draft | null;
  readonly draftFresh: boolean;
  readonly canPin: boolean;
  readonly rules: NoteRules;
  readonly showResolved: boolean;
  setShowResolved(show: boolean): void;
  setHovered(id: string | null): void;
  select(id: string): void;
  setDraft(draft: Draft | null): void;
  readonly photoId: string;
  readonly draftBody: string;
  readonly pinning: boolean;
  keepDraft(body: string, authorName: string): void;
  reload(): void;
  add(body: string, authorName: string): Promise<boolean>;
  resolve(note: Note): void;
  edit(note: Note, body: string, view: EditView): Promise<void>;
  cancelEdit(note: Note): void;
  remove(note: Note): void;
}

interface EditView {
  saving(on: boolean): void;
  done(): void;
}

export function pointOn(event: MouseEvent<HTMLElement>, element: HTMLElement): Draft | null {
  const rect = element.getBoundingClientRect();
  if (rect.width <= 0 || rect.height <= 0) return null;
  const clamp = (value: number) => Math.min(100, Math.max(0, Math.round(value * 10000) / 100));
  return {
    xPct: clamp((event.clientX - rect.left) / rect.width),
    yPct: clamp((event.clientY - rect.top) / rect.height),
  };
}

export function useNotes(photo: PhotoSource, rules: NoteRules, enabled = true): NotesState {
  const client = useApp();
  const toast = useToast();
  const [state, setState] = useState<{ id: string; list?: Note[]; error?: string }>({ id: "" });
  const [hovered, setHovered] = useState<string | null>(null);
  const [selected, setSelected] = useState<{ id: string } | null>(null);
  const [, setDraftTick] = useState(0);
  const placed = useRef<Draft | null>(null);
  const [showResolved, setShowResolved] = useState(true);
  const [version, setVersion] = useState(0);
  const changes = useRef(0);
  const failures = useRef(new Map<string, () => void>());
  const turns = useRef(new Map<string, number>());
  const rulesRef = useRef(rules);
  rulesRef.current = rules;
  const photoRef = useRef(photo);
  photoRef.current = photo;

  useEffect(() => {
    const open = failures.current;
    return () => {
      for (const dismiss of open.values()) dismiss();
    };
  }, []);

  useEffect(() => {
    if (!enabled) return;
    let current = true;
    const started = changes.current;
    rulesRef.current.load(photoRef.current).then(
      (list) => {
        if (!current) return;
        if (changes.current === started) setState({ id: photo.id, list });
        else setVersion((value) => value + 1);
      },
      (error: unknown) =>
        current &&
        setState((previous) => ({
          id: photo.id,
          list: previous.id === photo.id ? previous.list : undefined,
          error: errorMessage(error),
        })),
    );
    return () => {
      current = false;
    };
  }, [photo.id, version, enabled, rules.tick]);

  useEffect(() => {
    placed.current = null;
    setHovered(null);
    setSelected(null);
  }, [photo.id]);

  useEffect(() => {
    if (!enabled || !client.subscribe) return;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const stop = client.subscribe(() => {
      clearTimeout(timer);
      timer = setTimeout(() => setVersion((value) => value + 1), 300);
    });
    return () => {
      clearTimeout(timer);
      stop();
    };
  }, [client, enabled]);

  useEffect(() => {
    if (!state.list) return;
    lists.set(state.id, state.list);
    rulesRef.current.counted?.(state.id, countsOf(state.list));
    const entry = drafts.get(state.id);
    const sent = entry?.sent;
    if (!entry || !sent) return;
    const landed = state.list.some(
      (note) =>
        note.mine &&
        !sent.known.has(note.id) &&
        note.body === sent.body.trim() &&
        note.authorName === sent.authorName.trim() &&
        Math.abs(note.xPct - entry.spot.xPct) < 0.5 &&
        Math.abs(note.yPct - entry.spot.yPct) < 0.5,
    );
    if (!landed) return;
    sent.dismiss?.();
    if (entry.body.trim() !== sent.body.trim()) {
      entry.sent = undefined;
      return;
    }
    drafts.delete(state.id);
    if (placed.current === entry.spot) placed.current = null;
    setDraftTick((tick) => tick + 1);
  }, [state]);

  const matched = state.id === photo.id;
  const list = matched
    ? (state.list ?? lists.get(photo.id) ?? null)
    : (lists.get(photo.id) ?? null);
  const canPin = Boolean(rules.add) && !rules.closedReason;
  const draft = canPin ? (drafts.get(photo.id)?.spot ?? null) : null;

  const pin = async (
    target: PhotoSource,
    spot: Draft,
    body: string,
    authorName: string,
    key: string = crypto.randomUUID(),
  ): Promise<boolean> => {
    const add = rulesRef.current.add;
    if (!add) return false;
    const sending = drafts.get(target.id)?.sent;
    const mark = (on: boolean) => {
      if (sending?.key !== key) return;
      sending.pending = on;
      setDraftTick((tick) => tick + 1);
    };
    mark(true);
    try {
      const note = await add(target, { ...spot, authorName, body }, key);
      saveName(authorName);
      swap(target.id, (list) => [...list.filter((item) => item.id !== note.id), note]);
      const entry = drafts.get(target.id);
      const cleared = entry?.sent?.key === key;
      if (cleared) {
        entry.sent?.dismiss?.();
        drafts.delete(target.id);
      }
      setDraftTick((tick) => tick + 1);
      return cleared;
    } catch (error) {
      const sent = drafts.get(target.id)?.sent;
      if (sent?.key !== key) return false;
      sent.dismiss = toast(`Could not pin the note. ${errorMessage(error)}`, {
        tone: "danger",
        retry: retryable(error, () => void pin(target, spot, body, authorName, key)),
      });
      return false;
    } finally {
      mark(false);
    }
  };

  const swap = (assetId: string, change: (list: Note[]) => Note[]) => {
    changes.current += 1;
    setState((current) =>
      current.id === assetId ? { ...current, list: change(current.list ?? []) } : current,
    );
    const cached = lists.get(assetId);
    if (!cached || photoRef.current.id === assetId) return;
    const next = change(cached);
    lists.set(assetId, next);
    rulesRef.current.counted?.(assetId, countsOf(next));
  };

  const takeTurn = (key: string) => {
    const turn = (turns.current.get(key) ?? 0) + 1;
    turns.current.set(key, turn);
    failures.current.get(key)?.();
    failures.current.delete(key);
    return () => turns.current.get(key) === turn;
  };

  const edit = async (note: Note, body: string, view: EditView): Promise<void> => {
    const update = rulesRef.current.update;
    if (!update) return;
    const key = `edit:${note.id}`;
    const latest = takeTurn(key);
    view.saving(true);
    try {
      const saved = await inOrder(note.id, () => update(note, body));
      if (!latest()) {
        setVersion((value) => value + 1);
        return;
      }
      swap(note.assetId, (list) =>
        list.map((item) => (item.id === note.id ? { ...item, body: saved.body } : item)),
      );
      view.done();
    } catch (error) {
      if (!latest()) return;
      view.saving(false);
      failures.current.set(
        key,
        toast(`Could not save the note. ${errorMessage(error)}`, {
          tone: "danger",
          retry: retryable(error, () => void edit(note, body, view)),
        }),
      );
    }
  };

  const remove = async (note: Note) => {
    const drop = rulesRef.current.remove;
    if (!drop) return;
    takeTurn(`edit:${note.id}`);
    swap(note.assetId, (list) => list.filter((item) => item.id !== note.id));
    try {
      await inOrder(note.id, () => drop(note));
      swap(note.assetId, (list) => list.filter((item) => item.id !== note.id));
      if (rulesRef.current.restore) toast("Note deleted.", { undo: () => void restore(note) });
      else toast("Note deleted.");
    } catch (error) {
      putBack(note);
      toast(`Could not delete the note. ${errorMessage(error)}`, {
        tone: "danger",
        retry: retryable(error, () => void remove(note)),
      });
    }
  };

  const putBack = (note: Note) =>
    swap(note.assetId, (list) =>
      [...list.filter((item) => item.id !== note.id), note].sort(
        (a, b) => a.createdAtMs - b.createdAtMs || a.id.localeCompare(b.id),
      ),
    );

  const restore = async (note: Note) => {
    const back = rulesRef.current.restore;
    if (!back) return;
    try {
      putBack(await inOrder(note.id, () => back(note)));
    } catch (error) {
      toast(`Could not restore the note. ${errorMessage(error)}`, {
        tone: "danger",
        retry: retryable(error, () => void restore(note)),
      });
    }
  };

  const resolve = async (note: Note) => {
    const save = rulesRef.current.resolve;
    if (!save) return;
    const key = `resolve:${note.id}`;
    const latest = takeTurn(key);
    const resolved = !note.resolved;
    const flip = (value: boolean) =>
      swap(note.assetId, (list) =>
        list.map((item) => (item.id === note.id ? { ...item, resolved: value } : item)),
      );
    flip(resolved);
    try {
      await inOrder(note.id, () => save(note, resolved));
      if (latest()) flip(resolved);
    } catch (error) {
      if (!latest()) return;
      flip(!resolved);
      setVersion((value) => value + 1);
      failures.current.set(
        key,
        toast(errorMessage(error), {
          tone: "danger",
          retry: retryable(error, () => void resolve({ ...note, resolved: !resolved })),
        }),
      );
    }
  };

  return {
    list,
    error: matched ? (state.error ?? null) : null,
    hovered,
    selected,
    draft,
    draftFresh: draft !== null && draft === placed.current,
    canPin,
    rules,
    showResolved,
    setShowResolved,
    setHovered,
    select: (id) => {
      setHovered(id);
      setSelected({ id });
    },
    setDraft: (next) => {
      drafts.get(photo.id)?.sent?.dismiss?.();
      const spot = canPin ? next : null;
      if (spot) drafts.set(photo.id, { spot, body: drafts.get(photo.id)?.body ?? "" });
      else drafts.delete(photo.id);
      placed.current = spot;
      setDraftTick((tick) => tick + 1);
    },
    photoId: photo.id,
    draftBody: drafts.get(photo.id)?.body ?? "",
    pinning: Boolean(drafts.get(photo.id)?.sent?.pending),
    keepDraft: (body, authorName) => {
      const saved = drafts.get(photoRef.current.id);
      if (!saved) return;
      saved.body = body;
      if (
        saved.sent &&
        (saved.sent.body !== body.trim() || saved.sent.authorName !== authorName.trim())
      ) {
        saved.sent.dismiss?.();
        saved.sent.dismiss = undefined;
      }
    },
    reload: () => setVersion((value) => value + 1),
    resolve: (note) => void resolve(note),
    edit,
    cancelEdit: (note) => void takeTurn(`edit:${note.id}`),
    remove: (note) => void remove(note),
    add: (body, authorName) => {
      const entry = drafts.get(photoRef.current.id);
      if (!draft || !entry) return Promise.resolve(false);
      const same =
        entry.sent?.body === body && entry.sent.authorName === authorName ? entry.sent : undefined;
      if (!same) entry.sent?.dismiss?.();
      entry.sent = same ?? {
        key: crypto.randomUUID(),
        body,
        authorName,
        known: new Set((list ?? []).map((note) => note.id)),
      };
      const key = entry.sent.key;
      return pin(photoRef.current, entry.spot, body, authorName, key);
    },
  };
}

export function Pins({ notes, scale = 1 }: { notes: NotesState; scale?: number }) {
  const list = notes.list ?? [];
  const showResolved = notes.showResolved;
  return (
    <>
      {list.map((note, position) =>
        !showResolved && note.resolved ? null : (
          <button
            key={note.id}
            type="button"
            className={`lb-pin${note.resolved ? " lb-pin-resolved" : ""}${notes.hovered === note.id ? " lb-pin-hot" : ""}`}
            style={{
              left: `${note.xPct}%`,
              top: `${note.yPct}%`,
              ["--lb-pin-scale" as string]: String(1 / scale),
            }}
            aria-label={`Note ${position + 1} by ${note.authorName}: ${note.body}`}
            data-pin={position + 1}
            onMouseEnter={() => notes.setHovered(note.id)}
            onMouseLeave={() => notes.setHovered(null)}
            onFocus={() => notes.setHovered(note.id)}
            onBlur={() => notes.setHovered(null)}
            onPointerDown={(event) => event.stopPropagation()}
            onClick={(event) => {
              event.stopPropagation();
              notes.select(note.id);
            }}
          >
            {position + 1}
          </button>
        ),
      )}
      {notes.draft ? (
        <span
          className={`lb-pin lb-pin-draft${notes.draftFresh ? " lb-pin-drop" : ""}`}
          style={{
            left: `${notes.draft.xPct}%`,
            top: `${notes.draft.yPct}%`,
            ["--lb-pin-scale" as string]: String(1 / scale),
          }}
          aria-hidden="true"
        >
          {list.length + 1}
        </span>
      ) : null}
    </>
  );
}

function Composer({ notes, number }: { notes: NotesState; number: number }) {
  const [body, setBody] = useState(notes.draftBody);
  const fixedName = notes.rules.authorName;
  const [name, setName] = useState(() => fixedName ?? readName());
  const saving = notes.pinning;
  const bodyRef = useRef<HTMLTextAreaElement | null>(null);
  useEffect(() => {
    (name.trim() ? bodyRef.current : document.getElementById("note-name"))?.focus();
  }, [notes.draft?.xPct, notes.draft?.yPct]);
  const submit = async (event: FormEvent) => {
    event.preventDefault();
    if (!body.trim() || !name.trim() || saving) return;
    const saved = await notes.add(body.trim(), name.trim());
    if (saved) setBody("");
  };
  return (
    <form
      className="lb-composer"
      onSubmit={submit}
      onKeyDown={(event) => {
        if (event.key === "Escape") {
          event.stopPropagation();
          notes.setDraft(null);
        }
        if (event.key === "Enter" && (event.metaKey || event.ctrlKey)) void submit(event);
      }}
    >
      <div className="lb-composer-head">
        <span className="lb-pin lb-pin-inline" aria-hidden="true">
          {number}
        </span>
        <span>New note</span>
      </div>
      {fixedName ? null : (
        <>
          <label className="lb-field-label" htmlFor="note-name">
            Your name
          </label>
          <input
            id="note-name"
            className="lb-field"
            value={name}
            maxLength={80}
            autoComplete="name"
            readOnly={saving}
            onChange={(event) => {
              setName(event.target.value);
              notes.keepDraft(body, event.target.value);
            }}
          />
        </>
      )}
      <label className="lb-field-label" htmlFor="note-body">
        Note
      </label>
      <textarea
        id="note-body"
        className="lb-field"
        ref={bodyRef}
        rows={3}
        maxLength={1000}
        placeholder="What should change here?"
        readOnly={saving}
        value={body}
        onChange={(event) => {
          setBody(event.target.value);
          notes.keepDraft(event.target.value, name);
        }}
      />
      <div className="lb-composer-actions">
        <button
          type="button"
          className="lb-button lb-button-quiet"
          onClick={() => notes.setDraft(null)}
        >
          Cancel
        </button>
        <button
          type="submit"
          className="lb-button lb-button-solid"
          id="note-save"
          disabled={saving || !body.trim() || !name.trim()}
        >
          {saving ? "Pinning…" : "Pin note"}
        </button>
      </div>
    </form>
  );
}

function NoteEditor({ notes, note, onDone }: { notes: NotesState; note: Note; onDone(): void }) {
  const [body, setBody] = useState(note.body);
  const [saving, setSaving] = useState(false);
  const save = (event: FormEvent) => {
    event.preventDefault();
    if (!body.trim() || saving) return;
    void notes.edit(note, body.trim(), { saving: setSaving, done: onDone });
  };
  return (
    <form
      className="lb-note-edit"
      onSubmit={save}
      onKeyDown={(event) => {
        if (event.key === "Escape") {
          event.stopPropagation();
          notes.cancelEdit(note);
          onDone();
        }
        if (event.key === "Enter" && (event.metaKey || event.ctrlKey)) save(event);
      }}
    >
      <textarea
        className="lb-field"
        rows={3}
        maxLength={1000}
        value={body}
        readOnly={saving}
        autoFocus
        aria-label="Edit note"
        onChange={(event) => {
          setBody(event.target.value);
          notes.cancelEdit(note);
        }}
      />
      <div className="lb-composer-actions">
        <button
          type="button"
          className="lb-button lb-button-quiet"
          onClick={() => {
            notes.cancelEdit(note);
            onDone();
          }}
        >
          Cancel
        </button>
        <button
          type="submit"
          className="lb-button lb-button-solid"
          disabled={saving || !body.trim()}
        >
          {saving ? "Saving…" : "Save"}
        </button>
      </div>
    </form>
  );
}

export function NoteRail({
  notes,
  hint,
  header,
}: {
  notes: NotesState;
  hint: ReactNode;
  header?: ReactNode;
}) {
  const showResolved = notes.showResolved;
  const [editing, setEditing] = useState<string | null>(null);
  const canChange = Boolean(notes.rules.update) && !notes.rules.closedReason;
  const rail = useRef<HTMLElement | null>(null);
  const list = notes.list ?? [];
  const resolvedCount = list.filter((note) => note.resolved).length;
  useEffect(() => {
    if (notes.selected)
      document.getElementById(`note-${notes.selected.id}`)?.scrollIntoView({
        block: "nearest",
        behavior: matchMedia("(prefers-reduced-motion: reduce)").matches ? "auto" : "smooth",
      });
  }, [notes.selected]);
  return (
    <section className="lb-rail-notes" aria-label="Notes" ref={rail} tabIndex={-1}>
      <div className="lb-notes-head">
        {header ?? (
          <h2>
            Notes <span className="lb-count">{list.length || ""}</span>
          </h2>
        )}
        {resolvedCount ? (
          <button
            type="button"
            className="lb-text-button"
            onClick={() => notes.setShowResolved(!showResolved)}
          >
            {showResolved ? `Hide ${resolvedCount} resolved` : `Show ${resolvedCount} resolved`}
          </button>
        ) : null}
      </div>
      {notes.error && !notes.list ? (
        <div className="lb-notes-empty" role="alert">
          <p>{notes.error}</p>
          <button type="button" className="lb-button" onClick={notes.reload}>
            Try again
          </button>
        </div>
      ) : !notes.list ? (
        <div className="lb-notes-loading" aria-hidden="true">
          <span />
          <span />
        </div>
      ) : (
        <ol className="lb-notes">
          {list.map((note, position) =>
            !showResolved && note.resolved ? null : (
              <li
                key={note.id}
                id={`note-${note.id}`}
                className={`lb-note${notes.hovered === note.id ? " lb-note-hot" : ""}${note.resolved ? " lb-note-resolved" : ""}`}
                onMouseEnter={() => notes.setHovered(note.id)}
                onMouseLeave={() => notes.setHovered(null)}
              >
                <span className="lb-pin lb-pin-inline" aria-hidden="true">
                  {position + 1}
                </span>
                <div className="lb-note-body">
                  <div className="lb-note-meta">
                    <strong>{note.authorName}</strong>
                    {note.mine ? <span className="lb-note-mine">You</span> : null}
                    <time dateTime={new Date(note.createdAtMs).toISOString()}>
                      {new Date(note.createdAtMs).toLocaleDateString(undefined, {
                        month: "short",
                        day: "numeric",
                      })}
                    </time>
                  </div>
                  {canChange && editing === note.id ? (
                    <NoteEditor
                      notes={notes}
                      note={note}
                      onDone={() => setEditing((current) => (current === note.id ? null : current))}
                    />
                  ) : (
                    <p>{note.body}</p>
                  )}
                </div>
                {note.mine && canChange && editing !== note.id ? (
                  <span className="lb-note-own">
                    <button
                      type="button"
                      className="lb-icon-button"
                      aria-label={`Edit note ${position + 1}`}
                      title="Edit"
                      onClick={() => setEditing(note.id)}
                    >
                      <Pencil size={13} />
                    </button>
                    <button
                      type="button"
                      className="lb-icon-button"
                      aria-label={`Delete note ${position + 1}`}
                      title="Delete"
                      onClick={() => {
                        rail.current?.focus();
                        notes.remove(note);
                      }}
                    >
                      <Trash2 size={13} />
                    </button>
                  </span>
                ) : null}
                {notes.rules.resolve ? (
                  <button
                    type="button"
                    className={`lb-icon-button lb-resolve${note.resolved ? " lb-resolve-on" : ""}`}
                    aria-label={
                      note.resolved ? `Reopen note ${position + 1}` : `Resolve note ${position + 1}`
                    }
                    title={note.resolved ? "Reopen" : "Resolve"}
                    onClick={() => notes.resolve(note)}
                  >
                    {note.resolved ? <RotateCcw size={14} /> : <Check size={14} />}
                  </button>
                ) : note.resolved ? (
                  <span className="lb-note-state">Resolved</span>
                ) : null}
              </li>
            ),
          )}
          {list.length === 0 ? (
            <li className="lb-notes-empty">
              <MessageSquare size={16} />
              <span>
                {notes.draft
                  ? "Your note will show here once you pin it."
                  : "No notes on this photo."}
              </span>
            </li>
          ) : !showResolved && resolvedCount === list.length ? (
            <li className="lb-notes-empty">
              <Check size={16} />
              <span>
                {resolvedCount === 1
                  ? "The only note here is resolved."
                  : `All ${resolvedCount} notes here are resolved.`}
              </span>
            </li>
          ) : null}
        </ol>
      )}
      {notes.draft ? (
        <Composer key={notes.photoId} notes={notes} number={list.length + 1} />
      ) : (
        <p className="lb-notes-hint">{notes.rules.closedReason ?? hint}</p>
      )}
    </section>
  );
}
