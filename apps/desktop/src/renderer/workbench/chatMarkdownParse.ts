import type { Nodes as HastNodes, Root as HastRoot } from "hast";
import type { Nodes as MdNodes, Parents as MdParents, PhrasingContent, Root as MdRoot } from "mdast";
import remarkGfm from "remark-gfm";
import remarkParse from "remark-parse";
import remarkRehype from "remark-rehype";
import { unified } from "unified";
import { findMentions, type MentionCandidate } from "@dohc/workspace-contracts/chat-mentions";
import type { ChatAttachmentRecord } from "../../ipc/bridgeContract";
import {
  extractChatFileReferenceTokens,
  fileReferenceKey,
  resolveFileMentionNavigationTargets,
  type FileMentionNavigationTarget,
} from "./chatFileMentions";

// How a chat message's Markdown becomes a tree to draw. It holds no React and
// no DOM, so the chat's parse worker runs it too. Chat text comes from other
// people, agents and link holders: raw HTML stays text, and the tree it
// returns is plain data.

// Above this length a message shows as text without its Markdown syntax.
export const CHAT_MARKDOWN_MAX_LENGTH = 50_000;
// Bodies up to this length that pass `fitsMainThread` parse where they are
// drawn. Longer ones parse in the worker.
export const CHAT_MARKDOWN_SYNC_LENGTH = 1024;
// A tree with more nodes than this costs the main thread too much to draw,
// so its message shows as text. An ordinary 50,000-character reply has about
// 10,000. Drawing recurses, so a tree deeper than the depth limit shows as
// text too.
export const CHAT_MARKDOWN_MAX_NODES = 16_000;
export const CHAT_MARKDOWN_MAX_DEPTH = 64;

export const SAFE_HREF = /^(?:https?:\/\/|mailto:)/iu;

// A mention or a page reference, at its range in the message's source. The
// ranges come from the scanners the engine indexes with, so a chip appears
// exactly where the engine saw a mention, and never inside code.
export type Chip =
  | { kind: "mention"; start: number; end: number; mentionKind: MentionCandidate["kind"] }
  | { kind: "file"; start: number; end: number; path: string; heading?: string; target: FileMentionNavigationTarget };

export function chatChips(
  body: string,
  candidates: readonly MentionCandidate[],
  attachments: readonly ChatAttachmentRecord[],
): Chip[] {
  if (!body.includes("@")) return [];
  const fileTokens = extractChatFileReferenceTokens(body);
  const targets = resolveFileMentionNavigationTargets(fileTokens, attachments);
  const mentions = findMentions(body, candidates, { ignoreCode: true });
  // Both lists are in source order; merge them in one walk. A file token owns
  // its whole range, so a handle inside a filename is not a mention.
  const chips: Chip[] = [];
  let file = 0;
  for (const mention of mentions) {
    while (file < fileTokens.length && fileTokens[file]!.end <= mention.start) chips.push(fileChip(fileTokens[file++]!));
    const token = fileTokens[file];
    if (token && token.start < mention.end) continue;
    chips.push({ kind: "mention", start: mention.start, end: mention.end, mentionKind: mention.candidate.kind });
  }
  while (file < fileTokens.length) chips.push(fileChip(fileTokens[file++]!));
  return chips;

  function fileChip(token: (typeof fileTokens)[number]): Chip {
    return {
      kind: "file",
      start: token.start,
      end: token.end,
      path: token.path,
      ...(token.headingAnchor ? { heading: token.headingAnchor } : {}),
      target: targets.get(fileReferenceKey(token)) ?? token,
    };
  }
}

// Shapes that slow the parser even in a short body: deep quote or list
// nesting, deep bracket nesting, tables with many cells, many short lines,
// and many emphasis, bracket or code marks. A body with one of them parses in
// the worker instead. One pass, no regular expression.
const MAX_DEPTH = 16;
const MAX_TABLE_CELLS = 400;
const MAX_LINES = 128;
const MAX_MARKS = 128;

