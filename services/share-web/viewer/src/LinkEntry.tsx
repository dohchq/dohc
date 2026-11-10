import { useEffect, useRef, useState } from "react";
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
          <CopyAddress text={mcpAddress} />
        </div>
        <p>Replace &lt;secret&gt; with the text after # in the original share link. Anyone with the full address gets this link's access, so share it only as you share the link.</p>
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

type CopyState = "idle" | "copied" | "failed";
const COPY_LABEL: Record<CopyState, string> = {idle: "Copy MCP address", copied: "Copied", failed: "Could not copy"};

// The viewer's own copy control: write the text, then show the result for 2 s.
function CopyAddress({ text }: { text: string }) {
  const [state, setState] = useState<CopyState>("idle");
  const timer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  useEffect(() => () => clearTimeout(timer.current), []);
  const copy = async () => {
    let next: CopyState = "copied";
    try { await navigator.clipboard.writeText(text); } catch { next = "failed"; }
    setState(next);
    clearTimeout(timer.current);
    timer.current = setTimeout(() => setState("idle"), 2000);
  };
  const label = COPY_LABEL[state];
  return (
    <>
      <button type="button" className="link-agent-copy" data-copy-feedback={state === "idle" ? undefined : state}
        aria-label={label} title={label} onClick={() => void copy()}>
        <svg aria-hidden="true" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2} strokeLinecap="round" strokeLinejoin="round">
          {state === "copied" ? <path d="M20 6 9 17l-5-5"/> :
            state === "failed" ? <><path d="M18 6 6 18"/><path d="m6 6 12 12"/></> :
            <><rect width="14" height="14" x="8" y="8" rx="2" ry="2"/><path d="M4 16c-1.1 0-2-.9-2-2V4c0-1.1.9-2 2-2h10c1.1 0 2 .9 2 2"/></>}
        </svg>
      </button>
      <span className="sr-only" aria-live="polite">{state === "idle" ? "" : label}</span>
    </>
  );
}
