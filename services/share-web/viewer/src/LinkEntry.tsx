import { shareLinkSummary } from "../../src/shareSummary";
import type { ViewMeta } from "./model";
import "./LinkEntry.css";

export function LinkEntry({ meta, hasFiles, canEditFile }: {
  meta: ViewMeta;
  hasFiles: boolean;
  canEditFile: boolean;
}) {
  const summary = shareLinkSummary(meta);
  return (
    <section className="link-entry" aria-labelledby="link-entry-title">
      <h2 className="section-label" id="link-entry-title">About this link</h2>
      {meta.subjectName && <p>{summary.subject}</p>}
      <p>{summary.permissions}</p>
      <p>
        {hasFiles && "Choose a file in Files to read it. "}
        {meta.access === "view" ? "Read the discussion in Comments. " : "Use Comments to read or post comments. "}
        {canEditFile && "Choose Edit file to edit this Markdown file. "}
        Choose Open in dohc to continue in the desktop app.
      </p>
      <details>
        <summary>Included files and history</summary>
        <p>{summary.included}</p>
        <p>{summary.history}</p>
      </details>
    </section>
  );
}
