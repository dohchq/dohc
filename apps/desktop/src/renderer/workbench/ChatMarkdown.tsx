import {
  createContext,
  memo,
  useContext,
  useEffect,
  useMemo,
  useState,
  type ClipboardEvent,
  type CSSProperties,
  type KeyboardEvent,
  type MouseEvent,
  type ReactNode,
} from "react";
import { Fragment, jsx, jsxs } from "react/jsx-runtime";
import type { Root as HastRoot } from "hast";
import { toJsxRuntime, type Components, type ExtraProps } from "hast-util-to-jsx-runtime";
import type { MentionCandidate } from "@dohc/workspace-contracts/chat-mentions";
import type { ChatAttachmentRecord } from "../../ipc/bridgeContract";
import { activateReadOnlyLinkHref } from "../linkActivation";
import { stripMarkdown } from "../markdown/stripMarkdown";
import { CopyButton } from "../ui/CopyButton";
import { Ref } from "../ui/Ref";
import { extractChatFileReferenceTokens } from "./chatFileMentions";
import {
  chatChips,
  chatMarkdownWeight,
  fitsMainThread,
  parseChatMarkdown,
  SAFE_HREF,
  withinChatMarkdownLimits,
  type Chip,
} from "./chatMarkdownParse";
import { parseChatInWorker } from "./chatMarkdownWorker";

// A chat message's body, rendered as Markdown. Chat text comes from other
// people, agents and link holders, so it renders no raw HTML (it reads as
// text), loads no remote image, and opens only http, https and mailto links,
// through the same path a read-only document uses.
//
// A short body parses where it is drawn. A longer one parses in the chat's
// worker and shows as its words without Markdown syntax until the tree
// arrives. A body the parser gives up on keeps that look.

interface ChatTextScope {
  chips: readonly Chip[];
  testId?: string;
  onOpenPath?: (path: string, headingAnchor?: string) => void;
}

const ChatTextContext = createContext<ChatTextScope>({ chips: [] });
// Inside a link, nothing else may be a link or a button, so it has one target.
const InLink = createContext(false);

function ChipView(props: { index: number; children?: ReactNode }) {
  const scope = useContext(ChatTextContext);
  const inLink = useContext(InLink);
  const chip = scope.chips[props.index];
  if (!chip) return <span>{props.children}</span>;
  if (chip.kind === "mention") {
    return (
      <span
        data-testid={scope.testId ? `${scope.testId}-mention` : undefined}
        data-mention-kind={chip.mentionKind}
        className="rounded bg-accent/15 px-1 font-medium text-accent"
      >
        {props.children}
      </span>
    );
  }
  const onOpenPath = inLink ? undefined : scope.onOpenPath;
  return (
    <Ref
      path={chip.path}
      heading={chip.heading}
      testId={scope.testId ? `${scope.testId}-file-mention` : undefined}
      onOpen={onOpenPath ? () => onOpenPath(chip.target.path, chip.target.headingAnchor) : undefined}
    />
  );
}

function ChipSpan(props: { children?: ReactNode } & ExtraProps) {
  const index = props.node?.properties.dataChatChip;
  return <ChipView index={index === undefined ? -1 : Number(index)}>{props.children}</ChipView>;
}

// Outside links open the way a read-only document's do. Anything else, such
// as a relative path or a scheme dohc does not open, reads as plain text.
function ChatLink(props: { href?: string; children?: ReactNode }) {
  const inLink = useContext(InLink);
  const href = props.href?.trim();
  if (inLink || !href || !SAFE_HREF.test(href)) return <>{props.children}</>;
  const activate = (event: MouseEvent<HTMLAnchorElement> | KeyboardEvent<HTMLAnchorElement>) =>
    activateReadOnlyLinkHref(href, event);
  return (
    <a
      href={href}
      title={href}
      onClick={activate}
      onAuxClick={(event) => {
        if (event.button === 1) activate(event);
      }}
      onKeyDown={(event) => {
        if (event.key === "Enter") activate(event);
      }}
      className="cursor-pointer border-b border-match/45 text-match no-underline hover:border-match"
    >
      <InLink value={true}>{props.children}</InLink>
    </a>
  );
}

