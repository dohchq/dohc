import {
  createContext,
  memo,
  useContext,
  useMemo,
  type ClipboardEvent,
  type CSSProperties,
  type KeyboardEvent,
  type MouseEvent,
  type ReactElement,
  type ReactNode,
} from "react";
import Markdown, { type Components, type ExtraProps } from "react-markdown";
import remarkGfm from "remark-gfm";
import { findMentions, type MentionCandidate } from "@dohc/workspace-contracts/chat-mentions";
import type { ChatAttachmentRecord } from "../../ipc/bridgeContract";
import { activateReadOnlyLinkHref } from "../linkActivation";
import { CopyButton } from "../ui/CopyButton";
import { Ref } from "../ui/Ref";
import {
  extractChatFileReferenceTokens,
  fileReferenceKey,
  resolveFileMentionNavigationTargets,
  type FileMentionNavigationTarget,
} from "./chatFileMentions";

// A chat message's body, rendered as Markdown. Chat text comes from other
// people, agents and link holders, so it renders no raw HTML (react-markdown
// shows it as text), loads no remote image, and opens only http, https and
// mailto links, through the same path a read-only document uses.

// A mention or a page reference, at its range in the message's source. The
// ranges come from the scanners the engine indexes with, so a chip appears
// exactly where the engine saw a mention, and never inside code.
type Chip =
  | { kind: "mention"; start: number; end: number; mentionKind: MentionCandidate["kind"] }
  | { kind: "file"; start: number; end: number; path: string; heading?: string; target: FileMentionNavigationTarget };

function chatChips(
  body: string,
  candidates: readonly MentionCandidate[],
  attachments: readonly ChatAttachmentRecord[],
): Chip[] {
  const fileTokens = extractChatFileReferenceTokens(body);
  const targets = resolveFileMentionNavigationTargets(fileTokens, attachments);
  // A file token owns its whole range: a handle inside a filename is not a mention.
  const mentions = findMentions(body, candidates, { ignoreCode: true }).filter(
    (mention) => !fileTokens.some((token) => mention.start < token.end && mention.end > token.start),
  );
  const chips: Chip[] = [
    ...fileTokens.map((token): Chip => ({
      kind: "file",
      start: token.start,
      end: token.end,
      path: token.path,
      ...(token.headingAnchor ? { heading: token.headingAnchor } : {}),
      target: targets.get(fileReferenceKey(token)) ?? token,
    })),
    ...mentions.map((mention): Chip => ({
      kind: "mention",
      start: mention.start,
      end: mention.end,
      mentionKind: mention.candidate.kind,
    })),
  ];
  return chips.sort((left, right) => left.start - right.start);
}

// The few mdast fields the plugin reads and writes.
interface MdNode {
  type: string;
  value?: string;
  children?: MdNode[];
  position?: { start: { offset?: number }; end: { offset?: number } };
  data?: { hName?: string; hProperties?: Record<string, string> };
}

const NEWLINE = /\r?\n|\r/u;

// Splits text nodes in two ways. A chip's source text becomes a span the
// `span` component draws as the chip; chips stay out of link text, where a
// page chip's button cannot sit. Then every remaining newline becomes a line
// break, as remark-breaks does, so Shift+Enter keeps its break.
function remarkChatText(options: { body: string; chips: readonly Chip[] }) {
  const split = (node: MdNode, inLink: boolean): MdNode[] => {
    const value = node.value ?? "";
    const from = node.position?.start.offset;
    const to = node.position?.end.offset;
    const pieces: MdNode[] = [];
    let cursor = 0;
    if (!inLink && from !== undefined && to !== undefined) {
      options.chips.forEach((chip, index) => {
        if (chip.start < from || chip.end > to) return;
        // The node's value can differ from its source, as escapes do, so
        // find the chip's own text rather than trust the offset.
        const text = options.body.slice(chip.start, chip.end);
        const at = value.indexOf(text, cursor);
        if (at < 0) return;
        if (at > cursor) pieces.push({ type: "text", value: value.slice(cursor, at) });
        pieces.push({
          type: "chatChip",
          data: { hName: "span", hProperties: { dataChatChip: String(index) } },
          children: [{ type: "text", value: text }],
        });
        cursor = at + text.length;
      });
    }
    if (cursor < value.length) pieces.push({ type: "text", value: value.slice(cursor) });
    return pieces.flatMap((piece) => {
      if (piece.type !== "text" || !NEWLINE.test(piece.value ?? "")) return [piece];
      return (piece.value ?? "").split(NEWLINE).flatMap((line, at): MdNode[] => [
        ...(at > 0 ? [{ type: "break" }] : []),
        ...(line ? [{ type: "text", value: line }] : []),
      ]);
    });
  };
  const visit = (node: MdNode, inLink: boolean) => {
    if (!node.children) return;
    const link = inLink || node.type === "link" || node.type === "linkReference";
    node.children = node.children.flatMap((child) => {
      if (child.type === "text") return split(child, link);
      visit(child, link);
      return [child];
    });
  };
  return (tree: MdNode) => visit(tree, false);
}

