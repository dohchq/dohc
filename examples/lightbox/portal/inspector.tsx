import { useEffect, useLayoutEffect, useRef, useState, type FormEvent, type KeyboardEvent, type ReactNode } from "react";
import { Button, Input } from "dohc/ui";
import { errorMessage, isTyping, readName, saveName, type Note, type PhotoSource } from "./api";
import { Photo, type FileAccess } from "./photo";
import { useToast } from "./toast";

export interface NoteRules {
  load(photo: PhotoSource): Promise<Note[]>;
  add?(photo: PhotoSource, draft: { xPct: number; yPct: number; authorName: string; body: string }): Promise<Note>;
  resolve?(note: Note, resolved: boolean): Promise<void>;
  closedReason?: string;
  askName: boolean;
  fixedName?: string;
}

interface Draft {
  readonly xPct: number;
  readonly yPct: number;
}

function useSize(ref: { current: HTMLElement | null }) {
  const [size, setSize] = useState({ width: 0, height: 0 });
  useLayoutEffect(() => {
    const element = ref.current;
    if (!element) return;
    const update = () => setSize({ width: element.clientWidth, height: element.clientHeight });
    update();
    const observer = new ResizeObserver(update);
    observer.observe(element);
    return () => observer.disconnect();
  }, [ref]);
  return size;
}

function fit(photo: PhotoSource, box: { width: number; height: number }) {
  const ratio = photo.width / photo.height;
  const width = Math.max(0, Math.min(box.width, box.height * ratio));
  return { width, height: width / ratio };
}

interface NumberedNote {
  readonly note: Note;
  readonly number: number;
}

function Stage({
  photo,
  access,
  notes,
  nextNumber,
  hovered,
  onHover,
  draft,
  onDraft,
  showPins,
  canPin,
}: {
  photo: PhotoSource;
  access: FileAccess;
  notes: readonly NumberedNote[];
  nextNumber: number;
  hovered: string | null;
  onHover(id: string | null): void;
  draft: Draft | null;
  onDraft(draft: Draft): void;
  showPins: boolean;
  canPin: boolean;
}) {
  const box = useRef<HTMLDivElement | null>(null);
  const size = fit(photo, useSize(box));
  return (
    <div className="lb-stage-box" ref={box}>
      <div
        className={`lb-canvas${canPin ? " lb-canvas-pinnable" : ""}`}
        style={{ width: size.width, height: size.height }}
        onClick={(event) => {
          if (!canPin || event.target !== event.currentTarget.firstElementChild) return;
          const rect = event.currentTarget.getBoundingClientRect();
          if (rect.width <= 0 || rect.height <= 0) return;
          const clamp = (value: number) => Math.min(100, Math.max(0, Math.round(value * 10000) / 100));
          onDraft({
            xPct: clamp((event.clientX - rect.left) / rect.width),
            yPct: clamp((event.clientY - rect.top) / rect.height),
          });
        }}
      >
        <Photo photo={photo} access={access} size="full" className="lb-canvas-photo" />
        {showPins
          ? notes.map(({ note, number }) => (
              <button
                key={note.id}
                type="button"
                className={`lb-pin${note.resolved ? " lb-pin-resolved" : ""}${hovered === note.id ? " lb-pin-hot" : ""}`}
                style={{ left: `${note.xPct}%`, top: `${note.yPct}%` }}
                aria-label={`Note ${number} by ${note.authorName}: ${note.body}`}
                data-pin={number}
                onMouseEnter={() => onHover(note.id)}
                onMouseLeave={() => onHover(null)}
                onFocus={() => onHover(note.id)}
                onBlur={() => onHover(null)}
                onClick={() => document.getElementById(`note-${note.id}`)?.scrollIntoView({ block: "nearest" })}
              >
                {number}
              </button>
            ))
          : null}
        {draft ? (
          <span className="lb-pin lb-pin-draft" style={{ left: `${draft.xPct}%`, top: `${draft.yPct}%` }} aria-hidden="true">
            {nextNumber}
          </span>
        ) : null}
      </div>
    </div>
  );
}

