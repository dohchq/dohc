import { CopyButtonPart } from "../../../../apps/desktop/src/renderer/ui/CopyButtonPart";
import { shareLinkSummary } from "../../src/shareSummary";
import type { ViewMeta } from "./model";
import "./LinkEntry.css";

export function LinkEntry({ meta, hasFiles, canEditFile }: {
  meta: ViewMeta;
  hasFiles: boolean;
  canEditFile: boolean;
}) {
  const summary = shareLinkSummary(meta);
  const mcpAddress = `${location.origin}/mcp/s/<secret>`;
  return (
    <section className="link-entry" aria-labelledby="link-entry-title">
      <h2 className="section-label" id="link-entry-title">About this link</h2>
      {meta.subjectName && <p>{summary.subject}</p>}
      <p>{summary.permissions}</p>
      <p>
        {hasFiles && "Choose a file in Files to read it. "}
        {meta.access === "view" ? "Read the discussion in Comments. " : "Use Comments to read or post comments. "}
        {canEditFile && "Choose Edit file to edit this file. "}
        Choose Open in dohc to continue in the desktop app.
      </p>
      <section className="link-agent" aria-labelledby="link-agent-title">
        <h3 id="link-agent-title">Use with an agent</h3>
        <p>Connect your agent's MCP client to this address.</p>
        <div className="link-agent-address">
          <code>{mcpAddress}</code>
          <CopyButtonPart className="link-agent-copy" iconOnly label="Copy MCP address" pinName getText={() => mcpAddress} />
        </div>
        <p>Replace &lt;secret&gt; with the text after # in the original share link.</p>
        <p>Allow the agent when its client opens the sign-in page. The agent uses this link's access.</p>
        <p>It cannot access work outside this link or change its permissions.</p>
      </section>
      <details>
        <summary>Included files and history</summary>
        <p>{summary.included}</p>
        <p>{summary.history}</p>
      </details>
    </section>
  );
}
