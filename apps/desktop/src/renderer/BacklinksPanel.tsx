import { ChevronRight, Link2 } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import type {
  ChatFileMentionRecord,
} from "../ipc/bridgeContract";
import { bridge } from "./bridge";
import { useAsyncResponseEffect } from "./useAsyncResponseEffect";

import type { LinksInResult } from "@dohc/workspace-contracts/links";
type BacklinksResult = { sources: BacklinkSource[]; nextCursor: string | null };
type BacklinkSource = { sourcePath: string; sourceTitle: string; snippets: { text: string; line: number; highlightStart: number; highlightEnd: number }[] };
function sourcesFor(entries: NonNullable<LinksInResult>["entries"]): BacklinkSource[] {
  const sources = new Map<string, BacklinkSource>();
  for (const entry of entries) {
    let source = sources.get(entry.source);
    if (!source) { source = { sourcePath: entry.source, sourceTitle: entry.title, snippets: [] }; sources.set(entry.source, source); }
    source.snippets.push({ text: entry.snippet, line: entry.line, highlightStart: entry.highlightStart, highlightEnd: entry.highlightEnd });
  }
  return [...sources.values()];
}
function mergeSources(left: BacklinkSource[], right: BacklinkSource[]): BacklinkSource[] {
  const result = new Map(left.map(source => [source.sourcePath, source]));
  for (const source of right) { const prior = result.get(source.sourcePath); result.set(source.sourcePath, prior ? { ...prior, snippets: [...prior.snippets, ...source.snippets] } : source); }
  return [...result.values()];
}
type BacklinkSnippet = BacklinkSource["snippets"][number];
type LoadedBacklinks = {
  workspaceId: string;
  path: string;
  sources: BacklinkSource[];
  nextCursor: string | null;
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
      result: BacklinksResult;
    }
  | { ok: false };
type BacklinksLoadRequest = {
  identity: BacklinksLoadIdentity;
  response: Promise<BacklinksLoadOutcome>;
};

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

// Linked mentions reads bounded engine pages and keeps chat mentions separate.
export function BacklinksPanel(props: {
  workspaceId: string;
  path: string;
  // Bumps on workspace activity (saves, agent edits) so mentions recompute.
  refreshKey?: number;
  // Chat mentions are a CHATS call: `listChatFileMentions` goes through
  // requireEngineCapture, so a workspace with no capture — a shared view, most
  // visibly — can only refuse it. Opt-in, and named the way GraphView names
  // the same fact, so both chat affordances read one word.
  chatMentionsAvailable?: boolean;
  onOpenPath?: (path: string) => void;
  onOpenChatMention?: (mention: ChatFileMentionRecord) => void;
}) {
  const [loaded, setLoaded] = useState<LoadedBacklinks | null>(null);
  const [open, setOpen] = useState(true);
  const [loadedChats, setLoadedChats] = useState<{ workspaceId: string; path: string; mentions: ChatFileMentionRecord[] } | null>(null);
  const { workspaceId, path, refreshKey } = props;
  // Absent reads as unavailable: a caller that has not decided must not make
  // dohc ask for a capability it may not have.
  const chatMentionsAvailable = props.chatMentionsAvailable === true;
  const [focusNonce, setFocusNonce] = useState(0);
  const previousRequest = useRef<BacklinksLoadRequest | null>(null);
  const current =
    loaded?.workspaceId === workspaceId && loaded.path === path ? loaded : null;
  const sources = current?.sources ?? [];
  const chatMentions = chatMentionsAvailable && loadedChats?.workspaceId === workspaceId && loadedChats.path === path ? loadedChats.mentions : [];

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
      const prior = previousRequest.current;
      const focusOnlyRefresh = Boolean(
        prior &&
          sameBacklinksLoadBase(prior.identity, identity) &&
          prior.identity.focusNonce !== identity.focusNonce,
      );

      const linksIn = bridge().linksIn;
      // Partial bridges (tests, older hosts) may not expose it — degrade to none.
      if (typeof linksIn !== "function") {
        previousRequest.current = null;
        return null;
      }
      const response = linksIn({ workspaceId, subject: { path } }).then<BacklinksLoadOutcome, BacklinksLoadOutcome>(
        page => ({ ok: true, result: { sources: sourcesFor(page?.entries ?? []), nextCursor: page?.nextCursor ?? null } }),
        () => ({ ok: false }),
      );
      // Focus refreshes are opportunistic. If one fails, the preceding
      // same-document request remains the last useful answer, even if pending.
      const currentResponse =
        focusOnlyRefresh && prior
          ? response.then((outcome) =>
              outcome.ok ? outcome : prior.response,
            )
          : response;
      previousRequest.current = { identity, response: currentResponse };
      return currentResponse;
    },
    {
      onSuccess: (outcome) => {
        if (!outcome.ok) {
          setLoaded({ workspaceId, path, sources: [], nextCursor: null });
          return;
        }
        // Guard the async response against a workspace/path switch mid-flight
        // (product invariant: a slow response must never repaint the wrong doc).
        setLoaded({
          workspaceId,
          path,
          sources: outcome.result.sources,
          nextCursor: outcome.result.nextCursor,
        });
      },
      onError: () => {
        setLoaded({ workspaceId, path, sources: [], nextCursor: null });
      },
    },
    [chatMentionsAvailable, workspaceId, path, refreshKey, focusNonce],
  );

  useAsyncResponseEffect(() => {
    const read = chatMentionsAvailable ? bridge().listChatFileMentions : undefined;
    return typeof read === "function" ? read({ workspaceId, path }) : Promise.resolve({ mentions: [] });
  }, {
    onSuccess: result => setLoadedChats({ workspaceId, path, mentions: result.mentions }),
    onError: () => setLoadedChats({ workspaceId, path, mentions: [] }),
  }, [chatMentionsAvailable, workspaceId, path, refreshKey, focusNonce]);

  useAsyncResponseEffect(() => current?.nextCursor ? bridge().linksIn({ workspaceId, subject: { path }, cursor: current.nextCursor }) : null, {
    onSuccess: page => setLoaded(previous => previous && previous === current ? { ...previous, sources: mergeSources(previous.sources, sourcesFor(page?.entries ?? [])), nextCursor: page?.nextCursor ?? null } : previous),
    onError: () => undefined,
  }, [workspaceId, path, current]);

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
              <li
                key={source.sourcePath}
                className="dohc-backlinks__source [content-visibility:auto] [overflow-clip-margin:12px]"
                style={{ containIntrinsicSize: `auto ${24 + source.snippets.length * 24}px` }}
              >
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