type HastNode = { type: string; value?: string; children?: HastNode[] };
function hastText(node: HastNode | undefined): string {
  if (!node) return "";
  if (node.type === "text") return node.value ?? "";
  return (node.children ?? []).map(hastText).join("");
}

function CodeBlock(props: ExtraProps) {
  const code = hastText(props.node).replace(/\n$/u, "");
  return (
    <div className="group/code relative mt-1.5 first:mt-0">
      <pre className="m-0 overflow-x-auto whitespace-pre rounded-md border border-line bg-panel-2 px-3 py-2.5 font-mono text-[12.5px] leading-5 text-ink">
        <code>{code}</code>
      </pre>
      <div data-chat-control className="absolute right-px top-px rounded-md bg-panel-2 opacity-0 transition-opacity duration-75 focus-within:opacity-100 group-hover/code:opacity-100">
        <CopyButton iconOnly label="Copy code" getText={() => code} />
      </div>
    </div>
  );
}

// Each block keeps 6px from the one before it, and none from the edges, so a
// one-line message stays one line tall.
const BLOCK = "mb-0 mt-1.5 first:mt-0";
const LIST = `${BLOCK} pl-[22px] marker:text-muted [li>&]:mt-0.5`;
const HEADING = `${BLOCK} text-[15px] font-semibold leading-[22px]`;
type Children = { children?: ReactNode };

const COMPONENTS = {
  p: (props: Children) => <p className={BLOCK}>{props.children}</p>,
  ul: (props: Children) => <ul className={`${LIST} list-disc`}>{props.children}</ul>,
  ol: (props: Children & { start?: number }) => (
    <ol start={props.start} className={`${LIST} list-decimal`}>{props.children}</ol>
  ),
  li: (props: Children & { className?: string }) => (
    <li className={`mt-0.5 first:mt-0 ${props.className === "task-list-item" ? "list-none" : ""}`}>
      {props.children}
    </li>
  ),
  // A task box shows its state and takes no click.
  input: (props: { checked?: boolean }) => (
    <input
      type="checkbox"
      checked={props.checked ?? false}
      disabled
      readOnly
      className="m-0 -ml-[22px] mr-[9px] size-[13px] align-[-2px] accent-accent"
    />
  ),
  h1: (props: Children) => <h1 className={HEADING}>{props.children}</h1>,
  h2: (props: Children) => <h2 className={HEADING}>{props.children}</h2>,
  h3: (props: Children) => <h3 className={HEADING}>{props.children}</h3>,
  h4: (props: Children) => <h4 className={HEADING}>{props.children}</h4>,
  h5: (props: Children) => <h5 className={HEADING}>{props.children}</h5>,
  h6: (props: Children) => <h6 className={HEADING}>{props.children}</h6>,
  strong: (props: Children) => <strong className="font-semibold">{props.children}</strong>,
  blockquote: (props: Children) => (
    <blockquote className={`${BLOCK} mx-0 border-l-2 border-line pl-3 text-muted`}>{props.children}</blockquote>
  ),
  hr: () => <hr className={`${BLOCK} h-0 border-0 border-t border-line`} />,
  code: (props: Children) => (
    <code className="rounded bg-panel-2 px-[5px] py-px font-mono text-[12.5px]">{props.children}</code>
  ),
  pre: CodeBlock,
  a: ChatLink,
  // A remote image would tell its server who read the message, so it shows
  // as a link to the image instead, or as its text inside another link.
  img: (props: { src?: string; alt?: string }) => (
    <ChatLink href={props.src}>{props.alt || props.src}</ChatLink>
  ),
  table: (props: Children) => (
    <div className={`${BLOCK} overflow-x-auto`}>
      <table className="border-collapse text-[13px] leading-5">{props.children}</table>
    </div>
  ),
  th: (props: Children & { style?: CSSProperties }) => (
    <th style={props.style} className="border border-line px-2 py-1 text-left font-semibold">
      {props.children}
    </th>
  ),
  td: (props: Children & { style?: CSSProperties }) => (
    <td style={props.style} className="border border-line px-2 py-1">{props.children}</td>
  ),
  span: ChipSpan,
} satisfies Components;