export function Inspector<T extends PhotoSource & { readonly mimeType?: string }>({
  items,
  index,
  onIndex,
  onClose,
  access,
  rules,
  controls,
  caption,
  onKey,
  eyebrow,
}: {
  items: readonly T[];
  index: number;
  onIndex(index: number): void;
  onClose(): void;
  access: FileAccess;
  rules: NoteRules;
  controls(item: T): ReactNode;
  caption(item: T): ReactNode;
  onKey(event: KeyboardEvent | globalThis.KeyboardEvent, item: T): boolean;
  eyebrow: string;
}) {
  const toast = useToast();
  const photo = items[index]!;
  const [compare, setCompare] = useState<number | null>(null);
  const second = compare !== null ? items[compare] : undefined;
  const active = second ?? photo;
  const [notes, setNotes] = useState<{ id: string; list?: Note[]; error?: string }>({ id: "" });
  const [hovered, setHovered] = useState<string | null>(null);
  const [draft, setDraft] = useState<Draft | null>(null);
  const [body, setBody] = useState("");
  const [name, setName] = useState(readName);
  const [saving, setSaving] = useState(false);
  const [showResolved, setShowResolved] = useState(true);
  const [reload, setReload] = useState(0);
  const draftGen = useRef(0);
  const root = useRef<HTMLDivElement | null>(null);
  const bodyRef = useRef<HTMLTextAreaElement | null>(null);
  const rulesRef = useRef(rules);
  rulesRef.current = rules;

  const updateDraft = (next: Draft | null) => {
    draftGen.current++;
    setDraft(next);
    setSaving(false);
  };

  useEffect(() => {
    let current = true;
    rulesRef.current.load(active).then(
      (list) => current && setNotes({ id: active.id, list }),
      (error: unknown) => current && setNotes({ id: active.id, error: errorMessage(error) }),
    );
    draftGen.current++;
    setDraft(null);
    setBody("");
    setSaving(false);
    return () => {
      current = false;
    };
  }, [active.id, reload]);

  useEffect(() => {
    root.current?.focus();
  }, []);

  useEffect(() => {
    if (draft) bodyRef.current?.focus();
  }, [draft]);

  const list = notes.id === active.id ? (notes.list ?? []) : [];
  const numbered: NumberedNote[] = list.map((note, position) => ({ note, number: position + 1 }));
  const visible = showResolved ? numbered : numbered.filter(({ note }) => !note.resolved);
  const canPin = Boolean(rules.add) && !rules.closedReason && compare === null;
  const toggleCompare = () => {
    if (items.length < 2) return;
    setCompare(compare === null ? (index + 1 < items.length ? index + 1 : index - 1) : null);
  };
  const stepCompare = (from: number, delta: -1 | 1): number | null => {
    let next = from + delta;
    if (next === index) next += delta;
    return next >= 0 && next < items.length ? next : null;
  };
  const go = (next: number) => {
    if (next < 0 || next >= items.length) return;
    if (compare !== null) {
      if (next !== index) setCompare(next);
    } else onIndex(next);
  };
  const step = (delta: -1 | 1) => {
    if (compare !== null) {
      const next = stepCompare(compare, delta);
      if (next !== null) setCompare(next);
    } else {
      go(index + delta);
    }
  };
  const canPrev = compare !== null ? stepCompare(compare, -1) !== null : index > 0;
  const canNext = compare !== null ? stepCompare(compare, 1) !== null : index < items.length - 1;

  const keyDown = (event: KeyboardEvent<HTMLDivElement>) => {
    if (isTyping(event.target)) {
      if (event.key === "Escape") {
        updateDraft(null);
        root.current?.focus();
      }
      return;
    }
    const onControl =
      event.target instanceof HTMLElement && Boolean(event.target.closest("button, a, [role='button'], [role='radio']"));
    if (onControl && (event.key === " " || event.key === "Enter")) return;
    if (event.key === "Escape") {
      if (draft) updateDraft(null);
      else if (compare !== null) setCompare(null);
      else onClose();
    } else if (event.key === "ArrowRight") step(1);
    else if (event.key === "ArrowLeft") step(-1);
    else if (event.key.toLowerCase() === "c") toggleCompare();
    else if (event.key.toLowerCase() === "n" && canPin) updateDraft({ xPct: 50, yPct: 50 });
    else if (!onKey(event, active)) return;
    event.preventDefault();
  };

  const submit = async (event: FormEvent) => {
    event.preventDefault();
    if (!draft || !rules.add) return;
    const authorName = rules.fixedName ?? name.trim();
    if (!authorName || !body.trim()) return;
    const gen = draftGen.current;
    const targetId = active.id;
    const pendingDraft = draft;
    const trimmedBody = body.trim();
    const expectedCount = list.length + 1;
    setSaving(true);
    try {
      const note = await rules.add(active, { ...pendingDraft, authorName, body: trimmedBody });
      if (!rules.fixedName) saveName(authorName);
      setNotes((current) => (current.id === targetId ? { id: targetId, list: [...(current.list ?? []), note] } : current));
      toast(`Note ${expectedCount} pinned.`);
      if (draftGen.current === gen) {
        updateDraft(null);
        setBody("");
        root.current?.focus();
      }
    } catch (error) {
      toast(errorMessage(error), { tone: "danger" });
    } finally {
      if (draftGen.current === gen) setSaving(false);
    }
  };

  const resolve = async (note: Note) => {
    if (!rules.resolve) return;
    const resolved = !note.resolved;
    const flip = (value: boolean) =>
      setNotes((current) =>
        current.id === note.assetId
          ? { ...current, list: current.list?.map((item) => (item.id === note.id ? { ...item, resolved: value } : item)) }
          : current,
      );
    flip(resolved);
    try {
      await rules.resolve(note, resolved);
    } catch (error) {
      flip(!resolved);
      toast(errorMessage(error), { tone: "danger", retry: () => void resolve(note) });
    }
  };

  return (
    <div
      className="lb-inspector"
      role="dialog"
      aria-modal="true"
      aria-label={`${photo.title}, photo ${index + 1} of ${items.length}`}
      tabIndex={-1}
      ref={root}
      onKeyDown={keyDown}
    >
      <header className="lb-inspector-bar">
        <div className="lb-inspector-title">
          <span className="lb-eyebrow">{eyebrow}</span>
          <strong>{second ? `${photo.title} ↔ ${second.title}` : photo.title}</strong>
          <span className="lb-count">
            {(compare ?? index) + 1} / {items.length}
          </span>
        </div>
        <div className="lb-inspector-actions">
          <Button size="sm" variant="ghost" onClick={() => step(-1)} disabled={!canPrev} aria-label="Previous photo">
            ←
          </Button>
          <Button
            size="sm"
            variant="ghost"
            onClick={() => step(1)}
            disabled={!canNext}
            aria-label="Next photo"
          >
            →
          </Button>
          <Button
            size="sm"
            variant={compare !== null ? "primary" : "secondary"}
            aria-pressed={compare !== null}
            id="compare-toggle"
            disabled={items.length < 2}
            onClick={toggleCompare}
          >
            Compare
          </Button>
          <Button size="sm" onClick={onClose} id="inspector-close">
            Close
          </Button>
        </div>
      </header>
      <div className="lb-inspector-body">
        {second ? (
          <div className="lb-compare">
            {[photo, second].map((item, side) => (
              <figure className="lb-compare-pane" key={side}>
                <div className="lb-stage lb-stage-compare">
                  <Stage
                    photo={item}
                    access={access}
                    notes={[]}
                    nextNumber={1}
                    hovered={null}
                    onHover={() => undefined}
                    draft={null}
                    onDraft={() => undefined}
                    showPins={false}
                    canPin={false}
                  />
                  <span className="lb-compare-tag">{side === 0 ? "A" : "B"}</span>
                </div>
                <figcaption className="lb-compare-caption">
                  <strong>{item.title}</strong>
                  {caption(item as T)}
                </figcaption>
              </figure>
            ))}
          </div>
        ) : (
          <div className="lb-stage">
            <Stage
              photo={photo}
              access={access}
              notes={visible}
              nextNumber={list.length + 1}
              hovered={hovered}
              onHover={setHovered}
              draft={draft}
              onDraft={updateDraft}
              showPins
              canPin={canPin}
            />
          </div>
        )}
        <aside className="lb-side" aria-label="Photo details">
          {second ? <span className="lb-eyebrow">Active · B · {active.title}</span> : null}
          <div className="lb-side-controls">{controls(active)}</div>
          <div className="lb-side-head">
            <h2>Notes {list.length ? <span className="lb-chip-count">{list.length}</span> : null}</h2>
            {list.some((note) => note.resolved) ? (
              <button type="button" className="lb-link" onClick={() => setShowResolved((value) => !value)}>
                {showResolved ? "Hide resolved" : "Show resolved"}
              </button>
            ) : null}
          </div>
          {notes.id === active.id && notes.error ? (
            <div className="lb-side-empty">
              <p>{notes.error}</p>
              <Button size="sm" onClick={() => setReload((value) => value + 1)}>
                Try again
              </Button>
            </div>
          ) : notes.id !== active.id ? (
            <p className="lb-side-empty">Loading notes…</p>
          ) : (
            <ol className="lb-notes">
              {list.map((note, number) =>
                !showResolved && note.resolved ? null : (
                  <li
                    key={note.id}
                    id={`note-${note.id}`}
                    className={`lb-note${hovered === note.id ? " lb-note-hot" : ""}${note.resolved ? " lb-note-resolved" : ""}`}
                    onMouseEnter={() => setHovered(note.id)}
                    onMouseLeave={() => setHovered(null)}
                  >
                    <span className="lb-note-number" aria-hidden="true">
                      {number + 1}
                    </span>
                    <div className="lb-note-body">
                      <div className="lb-note-meta">
                        <strong>{note.authorName}</strong>
                        <time dateTime={new Date(note.createdAtMs).toISOString()}>
                          {new Date(note.createdAtMs).toLocaleDateString(undefined, { month: "short", day: "numeric" })}
                        </time>
                        {note.resolved ? <span className="lb-resolved-tag">Resolved</span> : null}
                      </div>
                      <p>{note.body}</p>
                      {rules.resolve ? (
                        <button type="button" className="lb-link" onClick={() => void resolve(note)}>
                          {note.resolved ? "Reopen" : "Resolve"}
                        </button>
                      ) : null}
                    </div>
                  </li>
                ),
              )}
              {list.length === 0 ? <li className="lb-side-empty">No notes on this photo yet.</li> : null}
            </ol>
          )}
          {rules.add ? (
            draft ? (
              <form className="lb-composer" onSubmit={submit}>
                <span className="lb-composer-title">
                  <span className="lb-pin lb-pin-inline">{list.length + 1}</span> New note at {Math.round(draft.xPct)}%,{" "}
                  {Math.round(draft.yPct)}%
                </span>
                {rules.askName && !rules.fixedName ? (
                  <Input
                    id="note-name"
                    placeholder="Your name"
                    value={name}
                    maxLength={80}
                    onChange={(event) => setName(event.target.value)}
                    aria-label="Your name"
                  />
                ) : null}
                <textarea
                  className="kit-textarea"
                  id="note-body"
                  ref={bodyRef}
                  rows={3}
                  maxLength={1000}
                  placeholder="What should change here?"
                  value={body}
                  onChange={(event) => setBody(event.target.value)}
                  aria-label="Note"
                />
                <div className="lb-composer-actions">
                  <Button size="sm" variant="ghost" onClick={() => updateDraft(null)}>
                    Cancel
                  </Button>
                  <Button
                    size="sm"
                    variant="primary"
                    type="submit"
                    id="note-save"
                    loading={saving}
                    disabled={!body.trim() || !(rules.fixedName ?? name.trim())}
                  >
                    Pin note
                  </Button>
                </div>
              </form>
            ) : (
              <p className="lb-hint">
                {rules.closedReason ??
                  (compare !== null ? "Leave compare to pin notes." : "Click anywhere on the photo to pin a note, or press N.")}
              </p>
            )
          ) : null}
        </aside>
      </div>
      <nav className="lb-strip" aria-label="All photos">
        {items.map((item, position) => (
          <button
            key={item.id}
            type="button"
            className={`lb-strip-item${position === index ? " lb-strip-a" : ""}${position === compare ? " lb-strip-b" : ""}`}
            style={{ aspectRatio: `${item.width} / ${item.height}` }}
            aria-label={`Show ${item.title}`}
            aria-current={position === index ? "true" : undefined}
            onClick={() => go(position)}
          >
            <Photo photo={item} access={access} size="thumb" />
          </button>
        ))}
      </nav>
    </div>
  );
}
