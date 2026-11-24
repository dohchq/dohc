import { CopyWork } from "./CopyWork";
import { Icon } from "./icons";

/** A page's unsent edits, as one row that opens in place to the text, with Copy, Download and Discard. */
export function UnsentEditsRow({
  name,
  path,
  text,
  onDiscard,
}: {
  name: string;
  path: string;
  text: string;
  onDiscard(): void;
}) {
  const base = path.slice(path.lastIndexOf("/") + 1),
    dot = base.lastIndexOf(".");
  const file =
    dot > 0 ? `${base.slice(0, dot)} (unsent edits)${base.slice(dot)}` : `${base} (unsent edits)`;
  return (
    <details className="unsent-edits" aria-label="Unsent edits">
      <summary>
        <Icon name="triangle-alert" size={14} />
        <span className="unsent-name">Unsent edits to {name}</span>
        <Icon name="chevron-down" size={14} />
      </summary>
      <p>Only this tab has them. Copy or download them before you close it.</p>
      <textarea readOnly value={text} aria-label={`Unsent edits to ${name}`} />
      <div className="unsent-actions">
        <CopyWork
          text={text}
          label="Copy unsent edits"
          failure="dohc could not copy the edits. Download them instead."
        />
        <a
          className="handoff-button secondary"
          download={file}
          href={`data:text/markdown;charset=utf-8,${encodeURIComponent(text)}`}
        >
          Download
        </a>
        <button type="button" className="handoff-button secondary" onClick={onDiscard}>
          Discard
        </button>
      </div>
    </details>
  );
}
