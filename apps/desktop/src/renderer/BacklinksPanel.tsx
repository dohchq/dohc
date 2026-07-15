import { ChevronRight, Link2 } from "lucide-react";
import { useEffect, useState } from "react";
import type {
  ChatFileMentionRecord,
  GetBacklinksResult,
} from "../ipc/bridgeContract";
import { bridge } from "./bridge";

type BacklinkSource = GetBacklinksResult["sources"][number];
type BacklinkSnippet = BacklinkSource["snippets"][number];

// Splits a snippet line into before / highlighted / after so the linked text
// reads out of the surrounding line. Ranges come clamped from main, but this
// guards against any drift so a bad range can never throw here.
function snippetParts(snippet: BacklinkSnippet): {
  before: string;
  mark: string;
  after: string;
} {
  const { text } = snippet;
  const start = Math.max(0, Math.min(snippet.highlightStart, text.length));
  const end = Math.max(start, Math.min(snippet.highlightEnd, text.length));
  return {
    before: text.slice(0, start),
    mark: text.slice(start, end),
    after: text.slice(end),
  };
}

// "Linked mentions" — the inbound links to the open document, mirroring
// Obsidian/Notion. Computation lives in main (it must read every workspace
// file); this surface renders the result quietly at the bottom of the document,
// hides itself entirely when there are none, and reuses the open pathway so a
// mention click navigates like a wikilink.
export function BacklinksPanel(props: {
  workspaceId: string;
  path: string;
  // Bumps on workspace activity (saves, agent edits) so mentions recompute.
  refreshKey?: number;
  onOpenPath?: (path: string) => void;
  onOpenChatMention?: (mention: ChatFileMentionRecord) => void;
}) {
  const [sources, setSources] = useState<BacklinkSource[]>([]);
  const [chatMentions, setChatMentions] = useState<ChatFileMentionRecord[]>([]);
  const [open, setOpen] = useState(true);
  const { workspaceId, path, refreshKey } = props;

  useEffect(() => {
    const getBacklinks = bridge().getBacklinks;
    // Partial bridges (tests, older hosts) may not expose it — degrade to none.
    if (typeof getBacklinks !== "function") return;

    let active = true;
    const getChatMentions = bridge().listChatFileMentions;
    void Promise.all([
      getBacklinks({ workspaceId, path }),
      typeof getChatMentions === "function"
        ? getChatMentions({ workspaceId, path }).catch(() => ({ mentions: [] }))
        : Promise.resolve({ mentions: [] }),
    ])
      .then(([result, chats]) => {
        // Guard the async response against a workspace/path switch mid-flight
        // (product invariant: a slow response must never repaint the wrong doc).
        if (active) {
          setSources(result.sources);
          setChatMentions(chats.mentions);
        }
      })
      .catch(() => {
        if (active) {
          setSources([]);
          setChatMentions([]);
        }
      });
    return () => {
      active = false;
    };
  }, [workspaceId, path, refreshKey]);

  // Recompute when the window regains focus — catches edits made in another app
  // (e.g. an agent) without polling.
  const [focusNonce, setFocusNonce] = useState(0);
  useEffect(() => {
    const onFocus = () => setFocusNonce((nonce) => nonce + 1);
    window.addEventListener("focus", onFocus);
    return () => window.removeEventListener("focus", onFocus);
  }, []);
  useEffect(() => {
    if (focusNonce === 0) return;
    const getBacklinks = bridge().getBacklinks;
    if (typeof getBacklinks !== "function") return;
    let active = true;
    const getChatMentions = bridge().listChatFileMentions;
    void Promise.all([
      getBacklinks({ workspaceId, path }),
      typeof getChatMentions === "function"
        ? getChatMentions({ workspaceId, path }).catch(() => ({ mentions: [] }))
        : Promise.resolve({ mentions: [] }),
    ])
      .then(([result, chats]) => {
        if (active) {
          setSources(result.sources);
          setChatMentions(chats.mentions);
        }
      })
      .catch(() => undefined);
    return () => {
      active = false;
    };
  }, [focusNonce, workspaceId, path]);

  const linkedTotal = sources.reduce((sum, source) => sum + source.snippets.length, 0);
  const total = linkedTotal + chatMentions.length;
  // Hidden entirely when nothing links here.
  if (total === 0) return null;

  return (
    <section className="dohc-backlinks" data-testid="backlinks">
      <div className="dohc-backlinks__inner">
        <button
          type="button"
          className="dohc-backlinks__header"
          aria-expanded={open}
          data-testid="backlinks-toggle"
          onClick={() => setOpen((value) => !value)}
        >
          <ChevronRight
            size={14}
            aria-hidden
            className="dohc-backlinks__chevron"
            data-open={open}
          />
          <Link2 size={13} aria-hidden className="dohc-backlinks__header-icon" />
          <span className="dohc-backlinks__title">Linked mentions</span>
          <span className="dohc-backlinks__count" data-testid="backlinks-count">
            {total}
          </span>
        </button>
        {open ? (
          <div>
          {chatMentions.length > 0 ? (
            <ul className="dohc-backlinks__list" data-testid="chat-file-mentions">
              {chatMentions.map((mention) => (
                <li key={mention.attachment.attachmentId} className="dohc-backlinks__source">
                  <button
                    type="button"
                    className="dohc-backlinks__source-link"
                    data-testid="chat-file-mention"
                    onClick={() => props.onOpenChatMention?.(mention)}
                  >
                    <span className="dohc-backlinks__source-title">
                      {mention.channelName ? `#${mention.channelName}` : mention.thread.title}
                      {mention.attachment.headingText
                        ? ` · #${mention.attachment.headingText}`
                        : ""}
                    </span>
                    <span className="dohc-backlinks__source-path">
                      {mention.message.authorDisplayName} · {new Date(mention.message.createdAtMs).toLocaleString()}
                    </span>
                  </button>
                  <p className="dohc-backlinks__snippet m-0 line-clamp-2 text-left">
                    {mention.message.body}
                  </p>
                </li>
              ))}
            </ul>
          ) : null}
          {linkedTotal > 0 ? (
          <ul className="dohc-backlinks__list">
            {sources.map((source) => (
              <li key={source.sourcePath} className="dohc-backlinks__source">
                <button
                  type="button"
                  className="dohc-backlinks__source-link"
                  data-testid="backlink-source"
                  data-path={source.sourcePath}
                  onClick={() => props.onOpenPath?.(source.sourcePath)}
                >
                  <span className="dohc-backlinks__source-title">
                    {source.sourceTitle}
                  </span>
                  <span className="dohc-backlinks__source-path">
                    {source.sourcePath}
                  </span>
                </button>
                <ul className="dohc-backlinks__snippets">
                  {source.snippets.map((snippet, index) => {
                    const parts = snippetParts(snippet);
                    return (
                      <li key={`${snippet.line}:${index}`}>
                        <button
                          type="button"
                          className="dohc-backlinks__snippet"
                          data-testid="backlink-snippet"
                          onClick={() => props.onOpenPath?.(source.sourcePath)}
                        >
                          {parts.before}
                          <mark className="dohc-backlinks__mark">
                            {parts.mark}
                          </mark>
                          {parts.after}
                        </button>
                      </li>
                    );
                  })}
                </ul>
              </li>
            ))}
          </ul>
          ) : null}
          </div>
        ) : null}
      </div>
    </section>
  );
}
