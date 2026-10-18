import { fileKindForPath, type FileKindRecord } from "@dohc/workspace-contracts/kinds";
import { basenameOf, dirnameOf } from "../path";
import { KindGlyph } from "./KindGlyph";
import { REF_HOVER, REF_NAME, REF_SELECTED, refChipClass } from "./refChip";

// One reference to a workspace file, the same chip wherever it appears: chat,
// Linked mentions, Search, History, the link picker and, through refElement,
// the editor. The kind glyph, the display name (a Markdown file's title when
// the caller knows it, otherwise the basename with its extension), then the
// folder when the caller asks for it. A dashed border marks a target that
// does not resolve.
//
// With `onOpen` the chip is a button named for what it opens. Without it the
// chip is a plain span, so a row that is already a button can hold it and the
// row stays the one control.

export function Ref(props: {
  path: string;
  // A Markdown file's title, when the caller already holds it.
  title?: string;
  // The listing's kind, when the caller has it; otherwise the path's.
  kind?: FileKindRecord;
  // A heading inside the file, shown after the name.
  heading?: string;
  folder?: boolean;
  missing?: boolean;
  selected?: boolean;
  // The button's accessible name; it defaults to the path it opens.
  label?: string;
  testId?: string;
  onOpen?: () => void;
}) {
  const base = basenameOf(props.path);
  const name = props.title || base;
  const dir = dirnameOf(props.path);
  const heading = props.heading ? `#${props.heading}` : "";
  const target = `${props.path}${heading}`;
  // A span has no name of its own: the row holding it reads its text. Only a
  // basename with its folder spells the path; after a title, whatever its
  // words, the path stands in for the folder, so a title or a truncated name
  // loses nothing.
  const spelled = props.onOpen !== undefined || !props.path || (props.title === undefined && (dir === "" || props.folder));
  const className = `${refChipClass(props.missing)} ${props.selected ? REF_SELECTED : ""}`;
  const content = (
    <>
      <KindGlyph kind={props.kind ?? fileKindForPath(props.path)} size={13} className="text-muted" />
      <span className={REF_NAME}>
        {name}
        {heading ? <span className="text-muted">{heading}</span> : null}
      </span>
      {props.folder && dir ? (
        <span aria-hidden={spelled ? undefined : true} className="min-w-0 shrink-[4] truncate font-mono text-[11px] text-subtle">
          {dir}
        </span>
      ) : null}
      {spelled ? null : <span className="sr-only">{target}</span>}
    </>
  );
  if (props.onOpen) {
    return (
      <button
        type="button"
        data-testid={props.testId}
        data-missing={props.missing || undefined}
        aria-label={props.label ?? `Open ${props.path}${props.heading ? ` at #${props.heading}` : ""}`}
        title={target}
        onClick={props.onOpen}
        className={`${className} ${REF_HOVER}`}
      >
        {content}
      </button>
    );
  }
  return (
    <span
      data-testid={props.testId}
      data-missing={props.missing || undefined}
      title={props.path ? target : undefined}
      className={className}
    >
      {content}
    </span>
  );
}
