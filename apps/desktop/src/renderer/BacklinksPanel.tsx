import { ChevronRight, Link2 } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import type {
  ChatFileMentionRecord,
  GetBacklinksResult,
} from "../ipc/bridgeContract";
import { bridge } from "./bridge";
import { useAsyncResponseEffect } from "./useAsyncResponseEffect";

type BacklinkSource = GetBacklinksResult["sources"][number];
type BacklinkSnippet = BacklinkSource["snippets"][number];
type LoadedBacklinks = {
  workspaceId: string;
  path: string;
  sources: BacklinkSource[];
  chatMentions: ChatFileMentionRecord[];
};
type BacklinksLoadIdentity = {
  chatMentionsAvailable: boolean;
  workspaceId: string;
  path: string;
  refreshKey: number | undefined;
  focusNonce: number;
};
type BacklinksLoadOutcome =
  | {
      ok: true;
      result: GetBacklinksResult;
      chatMentions: ChatFileMentionRecord[];
    }
  | { ok: false; preserveCurrent: boolean };

function sameBacklinksLoadBase(
  left: BacklinksLoadIdentity,
  right: BacklinksLoadIdentity,
): boolean {
  return (
    left.chatMentionsAvailable === right.chatMentionsAvailable &&
    left.workspaceId === right.workspaceId &&
    left.path === right.path &&
    left.refreshKey === right.refreshKey
  );
}

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
  // Chat mentions are a CHATS call (#615): `listChatFileMentions` goes through
  // requireEngineCapture, so a workspace with no capture — a shared view, most
  // visibly — can only refuse it. Opt-in, and named the way GraphView names
  // the same fact, so both chat affordances read one word.
  chatMentionsAvailable?: boolean;
  onOpenPath?: (path: string) => void;
  onOpenChatMention?: (mention: ChatFileMentionRecord) => void;
}) {
  const [loaded, setLoaded] = useState<LoadedBacklinks | null>(null);
  const [open, setOpen] = useState(true);
  const { workspaceId, path, refreshKey } = props;
  // Absent reads as unavailable: a caller that has not decided must not make
  // dohc ask for a capability it may not have.
  const chatMentionsAvailable = props.chatMentionsAvailable === true;
  const [focusNonce, setFocusNonce] = useState(0);
  const previousLoad = useRef<BacklinksLoadIdentity | null>(null);
  const current =
    loaded?.workspaceId === workspaceId && loaded.path === path ? loaded : null;
  const sources = current?.sources ?? [];
  const chatMentions = current?.chatMentions ?? [];

  // Recompute when the window regains focus. This catches edits made in
  // another app without polling. The focus nonce joins the same request
  // identity as workspace activity so the two triggers cannot race each other.
  useEffect(() => {
    const onFocus = () => setFocusNonce((nonce) => nonce + 1);
    window.addEventListener("focus", onFocus);
    return () => window.removeEventListener("focus", onFocus);
  }, []);

  useAsyncResponseEffect<BacklinksLoadOutcome>(
    () => {
      const identity: BacklinksLoadIdentity = {
        chatMentionsAvailable,
        workspaceId,
        path,
        refreshKey,
        focusNonce,
      };
      const prior = previousLoad.current;
      const preserveCurrent = Boolean(
        prior &&
          sameBacklinksLoadBase(prior, identity) &&
          prior.focusNonce !== identity.focusNonce,
      );
      previousLoad.current = identity;

      const getBacklinks = bridge().getBacklinks;
      // Partial bridges (tests, older hosts) may not expose it — degrade to none.
      if (typeof getBacklinks !== "function") return null;
      const getChatMentions = chatMentionsAvailable
        ? bridge().listChatFileMentions
        : undefined;
      return Promise.all([
        getBacklinks({ workspaceId, path }),
        typeof getChatMentions === "function"
          ? getChatMentions({ workspaceId, path }).catch(() => ({ mentions: [] }))
          : Promise.resolve({ mentions: [] }),
      ]).then<BacklinksLoadOutcome, BacklinksLoadOutcome>(
        ([result, chats]) => ({
          ok: true,
          result,
          chatMentions: chats.mentions,
        }),
        () => ({ ok: false, preserveCurrent }),
      );
    },
    {
      onSuccess: (outcome) => {
        if (!outcome.ok) {
          // A focus-only refresh is opportunistic and keeps the last useful
          // result. Identity and workspace-activity failures clear it.
          if (!outcome.preserveCurrent) {
            setLoaded({ workspaceId, path, sources: [], chatMentions: [] });
          }
          return;
        }
        // Guard the async response against a workspace/path switch mid-flight
        // (product invariant: a slow response must never repaint the wrong doc).
        setLoaded({
          workspaceId,
          path,
          sources: outcome.result.sources,
          chatMentions: outcome.chatMentions,
        });
      },
      onError: () => {
        setLoaded({ workspaceId, path, sources: [], chatMentions: [] });
      },
    },
    [chatMentionsAvailable, workspaceId, path, refreshKey, focusNonce],
  );

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