function drawTree(tree: HastRoot): ReactNode {
  return toJsxRuntime(tree, {
    Fragment,
    jsx,
    jsxs,
    components: COMPONENTS,
    passKeys: true,
    passNode: true,
    ignoreInvalidStyle: true,
  });
}

// The words of the body with its chips, as one paragraph with its line
// breaks. `strip` drops Markdown syntax; a body without any skips it. Before
// its chips are known, page references still keep their names as typed.
function PlainText(props: { body: string; chips: readonly Chip[]; strip: boolean }) {
  const kept = props.chips.length > 0 || !props.strip ? props.chips : extractChatFileReferenceTokens(props.body);
  const { text, atoms } = props.strip
    ? stripMarkdown(props.body, kept)
    : { text: props.body, atoms: kept.map((chip, index) => ({ start: chip.start, end: chip.end, index })) };
  const content: ReactNode[] = [];
  const pushText = (piece: string, key: number) =>
    piece.split(/\r?\n|\r/u).forEach((line, at) => {
      if (at > 0) content.push(<br key={`${key}:${at}`} />, "\n");
      if (line) content.push(line);
    });
  let cursor = 0;
  for (const atom of atoms) {
    pushText(text.slice(cursor, atom.start), cursor);
    const words = text.slice(atom.start, atom.end);
    content.push(props.chips[atom.index] ? <ChipView key={`chip:${atom.start}`} index={atom.index}>{words}</ChipView> : words);
    cursor = atom.end;
  }
  pushText(text.slice(cursor), cursor);
  return <p className={BLOCK}>{content}</p>;
}

// Copying a whole message copies what its author wrote, Markdown and all,
// unless the source holds something the reader could not see. A selection
// inside it, or across messages, copies the text as shown.
function copySource(event: ClipboardEvent<HTMLDivElement>, body: string, copiesSource: boolean) {
  if (!copiesSource) return;
  const selection = document.getSelection();
  if (!selection || selection.isCollapsed || selection.rangeCount !== 1) return;
  const range = selection.getRangeAt(0);
  const root = event.currentTarget;
  if (!root.contains(range.startContainer) || !root.contains(range.endContainer)) return;
  const edges = textEdges(root);
  if (!edges || !range.isPointInRange(edges.first, edges.firstOffset) || !range.isPointInRange(edges.last, edges.lastOffset)) {
    return;
  }
  event.preventDefault();
  event.clipboardData.setData("text/plain", body);
}

// The first and last characters of the message's own text, leaving out
// controls and live regions such as a code block's Copy and its "Copied". A
// page chip is a button, and its name is the message's text.
function textEdges(root: HTMLElement) {
  const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT, {
    acceptNode: (node) => {
      const control = node.parentElement?.closest("[data-chat-control], [aria-live], [role=status]");
      if (control && root.contains(control)) return NodeFilter.FILTER_REJECT;
      return node.nodeValue?.trim() ? NodeFilter.FILTER_ACCEPT : NodeFilter.FILTER_REJECT;
    },
  });
  const first = walker.nextNode() as Text | null;
  if (!first) return null;
  let last = first;
  for (let node = walker.nextNode(); node; node = walker.nextNode()) last = node as Text;
  return {
    first,
    firstOffset: first.data.length - first.data.trimStart().length,
    last,
    lastOffset: last.data.trimEnd().length,
  };
}

