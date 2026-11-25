import { useRef, useState, type FormEvent } from "react";
import { copyText, useApp } from "dohc/app";
import { toCsv } from "dohc/csv";
import { formatCents, parseCents } from "dohc/money";
import { Button, Callout, Field, Input, Modal } from "dohc/ui";
import {
  errorMessage,
  invoke,
  loadPages,
  useLoader,
  type Paged,
  type Shoot,
  type StudioAsset,
} from "./portal/api";
import { useToast } from "./portal/toast";
import { plural, UNDO_KEY } from "./studio-parts";

export function ShootForm({
  shoot,
  onClose,
  onSaved,
}: {
  shoot: Shoot | null;
  onClose(): void;
  onSaved(shoot: Shoot): void;
}) {
  const client = useApp();
  const [title, setTitle] = useState(shoot?.title ?? "");
  const [clientName, setClientName] = useState(shoot?.clientName ?? "");
  const [shotOn, setShotOn] = useState(shoot?.shotOn ?? new Date().toISOString().slice(0, 10));
  const [limit, setLimit] = useState(String(shoot?.selectionLimit ?? 20));
  const [rate, setRate] = useState(
    shoot?.internalRateCents ? formatCents(shoot.internalRateCents) : "",
  );
  const [error, setError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const submit = async (event: FormEvent) => {
    event.preventDefault();
    const internalRateCents = rate.trim() ? parseCents(rate) : 0;
    if (internalRateCents === null || internalRateCents < 0) {
      setError("Enter the rate as an amount, like 1,250.00.");
      return;
    }
    setSaving(true);
    setError(null);
    const fields = {
      title: title.trim(),
      clientName: clientName.trim(),
      shotOn,
      selectionLimit: Number(limit),
      internalRateCents,
    };
    try {
      onSaved(
        shoot
          ? await invoke<Shoot>(client, "updateShoot", { shootId: shoot.id, ...fields })
          : await invoke<Shoot>(client, "createShoot", fields),
      );
    } catch (failure) {
      setError(errorMessage(failure));
    } finally {
      setSaving(false);
    }
  };
  return (
    <Modal
      open
      title={shoot ? "Shoot settings" : "New shoot"}
      onClose={onClose}
      footer={
        <>
          <Button variant="ghost" onClick={onClose}>
            Cancel
          </Button>
          <Button
            variant="primary"
            type="submit"
            form="shoot-form"
            loading={saving}
            id="shoot-save"
          >
            {shoot ? "Save" : "Create shoot"}
          </Button>
        </>
      }
    >
      <form id="shoot-form" className="st-form" onSubmit={submit}>
        <Field label="Title" htmlFor="shoot-title">
          <Input
            id="shoot-title"
            required
            maxLength={120}
            value={title}
            onChange={(event) => setTitle(event.target.value)}
            autoFocus
          />
        </Field>
        <Field label="Client" htmlFor="shoot-client">
          <Input
            id="shoot-client"
            required
            maxLength={120}
            value={clientName}
            onChange={(event) => setClientName(event.target.value)}
          />
        </Field>
        <div className="st-form-row">
          <Field label="Shot on" htmlFor="shoot-day">
            <Input
              id="shoot-day"
              type="date"
              required
              value={shotOn}
              onChange={(event) => setShotOn(event.target.value)}
            />
          </Field>
          <Field label="Picks per reviewer" htmlFor="shoot-limit" hint="1 to 500">
            <Input
              id="shoot-limit"
              type="number"
              min={1}
              max={500}
              required
              value={limit}
              onChange={(event) => setLimit(event.target.value)}
            />
          </Field>
        </div>
        <Field
          label="Your rate"
          htmlFor="shoot-rate"
          hint="Private. The client gallery never loads it."
        >
          <Input
            id="shoot-rate"
            inputMode="decimal"
            placeholder={formatCents(0)}
            value={rate}
            onChange={(event) => setRate(event.target.value)}
            onBlur={() => {
              const cents = parseCents(rate);
              if (cents !== null && cents >= 0) setRate(formatCents(cents));
            }}
          />
        </Field>
        {error ? <Callout tone="danger">{error}</Callout> : null}
      </form>
    </Modal>
  );
}

type PickList = {
  title: string;
  clientName: string;
  selectionLimit: number;
  reviewerCount: number;
  picks: Array<[string, number]>;
};

export function FinalPicks({ shoot, onClose }: { shoot: Shoot; onClose(): void }) {
  const toast = useToast();
  const area = useRef<HTMLTextAreaElement | null>(null);
  const [format, setFormat] = useState<"lightroom" | "captureone" | "lines">("lightroom");
  const picks = useLoader<PickList>(`export:${shoot.id}`, (client) =>
    loadPages(
      client,
      "exportFinalPicksList",
      { shootId: shoot.id },
      (page: Paged<"picks", PickList["picks"][number]> & Omit<PickList, "picks">) => page.picks,
    ).then(({ items, first: { nextCursor: _cursor, ...first } }) => ({ ...first, picks: items })),
  );
  const names = picks.data?.picks.map(([title]) => title) ?? [];
  const text =
    format === "lightroom"
      ? names.join(", ")
      : format === "captureone"
        ? names.join(" ")
        : names.join("\n");
  const copy = () =>
    void copyText(text).then(
      () => toast(`Copied ${plural(names.length, "file name")}.`),
      () => {
        area.current?.focus();
        area.current?.select();
        toast("Selected the list. Press Ctrl+C or Cmd+C to copy it.");
      },
    );
  const download = () => {
    if (!picks.data) return;
    const csv = toCsv([["File", "Picks"], ...picks.data.picks]);
    const url = URL.createObjectURL(new Blob([csv], { type: "text/csv" }));
    const link = document.createElement("a");
    link.href = url;
    link.download = `${shoot.title.replace(/[^\w-]+/g, "-").toLowerCase()}-picks.csv`;
    link.click();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
  };
  return (
    <Modal
      open
      title="Final picks"
      onClose={onClose}
      footer={
        <>
          <Button variant="ghost" onClick={download} disabled={!names.length}>
            Download CSV
          </Button>
          <Button variant="primary" onClick={copy} disabled={!names.length}>
            Copy file names
          </Button>
        </>
      }
    >
      {picks.error ? (
        <Callout tone="danger" action={<Button onClick={picks.reload}>Try again</Button>}>
          {errorMessage(picks.error)}
        </Callout>
      ) : !picks.data ? (
        <div className="st-dialog-loading" aria-hidden="true" />
      ) : names.length ? (
        <div className="st-picks">
          <p className="st-picks-summary">
            {plural(names.length, "photo")} sent by {plural(picks.data.reviewerCount, "reviewer")}{" "}
            for {picks.data.clientName}.
          </p>
          <div className="st-segment" role="radiogroup" aria-label="Format">
            {(
              [
                ["lightroom", "Lightroom"],
                ["captureone", "Capture One"],
                ["lines", "One per line"],
              ] as const
            ).map(([id, label]) => (
              <button
                key={id}
                type="button"
                role="radio"
                aria-checked={format === id}
                className={format === id ? "st-on" : undefined}
                onClick={() => setFormat(id)}
              >
                {label}
              </button>
            ))}
          </div>
          <textarea
            ref={area}
            className="st-picks-text"
            readOnly
            rows={6}
            value={text}
            aria-label="Picked file names"
          />
          <p className="st-picks-hint">
            {format === "lightroom"
              ? "Paste into a Library Filter text search set to Contains, then select all and add them to a collection."
              : format === "captureone"
                ? "Paste into the Filters tool search field."
                : "One file name per line, for scripts and spreadsheets."}
          </p>
        </div>
      ) : (
        <p className="st-picks-summary">
          No favorites sent yet. They show up here once a client sends their favorites from the
          gallery.
        </p>
      )}
    </Modal>
  );
}

export function DeleteDialog({
  assets,
  onClose,
  onDelete,
}: {
  assets: readonly StudioAsset[];
  onClose(): void;
  onDelete(): void;
}) {
  const one = assets.length === 1 ? assets[0] : null;
  const picks = assets.reduce((sum, asset) => sum + asset.pickCount, 0);
  const notes = assets.reduce((sum, asset) => sum + asset.noteCount, 0);
  const extras = [
    picks ? plural(picks, "client pick") : "",
    notes ? plural(notes, "note") : "",
  ].filter(Boolean);
  return (
    <Modal
      open
      title={one ? `Delete ${one.title}?` : `Delete ${assets.length} photos?`}
      onClose={onClose}
      footer={
        <>
          <Button variant="ghost" onClick={onClose}>
            {one ? "Keep it" : "Keep them"}
          </Button>
          <Button variant="danger" onClick={onDelete} id="delete-confirm">
            {one ? "Delete" : `Delete ${assets.length}`}
          </Button>
        </>
      }
    >
      <p className="st-dialog-text">
        {one ? "The photo" : `The ${assets.length} photos`}
        {extras.length ? ` and ${one ? "its" : "their"} ${extras.join(" and ")}` : ""} will be
        removed from this shoot and the client gallery. You can't undo this.
      </p>
    </Modal>
  );
}

const SHORTCUTS: Array<[string, Array<[string, string]>]> = [
  [
    "Views",
    [
      ["G", "Grid"],
      ["E", "Loupe"],
      ["C", "Compare"],
      ["Esc", "Go back one view"],
      ["?", "Show shortcuts"],
    ],
  ],
  [
    "Select",
    [
      ["Click", "Select one photo"],
      ["Shift click", "Select a range"],
      [`${UNDO_KEY.startsWith("⌘") ? "⌘" : "Ctrl"} click`, "Add or remove a photo"],
      [`${UNDO_KEY.startsWith("⌘") ? "⌘" : "Ctrl+"}A`, "Select every photo shown"],
      ["Esc", "Keep only the active photo, before going back"],
    ],
  ],
  [
    "Move",
    [
      ["← →", "Previous or next photo"],
      ["↑ ↓", "Row up or down in the grid"],
      ["Enter", "Open in Loupe"],
      ["Home End", "First or last photo"],
    ],
  ],
  [
    "Cull",
    [
      ["1…5", "Set the rating"],
      ["0", "Clear the rating"],
      ["6…9", "Red, yellow, green, or blue label. Set purple in the inspector."],
      ["Shift 0…9", "Rate or label, then go to the next photo"],
      ["P", "Publish to or hide from the client"],
      [UNDO_KEY, "Undo the last rating, label, or publish"],
      ["Delete", "Delete the selected photos"],
    ],
  ],
  [
    "Loupe and Compare",
    [
      ["Z Space", "Zoom to fit or to 100%"],
      ["Click", "Zoom to that spot, then drag to pan"],
      ["N", "Pin a note"],
      ["I", "Info overlay"],
      ["← →", "Next candidate in Compare"],
      ["X", "Swap select and candidate"],
      ["↑", "Make the candidate the select"],
    ],
  ],
];

export function Shortcuts({ onClose }: { onClose(): void }) {
  return (
    <Modal open title="Keyboard shortcuts" onClose={onClose}>
      <div className="st-shortcuts">
        {SHORTCUTS.map(([group, keys]) => (
          <section key={group}>
            <h3>{group}</h3>
            <dl>
              {keys.map(([key, text]) => (
                <div key={key}>
                  <dt>
                    {key.split(" ").map((part) => (
                      <kbd key={part}>{part}</kbd>
                    ))}
                  </dt>
                  <dd>{text}</dd>
                </div>
              ))}
            </dl>
          </section>
        ))}
      </div>
    </Modal>
  );
}