export function fitsMainThread(body: string): boolean {
  if (body.length > CHAT_MARKDOWN_SYNC_LENGTH) return false;
  let brackets = 0;
  let columns = 0;
  let cells = 0;
  let lines = 0;
  let marks = 0;
  for (let lineStart = 0; lineStart <= body.length; ) {
    let lineEnd = body.indexOf("\n", lineStart);
    if (lineEnd < 0) lineEnd = body.length;
    let depth = 0;
    let at = lineStart;
    let pipes = 0;
    let dashes = 0;
    let other = false;
    // Containers: indentation, quote markers and list markers.
    for (; at < lineEnd; at++) {
      const char = body[at];
      if (char === " ") depth += 0.5;
      else if (char === "\t") depth += 2;
      else if (char === ">") depth += 1;
      else if ((char === "-" || char === "*" || char === "+") && (body[at + 1] === " " || body[at + 1] === "\t")) depth += 1;
      else if (char === "." || char === ")" || (char! >= "0" && char! <= "9")) depth += 0.25;
      else break;
    }
    if (depth > MAX_DEPTH || ++lines > MAX_LINES) return false;
    for (let scan = lineStart; scan < lineEnd; scan++) {
      const char = body[scan];
      if (char === "*" || char === "_" || char === "~" || char === "[" || char === "]" || char === "`") {
        if (++marks > MAX_MARKS) return false;
      }
      if (char === "\\") scan++;
      else if (char === "[") {
        if (++brackets > MAX_DEPTH) return false;
      } else if (char === "]") brackets = Math.max(0, brackets - 1);
      if (char === "|") pipes++;
      else if (char === "-") dashes++;
      else if (char !== ":" && char !== " " && char !== "\t" && char !== "\r") other = true;
    }
    if (lineStart === lineEnd || (lineEnd - lineStart === 1 && body[lineStart] === "\r")) columns = 0;
    else if (!other && pipes > 0 && dashes > 0) columns = pipes + 1;
    else if (columns > 0 && (cells += columns) > MAX_TABLE_CELLS) return false;
    lineStart = lineEnd + 1;
  }
  return true;
}

// A chip's source becomes one marker before parsing, so the parser treats the
// chip as a single word at exactly its range: escapes, emphasis and link
// syntax around or inside it cannot move it. The markers are noncharacters,
// which a body never needs; any in the body become U+FFFD so none is forged.
const OPEN = "\uFDD0";
const CLOSE = "\uFDD1";
const MARKER = /\uFDD0(\d+)\uFDD1/gu;
const STRAY = /[\uFDD0\uFDD1]/gu;

function markChips(body: string, chips: readonly Chip[]): { source: string; texts: string[] } {
  // Chips with the same text share a marker, so a reference link's label
  // still matches its definition's.
  const ids = new Map<string, number>();
  const texts: string[] = [];
  let source = "";
  let cursor = 0;
  chips.forEach((chip, index) => {
    const text = body.slice(chip.start, chip.end);
    let id = ids.get(text);
    if (id === undefined) {
      id = index;
      ids.set(text, id);
    }
    texts[id] = text;
    source += body.slice(cursor, chip.start).replace(STRAY, "\uFFFD") + OPEN + id + CLOSE;
    cursor = chip.end;
  });
  return { source: source + body.slice(cursor).replace(STRAY, "\uFFFD"), texts };
}

const NEWLINE = /\r?\n|\r/u;
// Nodes whose children are blocks. Raw HTML among them reads as a paragraph.
const FLOW_PARENTS = new Set(["root", "blockquote", "listItem", "footnoteDefinition"]);