interface ChatTextScope {
  chips: readonly Chip[];
  testId?: string;
  onOpenPath?: (path: string, headingAnchor?: string) => void;
}

const ChatTextContext = createContext<ChatTextScope>({ chips: [] });

function ChipView(props: { index: number; children?: ReactNode }) {
  const scope = useContext(ChatTextContext);
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
  const onOpenPath = scope.onOpenPath;
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

const SAFE_HREF = /^(?:https?:\/\/|mailto:)/iu;

// Outside links open the way a read-only document's do. Anything else, such
// as a relative path or a scheme dohc does not open, reads as plain text.
function ChatLink(props: { href?: string; children?: ReactNode }) {
  const href = props.href?.trim();
  if (!href || !SAFE_HREF.test(href)) return <>{props.children}</>;
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
      {props.children}
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
      <div className="absolute right-1 top-1 rounded-md bg-panel-2 opacity-0 transition-opacity duration-75 focus-within:opacity-100 group-hover/code:opacity-100">
        <CopyButton iconOnly label="Copy code" getText={() => code} />
      </div>
    </div>
  );
}

// Each block keeps 6px from the one before it, and none from the edges, so a
// one-line message stays one line tall.
const BLOCK = "mb-0 mt-1.5 first:mt-0";
const LIST = `${BLOCK} pl-[22px] marker:text-muted [li>&]:mt-0.5`;
const HEADING = "mb-0 mt-2 first:mt-0 text-[15px] font-semibold leading-[22px]";
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
  // as a link to the image instead.
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

// Copying a whole message copies what its author wrote, Markdown and all.
// A selection inside it copies the text as shown.
function copySource(event: ClipboardEvent<HTMLDivElement>, body: string) {
  const selection = document.getSelection();
  if (!selection || selection.isCollapsed || selection.rangeCount !== 1) return;
  const range = selection.getRangeAt(0);
  const root = event.currentTarget;
  if (!root.contains(range.startContainer) || !root.contains(range.endContainer)) return;
  if (range.toString().trim() !== (root.textContent ?? "").trim()) return;
  event.preventDefault();
  event.clipboardData.setData("text/plain", body);
}

// Text the Markdown parser would turn into one paragraph of the same text:
// nothing Markdown or GFM gives meaning to, no blank line, and no edge
// spaces. Most chat lines are like this, so they skip the parser.
const MARKDOWN_SYNTAX = /[\\`*_~\[\]<>&|#!:]|\w@|www\.|^\s|\s$|^\s*(?:[-+=]|\d+[.)])/mu;

function PlainText(props: { body: string; chips: readonly Chip[] }) {
  const content: ReactNode[] = [];
  const pushText = (text: string, key: number) =>
    text.split(NEWLINE).forEach((line, at) => {
      if (at > 0) content.push(<br key={`${key}:${at}`} />, "\n");
      if (line) content.push(line);
    });
  let cursor = 0;
  props.chips.forEach((chip, index) => {
    pushText(props.body.slice(cursor, chip.start), cursor);
    content.push(<ChipView key={`chip:${chip.start}`} index={index}>{props.body.slice(chip.start, chip.end)}</ChipView>);
    cursor = chip.end;
  });
  pushText(props.body.slice(cursor), cursor);
  return <p className={BLOCK}>{content}</p>;
}

// Parsed bodies of recent messages, so reopening a chat or scrolling back to a
// message skips the parse. The tree holds where each chip sits, not what it
// opens, so the key is the body and the chip ranges.
const PARSED_LIMIT = 500;
const parsed = new Map<string, ReactElement>();

function parseBody(body: string, chips: readonly Chip[]): ReactElement {
  const key = `${body}\u0000${chips.map((chip) => `${chip.start}-${chip.end}`).join(",")}`;
  const cached = parsed.get(key);
  if (cached) {
    parsed.delete(key);
    parsed.set(key, cached);
    return cached;
  }
  const element = Markdown({
    children: body,
    components: COMPONENTS,
    remarkPlugins: [remarkGfm, [remarkChatText, { body, chips }]],
  });
  parsed.set(key, element);
  if (parsed.size > PARSED_LIMIT) parsed.delete(parsed.keys().next().value!);
  return element;
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
  const attachments = props.attachments ?? NO_ATTACHMENTS;
  const chips = useMemo(
    () => chatChips(props.body, props.candidates, attachments),
    [props.body, props.candidates, attachments],
  );
  const content = useMemo(
    () => MARKDOWN_SYNTAX.test(props.body)
      ? parseBody(props.body, chips)
      : <PlainText body={props.body} chips={chips} />,
    [props.body, chips],
  );
  const scope = useMemo(
    () => ({ chips, testId: props.testId, onOpenPath: props.onOpenPath }),
    [chips, props.testId, props.onOpenPath],
  );
  return (
    <div
      data-testid={props.testId}
      onCopy={(event) => copySource(event, props.body)}
      className={`min-w-0 select-text cursor-text break-words text-[14px] leading-[22px] text-ink ${props.className ?? ""}`}
    >
      <ChatTextContext value={scope}>{content}</ChatTextContext>
    </div>
  );
});