// Text the Markdown parser would turn into one paragraph of the same text:
// nothing Markdown or GFM gives meaning to, no blank line, and no edge
// spaces. Most chat lines are like this, so they skip the parser.
const MARKDOWN_SYNTAX = /[\\`*_~\[\]<>&|#!:]|\w@|www\.|^\s|\s$|^(?:[-+=]|\d+[.)])/mu;

interface Drawn {
  content: ReactNode;
  chips: readonly Chip[];
  copiesSource: boolean;
  // What its tree costs the cache to hold.
  weight: number;
}

const textOnly = (body: string, chips: readonly Chip[]): Drawn => ({
  content: <PlainText body={body} chips={chips} strip />,
  chips,
  copiesSource: false,
  weight: 0,
});

// Drawn bodies of recent messages, so reopening a chat or scrolling back to a
// message skips the parse, oldest dropped first past the size limit. The key
// holds the body and what its chips depend on. An entry weighs its key and
// its tree.
export function createDrawnCache<Value>(maxWeight: number) {
  const entries = new Map<string, { value: Value; weight: number }>();
  let total = 0;
  return {
    remember(key: string, value: Value, treeWeight = 0) {
      const known = entries.get(key);
      if (known) {
        entries.delete(key);
        total -= known.weight;
      }
      const weight = key.length + treeWeight;
      entries.set(key, { value, weight });
      total += weight;
      for (const [oldest, entry] of entries) {
        if (total <= maxWeight) break;
        entries.delete(oldest);
        total -= entry.weight;
      }
    },
    recall(key: string): Value | undefined {
      const entry = entries.get(key);
      if (entry !== undefined) {
        entries.delete(key);
        entries.set(key, entry);
      }
      return entry?.value;
    },
  };
}

const { remember, recall } = createDrawnCache<Drawn>(2_000_000);
// Bodies the parser gave up on this session, by hash, so none is tried again
// whatever its chips depend on.
const gaveUp = new Set<number>();
const parsing = new Map<string, Promise<Drawn>>();

// cyrb53: a 53-bit string hash.
function hash(text: string): number {
  let h1 = 0xdeadbeef;
  let h2 = 0x41c6ce57;
  for (let at = 0; at < text.length; at++) {
    const code = text.charCodeAt(at);
    h1 = Math.imul(h1 ^ code, 2654435761);
    h2 = Math.imul(h2 ^ code, 1597334677);
  }
  h1 = Math.imul(h1 ^ (h1 >>> 16), 2246822507) ^ Math.imul(h2 ^ (h2 >>> 13), 3266489909);
  h2 = Math.imul(h2 ^ (h2 >>> 16), 2246822507) ^ Math.imul(h1 ^ (h1 >>> 13), 3266489909);
  return 4294967296 * (2097151 & h2) + (h1 >>> 0);
}

// Chips depend on the mention candidates and the attachments, so a body with
// an "@" keys on them too, through a short id per distinct list. Equal lists
// share an id while the table holds them; past its size the table starts
// again, and no id is reused, so a key never names another list's chips.
const listIds = new WeakMap<object, string>();
const contentIds = new Map<string, string>();
const CONTENT_IDS_MAX = 64;
let nextListId = 0;
function listId(list: object, content: () => unknown): string {
  let id = listIds.get(list);
  if (id === undefined) {
    const text = JSON.stringify(content());
    id = contentIds.get(text);
    if (id === undefined) {
      if (contentIds.size >= CONTENT_IDS_MAX) contentIds.clear();
      id = `${nextListId++}`;
      contentIds.set(text, id);
    }
    listIds.set(list, id);
  }
  return id;
}

function drawKey(body: string, candidates: readonly MentionCandidate[], attachments: readonly ChatAttachmentRecord[]) {
  if (!body.includes("@")) return body;
  const people = listId(candidates, () => candidates.map((candidate) => [candidate.kind, candidate.handle]));
  return `${body}\u0000${people}\u0000${listId(attachments, () => attachments)}`;
}

// Draws a body on the main thread when that is cheap and safe; null means it
// goes to the worker.
function drawNow(
  key: string,
  body: string,
  candidates: readonly MentionCandidate[],
  attachments: readonly ChatAttachmentRecord[],
): Drawn | null {
  const known = recall(key);
  if (known) return known;
  if (!MARKDOWN_SYNTAX.test(body)) {
    const chips = chatChips(body, candidates, attachments);
    return { content: <PlainText body={body} chips={chips} strip={false} />, chips, copiesSource: true, weight: 0 };
  }
  const sync = fitsMainThread(body);
  if (gaveUp.has(hash(body))) return textOnly(body, sync ? chatChips(body, candidates, attachments) : []);
  if (!sync) return null;
  const chips = chatChips(body, candidates, attachments);
  let value: Drawn | undefined;
  try {
    const parsed = parseChatMarkdown(body, chips);
    if (withinChatMarkdownLimits(parsed)) {
      value = { content: drawTree(parsed.tree), chips, copiesSource: parsed.copiesSource, weight: chatMarkdownWeight(parsed) };
    }
  } catch {
    value = undefined;
  }
  if (!value) {
    gaveUp.add(hash(body));
    value = textOnly(body, chips);
  }
  remember(key, value, value.weight);
  return value;
}

function drawLater(
  key: string,
  body: string,
  candidates: readonly MentionCandidate[],
  attachments: readonly ChatAttachmentRecord[],
): Promise<Drawn> {
  let pending = parsing.get(key);
  if (pending) return pending;
  pending = parseChatInWorker({ body, candidates, attachments }).then((answer) => {
    parsing.delete(key);
    let value: Drawn | undefined;
    if (answer?.parsed) {
      try {
        const { tree, copiesSource, weight } = answer.parsed;
        value = { content: drawTree(tree), chips: answer.chips, copiesSource, weight };
      } catch {
        value = undefined;
      }
    }
    if (!value) {
      gaveUp.add(hash(body));
      value = textOnly(body, answer?.chips ?? []);
    }
    remember(key, value, value.weight);
    return value;
  });
  parsing.set(key, pending);
  return pending;
}

const NO_ATTACHMENTS: readonly ChatAttachmentRecord[] = [];

// Memoized per message: the body is read again only when it, the mention
// candidates or the attachments change.
export const ChatMarkdown = memo(function ChatMarkdown(props: {
  body: string;
  candidates: readonly MentionCandidate[];
  attachments?: readonly ChatAttachmentRecord[];
  testId?: string;
  onOpenPath?: (path: string, headingAnchor?: string) => void;
  className?: string;
}) {
  const { body, candidates } = props;
  const attachments = props.attachments ?? NO_ATTACHMENTS;
  const key = useMemo(() => drawKey(body, candidates, attachments), [body, candidates, attachments]);
  const now = useMemo(() => drawNow(key, body, candidates, attachments), [key, body, candidates, attachments]);
  const [later, setLater] = useState<{ key: string; value: Drawn } | null>(null);
  useEffect(() => {
    if (now) return;
    let current = true;
    void drawLater(key, body, candidates, attachments).then((value) => {
      if (current) setLater({ key, value });
    });
    return () => {
      current = false;
    };
  }, [now, key, body, candidates, attachments]);
  const ready = now ?? (later?.key === key ? later.value : null);
  const shown = useMemo(() => ready ?? textOnly(body, []), [ready, body]);
  const scope = useMemo(
    () => ({ chips: shown.chips, testId: props.testId, onOpenPath: props.onOpenPath }),
    [shown.chips, props.testId, props.onOpenPath],
  );
  return (
    <div
      data-testid={props.testId}
      onCopy={(event) => copySource(event, body, shown.copiesSource)}
      className={`min-w-0 select-text cursor-text break-words text-[14px] leading-[22px] text-ink ${props.className ?? ""}`}
    >
      <ChatTextContext value={scope}>{shown.content}</ChatTextContext>
    </div>
  );
});