// Rewrites the Markdown tree for chat: markers in text become chip spans,
// markers anywhere else read as their chip's text again, raw HTML becomes
// text, and each newline in text becomes a line break, as remark-breaks
// does, so Shift+Enter keeps its break. It also finds what the message hides:
// whole-message copy gives the Markdown source only when the source shows
// nothing the reader could not see.
function rewrite(tree: MdRoot, texts: readonly string[]): { hides: boolean } {
  const restore = (value: string) => (value.includes(OPEN) ? value.replace(MARKER, (_, id: string) => texts[Number(id)] ?? "") : value);
  let hides = false;
  const footnotes = new Set<string>();
  const notes: string[] = [];

  const visit = (node: MdNodes, inLink: boolean) => {
    switch (node.type) {
      case "definition":
        hides = true;
        break;
      case "footnoteDefinition":
        notes.push(node.identifier);
        break;
      case "footnoteReference":
        footnotes.add(node.identifier);
        break;
      case "link":
        if (node.title || !SAFE_HREF.test(node.url.trim())) hides = true;
        break;
      case "image":
        if (node.title || inLink || !SAFE_HREF.test(node.url.trim())) hides = true;
        break;
      case "code":
        if (node.lang || node.meta) hides = true;
        break;
    }
    for (const field of ["value", "alt", "title", "url", "label", "lang", "meta"] as const) {
      const value = (node as Partial<Record<typeof field, unknown>>)[field];
      if (typeof value === "string" && node.type !== "text") {
        (node as Partial<Record<typeof field, string>>)[field] = restore(value);
      }
    }
    if (!("children" in node)) return;
    const parent = node as MdParents;
    const link = inLink || node.type === "link" || node.type === "linkReference";
    const flow = FLOW_PARENTS.has(node.type);
    const children: MdNodes[] = [];
    for (const child of parent.children as MdNodes[]) {
      if (child.type === "html" && flow) children.push({ type: "paragraph", children: splitText(child.value) });
      else if (child.type === "text" || child.type === "html") children.push(...splitText(child.value));
      else {
        visit(child, link);
        children.push(child);
      }
    }
    parent.children = children as typeof parent.children;
  };

  const splitText = (value: string): PhrasingContent[] => {
    const pieces: PhrasingContent[] = [];
    const pushText = (text: string) =>
      text.split(NEWLINE).forEach((line, at) => {
        if (at > 0) pieces.push({ type: "break" });
        if (line) pieces.push({ type: "text", value: line });
      });
    let cursor = 0;
    for (const match of value.matchAll(MARKER)) {
      pushText(value.slice(cursor, match.index));
      const id = Number(match[1]);
      pieces.push({
        type: "text",
        value: texts[id] ?? "",
        data: { hName: "span", hProperties: { dataChatChip: String(id) } },
      });
      cursor = match.index + match[0].length;
    }
    pushText(value.slice(cursor));
    return pieces;
  };

  visit(tree, false);
  if (notes.some((note) => !footnotes.has(note))) hides = true;
  return { hides };
}

const processor = unified().use(remarkParse).use(remarkGfm).use(remarkRehype).freeze();

export interface ParsedChatMarkdown {
  tree: HastRoot;
  // Whether whole-message copy may give the Markdown source.
  copiesSource: boolean;
  nodes: number;
  depth: number;
}

// Parses a body with its chips. It can throw, as on a stack overflow; the
// caller shows the body as text then.
export function parseChatMarkdown(body: string, chips: readonly Chip[]): ParsedChatMarkdown {
  const { source, texts } = markChips(body, chips);
  const mdast = processor.parse(source);
  const { hides } = rewrite(mdast, texts);
  const tree = processor.runSync(mdast) as HastRoot;
  const size = { nodes: 0, depth: 0 };
  prune(tree, 1, size);
  return { tree, copiesSource: !hides, ...size };
}

export interface ChatParseRequest {
  id: number;
  body: string;
  candidates: readonly MentionCandidate[];
  attachments: readonly ChatAttachmentRecord[];
}

// What crosses back from the worker: plain data, the chips and, for a body
// that parsed within the limits, the tree and whether copy may give the source.
export interface ChatParseAnswer {
  id: number;
  chips: Chip[];
  parsed?: { tree: HastRoot; copiesSource: boolean };
}

export function answerChatParse(request: ChatParseRequest): ChatParseAnswer {
  let chips: Chip[] = [];
  try {
    chips = chatChips(request.body, request.candidates, request.attachments);
    if (request.body.length > CHAT_MARKDOWN_MAX_LENGTH) return { id: request.id, chips };
    const parsed = parseChatMarkdown(request.body, chips);
    if (parsed.nodes > CHAT_MARKDOWN_MAX_NODES || parsed.depth > CHAT_MARKDOWN_MAX_DEPTH) return { id: request.id, chips };
    return { id: request.id, chips, parsed: { tree: parsed.tree, copiesSource: parsed.copiesSource } };
  } catch {
    return { id: request.id, chips };
  }
}

// Drops source positions, which the drawing does not use, and measures the tree.
function prune(node: HastNodes, depth: number, size: { nodes: number; depth: number }) {
  delete node.position;
  size.nodes++;
  size.depth = Math.max(size.depth, depth);
  if ("children" in node) for (const child of node.children) prune(child, depth + 1, size);
}
