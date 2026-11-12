import { useEffect, useRef, useState, type ReactNode } from "react";
import { Icon } from "./icons";
import type { ViewMeta } from "./model";
import "./LinkEntry.css";

function accessDetail(meta: ViewMeta): string {
  if (meta.access === "view") return "You can read the files and the comments.";
  if (meta.access === "comment") return "You can read the files, and read and post comments.";
  return meta.effectiveSelector.versionId !== null
    ? "A saved version can't be edited."
    : "You can edit pages here. Editing pauses while the owner's workspace is offline.";
}

/** What this link reaches, in three facts: who can do what, what it includes, and how current it is. */
export function LinkAbout({ meta, fileCount, updated, children }: {
  meta: ViewMeta;
  fileCount: number;
  updated: string;
  children?: ReactNode;
}) {
  const { paths, versionId } = meta.effectiveSelector;
  const files = fileCount === 0 ? "No files yet" : fileCount === 1 ? "1 file" : `${fileCount} files`;
  // The paths say where the files sit, unless the link is named for its one path.
  const where = paths.length === 0 || (paths.length === 1 && paths[0] === meta.subjectName) ? "" : ` in ${paths.join(", ")}`;
  return (
    <section className="link-about" aria-labelledby="link-entry-title">
      <h2 id="link-entry-title">About this link</h2>
      <ul className="link-facts">
        <li>
          <Icon name="link" />
          <div>
            <p>Anyone with this link can {meta.access}</p>
            <p className="link-fact-detail">{accessDetail(meta)}</p>
          </div>
        </li>
        <li>
          <Icon name={fileCount === 1 ? "file-text" : "folder"} />
          <div>
            <p>{meta.subjectName ?? "Shared files"}</p>
            <p className="link-fact-detail">{files}{where}</p>
          </div>
        </li>
        <li>
          <Icon name="clock" />
          <div>
            <p>{versionId === null ? "Follows the current version" : "Shows a saved version"}</p>
            {updated && <p className="link-fact-detail">{updated}</p>}
          </div>
        </li>
      </ul>
      {children}
    </section>
  );
}

/** The link's MCP address, and the two steps that connect an agent with it. */
export function LinkAgent({ secret }: { secret?: string | null }) {
  const mcpAddress = `${location.origin}/mcp/s/${secret ?? "<secret>"}`;
  return (
    <section className="link-agent" aria-labelledby="link-agent-title">
      <h2 id="link-agent-title">Use with an agent</h2>
      <div className="link-agent-address">
        <code>{mcpAddress}</code>
        <CopyAddress key={mcpAddress} text={mcpAddress} />
      </div>
      {!secret && (
        <p className="link-agent-missing"><Icon name="alert" size={14} /><span>Replace &lt;secret&gt; with the text after # in the original share link.</span></p>
      )}
      <ol>
        <li>Add this address to your agent's MCP client.</li>
        <li>Allow the agent when its client opens the sign-in page.</li>
      </ol>
      <p className="link-fact-detail">
        The agent uses this link's access. It cannot access work outside this link or change its permissions.{" "}
        Anyone with the full address gets this link's access, so share it only as you share the link.
      </p>
    </section>
  );
}

type CopyState = "idle" | "copied" | "failed";
const COPY_LABEL: Record<CopyState, string> = {idle: "Copy MCP address", copied: "Copied", failed: "Could not copy"};
const COPY_WORD: Record<CopyState, string> = {idle: "Copy", copied: "Copied", failed: "Could not copy"};

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
      <button type="button" className="handoff-button primary link-agent-copy" data-copy-feedback={state === "idle" ? undefined : state}
        aria-label={label} title={label} onClick={() => void copy()}>
        <Icon name={state === "copied" ? "check" : state === "failed" ? "x" : "copy"} size={14} />
        {COPY_WORD[state]}
      </button>
      <span className="sr-only" aria-live="polite">{state === "idle" ? "" : label}</span>
    </>
  );
}
