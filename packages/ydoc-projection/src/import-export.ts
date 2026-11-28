import { utf8ByteLength } from "@dohc/live-session-contract/limits";
import type { AnyExtension, JSONContent } from "@tiptap/core";
import { Extension, getSchema } from "@tiptap/core";
import {
  getDefaults,
  Lexer,
  Marked,
  Tokenizer,
  type marked,
  type Token,
  type Tokens,
  type TokensList,
} from "marked";
import type { Node as ProseMirrorNode } from "@tiptap/pm/model";
import { StarterKit } from "@tiptap/starter-kit";
import { TableCell, TableHeader, TableRow } from "@tiptap/extension-table";
import { prosemirrorToYXmlFragment, yXmlFragmentToProseMirrorRootNode } from "y-prosemirror";
import * as Y from "yjs";
import {
  DohcMarkdownTable,
  DohcTaskItem,
  dohcMarkdownExtensions,
  escapeHighlightMarkdown,
  GFM_TABLE_CELL_BLOCK_SEPARATOR,
  joinSealedBlocks,
  MarkdownBulletList,
  MarkdownListItem,
  MarkdownOrderedList,
  DohcProjectedMarkdownLists,
  MarkdownParagraph,
  MarkdownTaskList,
  markdownListParseState,
  readInline,
  writingTableCellTokens,
} from "./dohc-markdown-extensions.js";
import { assertSupportedListMarkdown } from "./list-markdown.js";
import { sanitizeImageSrc } from "./image-src.js";
import { backtickFence, codeBlockFence } from "./markdown-fence.js";
import { DohcMarkdownManager, type InlineTokens } from "./inline-marks.js";
import { getDohcYDocBodyFragment } from "./body-fragment.js";
import { newBodyWeight, writeNewBody } from "./bodySequenceWriter.js";
import { readBodySequence } from "./bodySequenceYjs.js";
import {
  fitsNewNote,
  keySorts,
  WORKER_LIVE_VALIDATION_POLICY,
  type NewNoteCounts,
} from "./liveValidationPolicy.js";
import { readLiveUpdateAsTheCutDoes } from "./orderedLiveUpdateCut.js";
import { SOURCE_META_KEYS } from "./artifact-markdown.js";
import {
  FRONTMATTER_SOURCE_META_KEY,
  frontmatterBlockFor,
  MARKDOWN_CRLF_META_KEY,
  orderFrontmatter,
  parseFrontmatter,
} from "./frontmatter.js";
import {
  engineReadOfFrontmatter,
  frontmatterMapValues,
  recordFrontmatterSourceItems,
  writeFrontmatterMap,
  writtenFrontmatterKeys,
} from "./frontmatter-map.js";
import { BODY_SEQUENCE_SCHEMA_VERSION, readsBodySequence } from "./bodySequenceStore.js";

const PLAIN_TEXT_FIELD = "plainText";
const FRONTMATTER_FIELD = "frontmatter";
const META_FIELD = "meta";
export const DOHC_SCHEMA_VERSION = 1;
const PLAIN_TEXT_CONTENT_KIND = "plain-text";
const PARSE_SENTINEL_RE = /\uE000DOHC_PARSE_\d+\uE001/gu;
// The block escapes the serializer writes anywhere: references the parser
// reads as their character wherever they appear.
const BLOCK_ESCAPE_CODES = new Set([13, 35, 36, 41, 42, 43, 45, 46, 61, 91, 95, 96, 126, 160]);
// A block escape, its once-encoded spelling, or a decimal reference to ASCII
// punctuation, a space, a tab, or a newline, which the serializer writes
// inside a tag.
const PARSE_REFERENCE_RE = new RegExp(
  `(?:&amp;|&AMP;|&#0{0,5}38;|&#[xX]0{0,4}26;)#(?:${[...BLOCK_ESCAPE_CODES].join("|")});` +
    "|&#(9|10|13|3[2-9]|4[0-7]|5[89]|6[0-4]|9[1-6]|12[3-6]|160);",
  "gu",
);
// The parse in progress: the references it set aside, by sentinel, and the
// sentinels that stand for the file's own `<` and `>`, in raw HTML or text,
// until its tag spans are read, so only the serializer's `&lt;` and `&gt;`
// open and close one.
let parseReferences: ReadonlyMap<string, string> = new Map();
let parseTabs: ReadonlyMap<string, string> = new Map();
let noteLinks: TokensList["links"] | undefined;
let rawHtmlMarkup = { lt: "<", gt: ">", used: false };

// Raw HTML and link reference definitions are sealed: the document holds the
// file's source, references and all, and both writers write it back. Tiptap
// would read HTML through the DOM in a browser, which drops a comment and
// turns tags into marks, and it drops a definition.
const sealedBlock = (token: { raw?: string }): JSONContent => ({
  type: "rawBlock",
  attrs: { source: token.raw ?? "" },
});
// An HTML block that never closes runs to the end of its container, so it
// would take in any block an edit adds after it. It reads as text instead,
// which dohc writes differently, so the note is held.
const CLOSING_HTML: ReadonlyArray<readonly [RegExp, (open: RegExpExecArray) => string]> = [
  [/^ {0,3}<(pre|script|style|textarea)(?=[\s>]|$)/iu, (open) => `</${open[1]!.toLowerCase()}>`],
  [/^ {0,3}<!--/u, () => "-->"],
  [/^ {0,3}<!\[CDATA\[/iu, () => "]]>"],
  [/^ {0,3}<\?/u, () => "?>"],
  [/^ {0,3}<![A-Za-z]/u, () => ">"],
];
const MarkdownHtml = Extension.create({
  name: "markdownHtml",
  markdownTokenName: "html",
  parseMarkdown: (token) => {
    const raw = token.raw ?? "";
    for (const [opener, closer] of CLOSING_HTML) {
      const open = opener.exec(raw);
      if (!open) continue;
      if (raw.slice(open[0].length).toLowerCase().includes(closer(open))) break;
      return { type: "paragraph", content: [{ type: "text", text: raw.trimEnd() }] };
    }
    return sealedBlock(token);
  },
});

const MarkdownDefinition = Extension.create({
  name: "markdownDefinition",
  markdownTokenName: "def",
  parseMarkdown: (token) =>
    typeof token.dohcText === "string"
      ? { type: "paragraph", content: [{ type: "text", text: token.dohcText }] }
      : sealedBlock(token),
});

function definitionText(raw: string): string {
  return raw
    .replace(/\s+$/u, "")
    .split("\n")
    .map((line) => line.trimStart())
    .join("\n");
}

// The serializer writes a definition the document holds as text as one tag
// span: each character that could read as syntax is a reference, and `&`,
// `<`, and `>` are Tiptap's entities, so no renderer reads syntax in it. A
// block that holds exactly those bytes for a text that reads as one whole
// definition is that text again. Any other block reads as it did, so a
// definition a person writes with `&#91;` keeps its link, and an escaped `\[`
// stays an escape.
//
// The block runs to its first blank line. A line holding a character the
// serializer writes as a reference ends the search. Each line that could end
// a paragraph holds one, so a block that is no definition costs no more than
// the paragraph marked reads in its place.
function escapedDefinition(src: string): (Tokens.Def & { dohcText: string }) | undefined {
  const opener = /^\uE000DOHC_PARSE_\d+\uE001/u.exec(src);
  if (!opener || parseReferences.get(opener[0]) !== "&#91;") return undefined;
  let start = 0;
  let end = lineEnd(src, 0);
  for (;;) {
    const line = src.slice(start, end).replace(/\uE000DOHC_PARSE_\d+\uE001|&(?:amp|lt|gt);/gu, "");
    if (DEFINITION_REFERENCE_RE.test(line)) return undefined;
    if (end === src.length) break;
    const next = lineEnd(src, end + 1);
    if (/^[ \t]*$/.test(src.slice(end + 1, next))) break;
    start = end + 1;
    end = next;
  }
  const raw = src.slice(0, end);
  const written = restoreParseSentinels(raw, parseReferences);
  const text = written.replace(
    /&(?:#(\d+)|(amp|lt|gt));/g,
    (_entity, code: string | undefined, name: string) =>
      code ? String.fromCodePoint(Number(code)) : ({ amp: "&", lt: "<", gt: ">" }[name] ?? ""),
  );
  if (writtenDefinition(text) !== written) return undefined;
  const definition = literalProbe.def(text);
  if (!definition || definitionText(definition.raw) !== text) return undefined;
  return { ...definition, raw, dohcText: text };
}

// The characters a definition's text writes as references: the ASCII
// punctuation a tag span writes so, `&`, `<`, and `>`, and the paragraph's
// `\r` and NBSP.
const DEFINITION_REFERENCE_RE = /["-.:->@[-`{-~\r ]/;

// The bytes the serializer writes for text it writes as references, a
// definition's or a link's, as a tag span whose last line ends the
// paragraph: a space that ends a line and a newline that ends an empty one
// are references too.
function writtenDefinition(text: string): string {
  return text.replace(
    /["-.:->@[-`{-~\r ]| (?=\n)|(?<=\n)\n/g,
    (character) =>
      ({ "&": "&amp;", "<": "&lt;", ">": "&gt;" })[character] ?? `&#${character.codePointAt(0)};`,
  );
}

function lineEnd(text: string, from: number): number {
  const at = text.indexOf("\n", from);
  return at < 0 ? text.length : at;
}

// A link with no text that holds a line that would end its paragraph cannot
// be held as it is, so the serializer writes it as references, the way it
// writes a definition. A run of text that holds exactly those bytes, for a
// link marked reads with such a line, is that link's text again. Any other
// text, references and all, reads as it did.
//
// Each run is read once, from its first `&#91;&#93;&#40;`: its text, where
// each character sits in the source, the first character from each one on
// that the serializer would write otherwise, the first line or `\r` from each
// one on that `opensBlock` counts, and the reader for its links. So its
// candidates cost no more than the run.
type WrittenRun = {
  text: string;
  at: number[];
  bad: number[];
  opens: number[];
  read: (link: number) => number;
};
let writtenLinks: {
  openers: ReadonlySet<string>;
  runs: Map<string, { run: WrittenRun; link: number; end?: number }>;
  // The text marked last gave the tokenizer, as the tokens it lexes into
  // and its length, and for each such tokens how far from the text's end
  // the next sentinel starts, or 0 for none.
  tokens?: object;
  length: number;
  sentinels: WeakMap<object, number>;
} = { openers: new Set(), runs: new Map(), length: -1, sentinels: new WeakMap() };
// What the serializer writes as a reference: the ASCII punctuation a tag
// span writes so, but `&`, `<`, and `>`, which are entities, and `\r` and
// NBSP.
const WRITTEN_REFERENCE_RE = /["-%'-.:;=@[-`{-~\r\u00a0]/;
const WRITTEN_SENTINEL_AT = /\uE000DOHC_PARSE_\d+\uE001/uy;
const WRITTEN_ENTITY_AT = /&(?:amp|lt|gt);/y;

// The `&#91;` references that open a `&#91;&#93;&#40;` in the prepared file.
function writtenOpeners(prepared: string, references: ReadonlyMap<string, string>): Set<string> {
  const openers = new Set<string>();
  const sentinels = [...prepared.matchAll(PARSE_SENTINEL_RE)];
  for (let index = 0; index + 2 < sentinels.length; index += 1) {
    const run = sentinels.slice(index, index + 3);
    const adjacent = run.every(
      (sentinel, at) => at === 0 || run[at - 1].index + run[at - 1][0].length === sentinel.index,
    );
    const spelled = run.map((sentinel) => references.get(sentinel[0])).join("");
    if (adjacent && spelled === "&#91;&#93;&#40;") openers.add(run[0][0]);
  }
  return openers;
}

function readWrittenRun(src: string): void {
  let text = "";
  const at: number[] = [];
  const written: boolean[] = [];
  const openers: Array<[number, string]> = [];
  let index = 0;
  while (index < src.length) {
    WRITTEN_SENTINEL_AT.lastIndex = index;
    const sentinel = WRITTEN_SENTINEL_AT.exec(src)?.[0];
    WRITTEN_ENTITY_AT.lastIndex = index;
    const entity = sentinel ? undefined : WRITTEN_ENTITY_AT.exec(src)?.[0];
    let character = src[index];
    if (sentinel) {
      const code = /^&#([1-9]\d*);$/.exec(parseReferences.get(sentinel) ?? "")?.[1];
      character = code ? String.fromCodePoint(Number(code)) : "";
      if (!WRITTEN_REFERENCE_RE.test(character) && character !== " " && character !== "\n") break;
      if (character === "[") openers.push([text.length, sentinel]);
    } else if (entity) {
      character = { "&amp;": "&", "&lt;": "<", "&gt;": ">" }[entity] ?? "";
    } else if (WRITTEN_REFERENCE_RE.test(character) || /[&<>]/.test(character)) {
      break;
    }
    at.push(index);
    written.push(Boolean(sentinel ?? entity));
    text += character;
    index += (sentinel ?? entity ?? character).length;
  }
  at.push(index);
  const n = text.length;
  const bad = new Array<number>(n + 1);
  const opens = new Array<number>(n + 1);
  bad[n] = n;
  opens[n] = n;
  for (let at = n - 1; at >= 0; at -= 1) {
    const character = text[at];
    const reference =
      WRITTEN_REFERENCE_RE.test(character) ||
      /[&<>]/.test(character) ||
      (character === " " && text[at + 1] === "\n") ||
      (character === "\n" && text[at - 1] === "\n");
    bad[at] = reference === written[at] ? bad[at + 1] : at;
    OPENS_LINE_RE.lastIndex = at;
    opens[at] =
      (character === "\n" || character === "\r") && OPENS_LINE_RE.test(text) ? at : opens[at + 1];
  }
  const run = { text, at, bad, opens, read: emptyLinkReader(text) };
  for (const [link, sentinel] of openers) {
    if (text.startsWith("[](", link)) writtenLinks.runs.set(sentinel, { run, link });
  }
}

// Where the first sentinel in `src` starts. marked gives `start` the text it
// last gave the tokenizer, less its first character, and each later text it
// lexes into the same tokens ends that text. So one search holds for each
// until the text passes the sentinel it found.
function nextSentinel(src: string): number {
  const tokens = writtenLinks.length === src.length + 1 ? writtenLinks.tokens : undefined;
  const rest = tokens && writtenLinks.sentinels.get(tokens);
  if (rest === 0) return -1;
  const found = rest === undefined ? -1 : src.length - rest;
  if (found >= 0 && src.startsWith("\uE000DOHC_", found)) return found;
  const at = src.indexOf("\uE000DOHC_");
  if (tokens) writtenLinks.sentinels.set(tokens, at < 0 ? 0 : src.length - at);
  return at;
}

// The link with no text the serializer wrote as references at the start of
// `src`, as the text it holds.
function writtenLink(
  src: string,
  tokens: object,
): { type: "escape"; raw: string; text: string } | undefined {
  writtenLinks.tokens = tokens;
  writtenLinks.length = src.length;
  WRITTEN_SENTINEL_AT.lastIndex = 0;
  const opener = WRITTEN_SENTINEL_AT.exec(src)?.[0];
  if (!opener || !writtenLinks.openers.has(opener)) return undefined;
  if (!writtenLinks.runs.has(opener)) readWrittenRun(src);
  const found = writtenLinks.runs.get(opener);
  if (!found) return undefined;
  const { run, link } = found;
  found.end ??= run.read(link);
  const end = found.end;
  if (end < 0 || run.bad[link] < end || run.opens[link] >= end) return undefined;
  return {
    type: "escape",
    raw: src.slice(0, run.at[end] - run.at[link]),
    text: fileAngles(run.text.slice(link, end)),
  };
}

// Source the document keeps as the text the file holds, with each reference
// as the file spells it.
function sourceText(source: string): string {
  return fileAngles(restoreParseSentinels(source, parseReferences));
}

// A `<` or `>` the file holds, in raw HTML or text, is no tag the serializer
// wrote, so it opens and closes no tag span. Tiptap reads `&lt;` and `&gt;`
// as the only `<` and `>` left, and those are the ones that do.
function fileAngles(text: string): string {
  const replaced = text.replaceAll("<", rawHtmlMarkup.lt).replaceAll(">", rawHtmlMarkup.gt);
  rawHtmlMarkup.used ||= replaced !== text;
  return replaced;
}

// A gathered HTML run's raw holds only the closing tag marked consumed, so
// its source is the whole run.
function sealedInline(raw: string, source = raw): Tokens.Generic {
  return { type: "dohcRawInline", raw, dohcSource: source };
}

function inlineSource(token: Token): string {
  const source: unknown = (token as Tokens.Generic).dohcSource;
  return typeof source === "string" ? source : token.raw;
}

const inlineRuns = new WeakSet<Token[]>();

// Tiptap marks only text, so a link or other mark on a picture or a sealed
// piece would drop, and such a run is sealed whole. A table cell writes its
// line break as `<br>`, which the editor holds as the cell's text.
function settleSealedRuns(tokens: Token[], inCell: boolean): void {
  const inline = inlineRuns.has(tokens);
  tokens.forEach((token, index) => {
    const generic = token as Tokens.Generic;
    if (token.type === "table") {
      const table = token as Tokens.Table;
      for (const cell of [...table.header, ...table.rows.flat()])
        settleSealedRuns(cell.tokens, true);
      return;
    }
    if (token.type === "list") {
      for (const item of (token as Tokens.List).items) settleSealedRuns(item.tokens, inCell);
      return;
    }
    const inner = generic.tokens as Token[] | undefined;
    if (inner) settleSealedRuns(inner, inCell);
    if (!inline) {
      // A blank line holding spaces after a sealed block is its own token, so
      // the block takes its line breaks back.
      const next = tokens[index + 1];
      if ((token.type === "html" || token.type === "def") && next?.type === "space")
        token.raw += next.raw;
      return;
    }
    if (inCell && token.type === "dohcRawInline" && token.raw === GFM_TABLE_CELL_BLOCK_SEPARATOR) {
      tokens[index] = { type: "escape", raw: token.raw, text: fileAngles(token.raw) };
    } else if (inner?.some((piece) => piece.type === "image" || piece.type === "dohcRawInline")) {
      tokens[index] = sealedInline(token.raw);
    }
  });
}

const extensions: AnyExtension[] = [
  MarkdownHtml,
  MarkdownDefinition,
  ...dohcMarkdownExtensions,
  StarterKit.configure({
    bulletList: false,
    listItem: false,
    orderedList: false,
    paragraph: false,
  }),
  MarkdownParagraph,
  MarkdownBulletList,
  MarkdownListItem,
  MarkdownOrderedList,
  MarkdownTaskList,
  DohcTaskItem,
  DohcMarkdownTable,
  TableCell,
  TableHeader,
  TableRow,
];
// marked keeps a `def` token only for the first definition of a label and
// discards a later one without a token. Each later one gets a numbered tag
// that starts with `]`, which no reference can name, since a label cannot
// start with an unescaped `]`. So marked keeps its token too, and the line
// stays as text. The count lives with each lexer, so each tag costs one check.
const repeatedDefinitions = new WeakMap<object, number>();
//
// Tiptap applies a link's destination and title to the link's text, so a
// link with no text, as in `[](https://example.com "title")`, vanishes. The
// engine's fold keeps it as text, and so does this: the link becomes an
// `escape` token, which Tiptap keeps as the text the file holds. The
// serializer reads definitions with the same probe.
const literalProbe = new Tokenizer();
literalProbe.lexer = new Lexer({ ...getDefaults(), tokenizer: literalProbe });
const markdownParser = new Marked({
  extensions: [
    {
      // marked's text stops before each `[`, so this needs no start.
      name: "dohcEmptyLink",
      level: "inline",
      tokenizer: (src) => {
        if (!src.startsWith("[](")) return undefined;
        const link = literalProbe.link(src);
        return link?.type === "link"
          ? { type: "escape", raw: link.raw, text: sourceText(link.raw) }
          : undefined;
      },
    },
    {
      // A link with no text the serializer wrote as references. marked's text
      // rule stops at the `_` each sentinel holds, so only the first sentinel
      // can start this text, and a later one is found when the text reaches it.
      name: "dohcWrittenLink",
      level: "inline",
      start: (src) => {
        if (writtenLinks.openers.size === 0) return undefined;
        const at = nextSentinel(src);
        if (at < 0) return undefined;
        WRITTEN_SENTINEL_AT.lastIndex = at;
        const sentinel = WRITTEN_SENTINEL_AT.exec(src)?.[0];
        return sentinel && writtenLinks.openers.has(sentinel) ? at : undefined;
      },
      tokenizer: writtenLink,
    },
    {
      // The lexer's own tag rule reads the tag, so a raw `<a>` or `<pre>` still
      // changes how marked reads the text after it. Each tag is sealed, and an
      // opening tag through its closing tag is one piece, so the Markdown
      // between them stays source. A closing tag gathers that run back from
      // the earliest open tag it closes, the way Tiptap matches them.
      name: "dohcHtmlTag",
      level: "inline",
      tokenizer(src, tokens) {
        if (!src.startsWith("<")) return undefined;
        const tag = this.lexer.options.tokenizer?.tag(src);
        if (!tag) return undefined;
        const { raw } = tag;
        // The tag patterns are Tiptap's own.
        if (/^<\/[\s]*[\w-]+/i.test(raw)) {
          const opened = tokens.findIndex((token) => {
            const name: unknown = (token as Tokens.Generic).dohcOpenTag;
            return typeof name === "string" && new RegExp(`^<\\/\\s*${name}\\b`, "i").test(raw);
          });
          if (opened < 0) return sealedInline(raw);
          return sealedInline(raw, tokens.splice(opened).map(inlineSource).join("") + raw);
        }
        const open = /^<[\s]*([\w-]+)(\s|>|\/|$)/i.exec(raw);
        return open && !raw.endsWith("/>")
          ? { ...sealedInline(raw), dohcOpenTag: open[1] }
          : sealedInline(raw);
      },
    },
  ],
  tokenizer: {
    def(src) {
      const escaped = escapedDefinition(src);
      const token = escaped ?? Tokenizer.prototype.def.call(this, src);
      if (!token || (!escaped && !Object.hasOwn(this.lexer.tokens.links, token.tag))) return token;
      const count = (repeatedDefinitions.get(this.lexer) ?? 0) + 1;
      repeatedDefinitions.set(this.lexer, count);
      token.tag = `]${count}`;
      return token;
    },
    reflink(src, links) {
      const token = Tokenizer.prototype.reflink.call(this, src, links);
      return token && token.type !== "text"
        ? (sealedInline(token.raw) as unknown as Tokens.Link)
        : token;
    },
    inlineText(src) {
      const token = Tokenizer.prototype.inlineText.call(this, src);
      if (token) token.text = fileAngles(token.text);
      return token;
    },
  },
});

// Block lexing must protect content tabs from list indentation expansion, but
// inline lexing must see whitespace when it decides emphasis boundaries.
class ContentTabLexer<ParserOutput = string, RendererOutput = string> extends Lexer<
  ParserOutput,
  RendererOutput
> {
  inlineTokens(src: string, tokens: Token[] = []): Token[] {
    const source = parseTabs.size ? restoreParseSentinels(src, parseTabs) : src;
    const read = readInline(this, tokens, source, () => super.inlineTokens(source, tokens));
    inlineRuns.add(read);
    return read;
  }

  lex(src: string): TokensList {
    if (noteLinks) Object.assign(this.tokens.links, noteLinks);
    const tokens = super.lex(src);
    settleSealedRuns(tokens, false);
    return tokens;
  }
}
markdownParser.Lexer = ContentTabLexer;

const markdownManager = new DohcMarkdownManager({
  marked: markdownParser as unknown as typeof marked,
  extensions,
  indentation: { style: "space", size: 2 },
});
let projectedManager: DohcMarkdownManager | undefined;
function projectedMarkdownManager(): DohcMarkdownManager {
  return (projectedManager ??= new DohcMarkdownManager({
    marked: markdownParser as unknown as typeof marked,
    extensions: extensions.map((extension) =>
      extension.name === "dohcMarkdownLists" ? DohcProjectedMarkdownLists : extension,
    ),
    indentation: { style: "space", size: 2 },
  }));
}
const schema = getSchema(extensions);

type DohcMeta = { schemaVersion: number; contentKind?: "plain-text" };

/** A note with more block elements than `markdownToYDoc`'s `maxElements` allows. */
export class MarkdownCapacityError extends Error {
  constructor() {
    super("markdown-capacity");
  }
}

function withinElements(root: JSONContent, limit: number): boolean {
  let count = 0;
  const stack = [root];
  for (let node = stack.pop(); node !== undefined; node = stack.pop()) {
    if (node.type !== "text" && ++count > limit) return false;
    if (node.content) stack.push(...node.content);
  }
  return true;
}

const SHA256_HEX_BYTES = 64;
const LINEAGE_EPOCH_ENTRIES = 1;

function newNoteCounts(doc: Y.Doc, body: NewNoteCounts, markdown: string): NewNoteCounts | null {
  const read = readLiveUpdateAsTheCutDoes(
    Y.encodeStateAsUpdate(doc),
    WORKER_LIVE_VALIDATION_POLICY,
  );
  if (read.kind === "refused") return null;
  const frontmatter = doc.getMap(FRONTMATTER_FIELD);
  const meta = doc.getMap(META_FIELD);
  const engine = engineReadOfFrontmatter(frontmatter);
  const reserved = SOURCE_META_KEYS.length + LINEAGE_EPOCH_ENTRIES;
  let keptBytes = utf8ByteLength(markdown) + 2 * SHA256_HEX_BYTES;
  for (const key of SOURCE_META_KEYS) keptBytes += utf8ByteLength(META_FIELD + key);
  return {
    structs: read.usage.structVisits + body.structs + reserved,
    elements: body.elements,
    rootEntries: frontmatter.size + meta.size + body.rootEntries + reserved,
    keySorts: keySorts([...frontmatter.values(), ...meta.values()]) + body.keySorts,
    astral: body.astral,
    values: read.usage.valueNodeVisits + body.values + SOURCE_META_KEYS.length,
    markValues: body.markValues,
    bytes: read.usage.decodedPayloadByteVisits + body.bytes + keptBytes,
    markBytes: body.markBytes,
    engineNodes: engine.nodes + body.engineNodes,
    engineBytes: engine.bytes + body.engineBytes,
  };
}

const containerId = (_container: ProseMirrorNode, index: number) => index.toString(36);

/**
 * A new note made from Markdown. With `bodySequence` it is made in format 2, a note whose body is
 * one sequence (`docs/engineering/note-body-sequence.md`), where that format holds it: the note
 * reads as the document the same Markdown gives a format-1 note (`newBodyWeight` lists where it
 * would not), and the save's check and the engine's Markdown writer take it, with room for the
 * three entries of a kept source text. Otherwise, and by default, it is made in format 1. A
 * format-2 note's container ids are each container's number in the document, so every device that
 * makes a note from one text under one `clientID` makes the same bytes.
 */
export function markdownToYDoc(
  markdown: string,
  options: {
    clientID?: number;
    reading?: "source" | "projection";
    maxElements?: number;
    bodySequence?: boolean;
  } = {},
): Y.Doc {
  const usesCrlf = markdown.includes("\r\n");
  const { meta, body, frontmatterSource } = parseFrontmatter(markdown, usesCrlf);
  const tiptapJson = parseRichdocMarkdown(
    usesCrlf ? body.replaceAll("\r\n", "\n") : body,
    options.reading,
  );
  // Checked before the Y.Doc is built, which costs far more memory than parsing.
  if (options.maxElements !== undefined && !withinElements(tiptapJson, options.maxElements))
    throw new MarkdownCapacityError();
  const parsed = schema.nodeFromJSON(tiptapJson);
  const note = (schemaVersion: number) => {
    const doc = new Y.Doc();
    if (options.clientID !== undefined) doc.clientID = options.clientID;
    writeFrontmatterMap(doc.getMap(FRONTMATTER_FIELD), meta);
    writeFrontmatterMap(doc.getMap(META_FIELD), {
      schemaVersion,
      ...(usesCrlf ? { [MARKDOWN_CRLF_META_KEY]: true } : {}),
      ...(frontmatterSource === undefined
        ? {}
        : { [FRONTMATTER_SOURCE_META_KEY]: frontmatterSource }),
    });
    if (frontmatterSource !== undefined) {
      recordFrontmatterSourceItems(doc.getMap(FRONTMATTER_FIELD), doc.getMap(META_FIELD));
    }
    return doc;
  };

  const sequence = options.bodySequence ? newBodyWeight(schema, parsed, containerId) : null;
  if (sequence) {
    const doc = note(BODY_SEQUENCE_SCHEMA_VERSION);
    const counts = newNoteCounts(doc, sequence, markdown);
    if (counts && fitsNewNote(counts, WORKER_LIVE_VALIDATION_POLICY)) {
      writeNewBody(schema, doc, parsed, containerId);
      return doc;
    }
    doc.destroy();
  }
  const doc = note(DOHC_SCHEMA_VERSION);
  prosemirrorToYXmlFragment(parsed, getDohcYDocBodyFragment(doc));
  return doc;
}

/** `note` is the whole note `markdown` is a piece of, so the piece can use its definitions. */
export function parseRichdocMarkdown(
  markdown: string,
  reading: "source" | "projection" = "source",
  note?: string,
): JSONContent {
  const reservedSentinels = new Set(markdown.match(PARSE_SENTINEL_RE) ?? []);
  const entitySentinels = new Map<string, string>();
  let sentinelIndex = 0;
  const reserveSentinel = (): string => {
    let sentinel: string;
    do {
      sentinel = `\uE000DOHC_PARSE_${sentinelIndex}\uE001`;
      sentinelIndex += 1;
    } while (reservedSentinels.has(sentinel));
    reservedSentinels.add(sentinel);
    return sentinel;
  };
  const sentinelFor = (value: string): string => {
    const sentinel = reserveSentinel();
    entitySentinels.set(sentinel, value);
    return sentinel;
  };

  // Canonical list indentation must not make Marked expand a content tab.
  const projectionTabs = new Map<string, string>();
  const preserveTabs = (text: string) =>
    text.replace(/\t/gu, () => {
      const sentinel = reserveSentinel();
      projectionTabs.set(sentinel, "\t");
      return sentinel;
    });
  markdown = assertSupportedListMarkdown(
    markdown,
    reading === "source" && markdown.includes("\t") ? preserveTabs : undefined,
  );
  if (reading === "projection" && markdown.includes("\t")) {
    markdown = preserveTabs(markdown);
  }

  // A block escape reads as its character anywhere, as does a leading space or
  // tab. Any other reference reads so only inside a tag the text holds.
  const tagReferences = new Set<string>();
  const itemWhitespaceEntities = new Set<string>();
  const prepared = markdown.replace(
    PARSE_REFERENCE_RE,
    (entity, code: string | undefined, offset: number, source: string) => {
      if (markdownCharacterIsEscaped(source, offset)) return entity;
      const sentinel = sentinelFor(entity);
      const leading =
        (code === "9" || code === "32") && (offset === 0 || source[offset - 1] === "\n");
      if (
        (code === "9" || code === "32") &&
        source[offset - 1] === " " &&
        (reading === "projection"
          ? /^ *(?:> *)*(?:(?:[-+*]|\d{1,9}[.)]) (?:\[[ xX]\] )?)?$/u
          : /^ *$/u
        ).test(source.slice(source.lastIndexOf("\n", offset - 1) + 1, offset))
      )
        itemWhitespaceEntities.add(sentinel);
      if (code && !BLOCK_ESCAPE_CODES.has(Number(code)) && !leading) {
        tagReferences.add(sentinel);
      }
      return sentinel;
    },
  );
  const markup = { lt: reserveSentinel(), gt: reserveSentinel(), used: false };
  const markupEntities = [
    [markup.lt, "<"],
    [markup.gt, ">"],
  ] as const;
  const encodedEntities = new Map([...entitySentinels, ...markupEntities, ...projectionTabs]);
  const tagEntities = new Map([
    ...Array.from(
      entitySentinels,
      ([sentinel, entity]) => [sentinel, decodeBlockEntity(entity)] as const,
    ),
    ...markupEntities,
    ...projectionTabs,
  ]);
  const decodedEntities = new Map(
    Array.from(
      tagEntities,
      ([sentinel, value]) =>
        [
          sentinel,
          tagReferences.has(sentinel) ? (encodedEntities.get(sentinel) ?? value) : value,
        ] as const,
    ),
  );
  parseReferences = entitySentinels;
  parseTabs = projectionTabs;
  if (note !== undefined) {
    const lexer = new Lexer();
    lexer.blockTokens(note.replace(/\r\n?/gu, "\n"));
    noteLinks = lexer.tokens.links;
  }
  rawHtmlMarkup = markup;
  writtenLinks = {
    openers: writtenOpeners(prepared, entitySentinels),
    runs: new Map(),
    length: -1,
    sentinels: new WeakMap(),
  };
  let parsed: JSONContent;
  try {
    // Include escaped and multiline labels, including definitions inside quotes.
    markdownListParseState.references = markdown.includes("]:") || !!note?.includes("]:");
    parsed = (reading === "projection" ? projectedMarkdownManager() : markdownManager).parse(
      prepared,
    );
  } finally {
    parseReferences = new Map();
    parseTabs = new Map();
    noteLinks = undefined;
    markdownListParseState.references = true;
    rawHtmlMarkup = { lt: "<", gt: ">", used: false };
    writtenLinks = { openers: new Set(), runs: new Map(), length: -1, sentinels: new WeakMap() };
  }
  return ensureListItemParagraphs(
    entitySentinels.size || markup.used || projectionTabs.size
      ? restoreBlockEntityParseSentinels(parsed, {
          decodedEntities,
          encodedEntities,
          tagEntities,
          itemWhitespaceEntities,
        })
      : parsed,
  );
}

// A list item's schema starts with a paragraph. Tiptap hands an item whose
// first block is a table straight through, and the Y.Doc conversion then
// drops the item. An annotated table is the first block of an item whose
// paragraph was empty, so give such an item its paragraph back.
function ensureListItemParagraphs(node: JSONContent, depth = -1, quoteDepth = 0): JSONContent {
  const quotes = quoteDepth + (node.type === "blockquote" ? 1 : 0);
  if (depth > 128 || quotes > 120)
    throw new Error("Markdown is not representable by the live document contract");
  if (node.type === "image" && node.attrs)
    node.attrs.src = sanitizeImageSrc(String(node.attrs.src ?? ""));
  const content = node.content;
  if (!content) return node;
  for (const child of content) ensureListItemParagraphs(child, depth + 1, quotes);
  const blocks = joinSealedBlocks(content);
  node.content = blocks;
  const needsParagraph =
    (node.type === "listItem" || node.type === "taskItem") && blocks[0]?.type !== "paragraph";
  if (needsParagraph) blocks.unshift({ type: "paragraph" });
  return node;
}

function markdownCharacterIsEscaped(source: string, index: number): boolean {
  let backslashes = 0;
  for (let cursor = index - 1; cursor >= 0 && source[cursor] === "\\"; cursor -= 1) {
    backslashes += 1;
  }
  return backslashes % 2 === 1;
}

function decodeBlockEntity(entity: string): string {
  const raw = /^&#(\d+);$/.exec(entity);
  if (raw) return String.fromCodePoint(Number(raw[1]));

  const encoded = /^(?:&amp;|&AMP;|&#0{0,5}38;|&#[xX]0{0,4}26;)(#\d+;)$/.exec(entity);
  if (encoded) return `&${encoded[1]}`;
  throw new Error(`could not decode a Markdown block-escape entity sentinel: ${entity}`);
}

type ParseReferences = {
  itemWhitespaceEntities: ReadonlySet<string>;
  // Each reference's spelling, for code, links, and literal attributes.
  encodedEntities: Map<string, string>;
  // Each reference read where the text holds no tag.
  decodedEntities: Map<string, string>;
  // Each reference read as its character, inside a tag the text holds.
  tagEntities: Map<string, string>;
};

// Where a text node sits in its block's tag span, if the block has one.
type TextSpan = { start: number; end: number; from: number };

function restoreBlockEntityParseSentinels(
  node: JSONContent,
  references: ParseReferences,
  insideCodeBlock = false,
  span?: TextSpan,
  insideItem = false,
): JSONContent {
  const { decodedEntities, encodedEntities, tagEntities, itemWhitespaceEntities } = references;
  insideItem ||= node.type === "listItem" || node.type === "taskItem";
  const restored = node;
  const insideCode =
    insideCodeBlock ||
    node.type === "codeBlock" ||
    node.marks?.some((mark) => mark.type === "code");
  const textSentinels =
    typeof node.text === "string" ? (node.text.match(PARSE_SENTINEL_RE) ?? []) : [];
  const autolink =
    textSentinels.length > 0 &&
    node.marks?.some((mark) => {
      if (mark.type !== "link" || typeof mark.attrs?.href !== "string") {
        return false;
      }
      const hrefSentinels = new Set(mark.attrs.href.match(PARSE_SENTINEL_RE) ?? []);
      return textSentinels.some((sentinel) => hrefSentinels.has(sentinel));
    });
  if (typeof node.text === "string") {
    restored.text =
      insideCode || autolink
        ? restoreParseSentinels(node.text, encodedEntities)
        : node.text.replace(PARSE_SENTINEL_RE, (sentinel, at: number) => {
            const inTag =
              span !== undefined && span.from + at >= span.start && span.from + at < span.end;
            return (
              (inTag ||
              (insideItem &&
                itemWhitespaceEntities.has(sentinel) &&
                (at === 0 || node.text![at - 1] === "\n"))
                ? tagEntities
                : decodedEntities
              ).get(sentinel) ?? sentinel
            );
          });
  }
  if (node.attrs) {
    const preservesLiteralAttributes =
      node.type === "codeBlock" ||
      node.type === "mathInline" ||
      node.type === "mathBlock" ||
      node.type === "wikilink" ||
      node.type === "inlineAtom" ||
      node.type === "callout" ||
      node.type === "rawBlock" ||
      node.type === "rawInline";
    const attributes = restoreAttributeSentinels(
      node.attrs,
      preservesLiteralAttributes ? encodedEntities : decodedEntities,
    );
    if (node.type === "image") {
      attributes.src = sanitizeImageSrc(String(attributes.src ?? ""));
    }
    restored.attrs = attributes;
  }
  if (node.marks) {
    restored.marks = node.marks.map((mark) => ({
      ...mark,
      ...(mark.attrs
        ? {
            attrs: restoreAttributeSentinels(
              mark.attrs,
              autolink && mark.type === "link" ? encodedEntities : decodedEntities,
            ),
          }
        : {}),
    }));
  }
  if (node.content) {
    const tag = rawHtmlSpan(node.content);
    let from = 0;
    restored.content = node.content.map((child, index) => {
      const childSpan = tag && { start: tag.start, end: tag.end, from };
      from += tag?.texts[index]?.length ?? 0;
      return restoreBlockEntityParseSentinels(child, references, insideCode, childSpan, insideItem);
    });
  }
  return restored;
}

function restoreAttributeSentinels(
  attributes: Record<string, unknown>,
  replacements: Map<string, string>,
): Record<string, unknown> {
  return Object.fromEntries(
    Object.entries(attributes).map(([name, value]) => [
      name,
      restoreAttributeValueSentinels(value, replacements),
    ]),
  );
}

function restoreAttributeValueSentinels(
  value: unknown,
  replacements: Map<string, string>,
): unknown {
  if (typeof value === "string") {
    return restoreParseSentinels(value, replacements);
  }
  if (Array.isArray(value)) {
    return value.map((item) => restoreAttributeValueSentinels(item, replacements));
  }
  if (value && typeof value === "object") {
    return restoreAttributeSentinels(value as Record<string, unknown>, replacements);
  }
  return value;
}

function restoreParseSentinels(value: string, replacements: ReadonlyMap<string, string>): string {
  return value.replace(PARSE_SENTINEL_RE, (sentinel) => replacements.get(sentinel) ?? sentinel);
}

export function plainTextToYDoc(markdown: string): Y.Doc {
  const { meta, body, frontmatterSource } = parseFrontmatter(markdown, false);
  const doc = new Y.Doc();

  writeFrontmatterMap(doc.getMap(FRONTMATTER_FIELD), meta);
  writeFrontmatterMap(doc.getMap(META_FIELD), {
    schemaVersion: DOHC_SCHEMA_VERSION,
    contentKind: PLAIN_TEXT_CONTENT_KIND,
    ...(frontmatterSource === undefined
      ? {}
      : { [FRONTMATTER_SOURCE_META_KEY]: frontmatterSource }),
  });
  if (frontmatterSource !== undefined) {
    recordFrontmatterSourceItems(doc.getMap(FRONTMATTER_FIELD), doc.getMap(META_FIELD));
  }
  doc.getText(PLAIN_TEXT_FIELD).insert(0, body);

  return doc;
}

export function yDocToMarkdown(doc: Y.Doc): string {
  return markdownWithBody(doc, yDocBodyToMarkdown(doc).trimEnd());
}

/** The properties block a note is written with, as a file that holds nothing else. */
export function yDocPropertiesToMarkdown(doc: Y.Doc): string {
  return markdownWithBody(doc, "");
}

function markdownWithBody(doc: Y.Doc, body: string): string {
  const frontmatter = orderFrontmatter(getDohcYDocFrontmatter(doc));
  const internalMeta = doc.getMap(META_FIELD);
  const usesCrlf =
    internalMeta.get(MARKDOWN_CRLF_META_KEY) === true &&
    internalMeta.get("contentKind") !== PLAIN_TEXT_CONTENT_KIND;
  const restoreLineEndings = (markdown: string): string =>
    usesCrlf ? markdown.replaceAll("\n", "\r\n") : markdown;

  const markdown = `${frontmatterBlockFor(
    frontmatter,
    internalMeta.get(FRONTMATTER_SOURCE_META_KEY),
    body,
    usesCrlf ? "\r\n" : "\n",
    writtenFrontmatterKeys(doc.getMap(FRONTMATTER_FIELD), internalMeta),
  )}${restoreLineEndings(body)}`;
  // A saved note that isn't empty ends with one line break.
  return markdown === "" ||
    markdown.endsWith("\n") ||
    internalMeta.get("contentKind") === PLAIN_TEXT_CONTENT_KIND
    ? markdown
    : `${markdown}${usesCrlf ? "\r\n" : "\n"}`;
}

export function getDohcYDocFrontmatter(doc: Y.Doc): Record<string, unknown> {
  return frontmatterMapValues(doc.getMap(FRONTMATTER_FIELD));
}

export function getDohcYDocMeta(doc: Y.Doc): DohcMeta {
  const meta = frontmatterMapValues(doc.getMap(META_FIELD));
  return {
    schemaVersion:
      typeof meta.schemaVersion === "number" ? meta.schemaVersion : DOHC_SCHEMA_VERSION,
    contentKind: meta.contentKind === PLAIN_TEXT_CONTENT_KIND ? PLAIN_TEXT_CONTENT_KIND : undefined,
  };
}

export function getDohcYDocPlainText(doc: Y.Doc): Y.Text | null {
  return getDohcYDocMeta(doc).contentKind === PLAIN_TEXT_CONTENT_KIND
    ? doc.getText(PLAIN_TEXT_FIELD)
    : null;
}

export function getDohcProseMirrorSchema() {
  return schema;
}

// Once empty, a list or item shows none of its attributes (a tick, a start number), so leaving
// it out hides nothing. Other blocks the schema refuses empty stay refused: a callout's title
// is text the Markdown file would keep.
const SHELL_LISTS = new Set(["bulletList", "orderedList", "taskList"]);
const SHELL_ITEMS = new Set(["listItem", "taskItem"]);

/**
 * Two edits can merge into a list or item with nothing in it. The schema can't hold it, so no
 * reader shows it, and a reading leaves it out instead of refusing the document. An item that
 * holds an empty list isn't one: the Markdown file would still keep its marker.
 */
export function isEmptyShell(element: Y.XmlElement): boolean {
  if (SHELL_ITEMS.has(element.nodeName)) return element.length === 0;
  return (
    SHELL_LISTS.has(element.nodeName) &&
    element
      .toArray()
      .every(
        (child) =>
          child instanceof Y.XmlElement && SHELL_ITEMS.has(child.nodeName) && child.length === 0,
      )
  );
}

/** Deletes the empty shells a reading leaves out, for code that pairs blocks with elements. */
export function deleteEmptyShells(parent: Y.XmlFragment | Y.XmlElement): void {
  for (let index = parent.length - 1; index >= 0; index--) {
    const child = parent.get(index);
    if (!(child instanceof Y.XmlElement)) continue;
    if (isEmptyShell(child)) parent.delete(index, 1);
    else deleteEmptyShells(child);
  }
}

function yDocBodyToMarkdown(doc: Y.Doc): string {
  const plainText = getDohcYDocPlainText(doc);
  if (plainText) return plainText.toString();
  return serializeRichdocBody(escapeHighlightMarkdown(yDocBodyToJSON(doc)));
}

/**
 * Reads the body of a note that says its body is one sequence from that sequence when it holds
 * any item, whatever a writer that does not know the format put under `body`. It reads such a
 * note from `body` only when the sequence holds no item and `body` holds some: that is a
 * first-format note a change marked, and what people wrote is there.
 */
function yDocBodyToJSON(doc: Y.Doc): JSONContent {
  if (readsBodySequence(doc)) return readBodySequence(schema, doc).toJSON() as JSONContent;
  return yXmlFragmentToProseMirrorRootNode(
    getDohcYDocBodyFragment(doc),
    schema,
  ).toJSON() as JSONContent;
}

export function serializeRichdocBody(root: JSONContent): string {
  const source = JSON.stringify(root);
  const characterSentinels = new Map<string, string>();
  const leadingWhitespaceSentinels = new Map<string, string>();
  const blockEscapeSentinels = new Map<string, string>();
  const codeBlocks = new Map<string, string>();
  const reservedTokens = new Set(source.match(/\uE000DOHC(?:[A-Z_]+_\d+|[A-Z]+\d+)\uE001/gu) ?? []);
  let tokenIndex = 0;
  const reserveToken = (kind: string): string => {
    let token: string;
    do {
      token = kind.includes("_")
        ? `\uE000DOHC_${kind}_${tokenIndex}\uE001`
        : `\uE000DOHC${kind}${tokenIndex}\uE001`;
      tokenIndex += 1;
    } while (reservedTokens.has(token));
    reservedTokens.add(token);
    return token;
  };
  const encodeLeadingWhitespace = (value: " " | "\t"): string => {
    const existing = leadingWhitespaceSentinels.get(value);
    if (existing) return existing;

    const token = reserveToken("LEADING_WHITESPACE");
    leadingWhitespaceSentinels.set(value, token);
    return token;
  };
  const encodeBackslash = (): string =>
    replaceCharacters("\\", characterSentinels, () => reserveToken("CHARACTER"), /\\/g);
  const encodeBlockEscape = (value: string): string => {
    const existing = blockEscapeSentinels.get(value);
    if (existing) return existing;

    const token = reserveToken("BLOCK_ESCAPE");
    blockEscapeSentinels.set(value, token);
    return token;
  };
  const encodeRaw = (text: string): string =>
    replaceCharacters(text, characterSentinels, () => reserveToken("CHARACTER"), /[\s\S]+/g);
  const heldCharacters = new Map<string, string>();
  const heldTokens = new Map<string, string>();
  const holdCharacter = (character: string): string => {
    const existing = heldTokens.get(character);
    if (existing) return existing;
    const token = reserveToken("HELD");
    heldTokens.set(character, token);
    heldCharacters.set(token, character);
    return token;
  };
  const opaque = [reserveToken("MARK"), reserveToken("MARK")] as const;
  const scope = [reserveToken("MARK"), reserveToken("MARK")] as const;
  const formattedBeyondCode = (content: JSONContent[]): boolean =>
    content.some(
      (node) => node.type === "text" && node.marks?.some((mark) => mark.type !== "code"),
    );
  const holdTypedSyntax = (content: JSONContent[]): JSONContent[] =>
    content.map((node) => {
      if (typeof node.text !== "string" || node.marks?.some((mark) => mark.type === "code")) {
        return node;
      }
      const syntax = node.marks?.some((mark) => mark.type === "highlight")
        ? /\\=|[*_`\\]/g
        : /[*_`\\]/g;
      const text = node.text
        .split(/(DOHC(?:[A-Z_]+_\d+|[A-Z]+\d+))/u)
        .map((part, index) =>
          index % 2
            ? part
            : part.replace(syntax, (found) =>
                found.length > 1 ? encodeRaw(found) : holdCharacter(found),
              ),
        )
        .join("");
      return text === node.text ? node : { ...node, text };
    });
  // An empty link the parser keeps as the file holds it reads back only from
  // the same bytes, so its `&`, `<`, `>`, and NBSP are written as they are,
  // and so is each line it starts, which no block opener or indent escape
  // then reads. A link with a line that would end the paragraph cannot be
  // written as it is, so it is written as references, the way a definition
  // is, which the parser reads back as the same link text. A highlight's own
  // `\=` stays as it is, for the highlight to read. Each of its lines is
  // written whole, so no later escape reads it.
  const asWritten = (text: string, highlighted: boolean): string => {
    if (!opensBlock(text)) {
      const kept = replaceCharacters(
        text,
        characterSentinels,
        () => reserveToken("CHARACTER"),
        /[&<>\u00a0*_`\\]|(?<=\n)[^\n\r]/g,
      );
      return opaque[0] + kept + opaque[1];
    }
    const written = highlighted
      ? text.split("\\=").map(writtenDefinition).join("\\=")
      : writtenDefinition(text);
    const kept = replaceCharacters(
      written,
      characterSentinels,
      () => reserveToken("CHARACTER"),
      /[^\n]+/g,
    );
    return opaque[0] + kept + opaque[1];
  };

  function visit(node: JSONContent, insideTableCell = false, parentType = ""): JSONContent {
    if (node.type === "table" && node.content?.length) {
      return {
        ...node,
        content: node.content.map((row, rowIndex) => ({
          ...row,
          content: row.content?.map((cell) => ({
            ...cell,
            type: rowIndex === 0 ? "tableHeader" : cell.type,
            content: cell.content?.flatMap(prepareTableCellBlock),
          })),
        })),
      };
    }

    if (node.type === "codeBlock") {
      const token = reserveToken("CODE_BLOCK");
      codeBlocks.set(token, textContent(node.content ?? []));
      return { ...node, content: [{ type: "text", text: token }] };
    }

    const formatted = formattedBeyondCode(node.content ?? []);
    let content = insideTableCell
      ? node.content?.flatMap(prepareTableCellBlock)
      : node.content?.map((child) => visit(child, false, node.type));
    if (content?.length) {
      const definition = node.type === "paragraph" && isDefinitionParagraph(content);
      // A definition reads back as plain text, so an empty link in it is
      // written as other text is. A block definition is one tag span.
      content = escapeRawHtmlPunctuation(
        content,
        encodeBlockEscape,
        insideTableCell,
        definition ? undefined : asWritten,
        definition && !insideTableCell,
      );
      if (node.type === "paragraph") {
        content = escapeLeadingMarkdownBlockSyntax(
          content,
          encodeLeadingWhitespace,
          encodeBlockEscape,
          // A table cell writes a hard break as <br>, which needs no backslash.
          insideTableCell ? undefined : encodeBackslash,
          definition,
        );
        if (
          (parentType === "doc" || parentType === "listItem" || parentType === "taskItem") &&
          content[0]?.text?.startsWith(" ") &&
          !content[0].marks?.some((mark) => mark.type === "code")
        ) {
          const rest = content[0].text.slice(1);
          content = [
            { type: "text", text: encodeLeadingWhitespace(" ") },
            ...(rest ? [{ ...content[0], text: rest }] : []),
            ...content.slice(1),
          ];
        }
      }
      if (formatted) content = holdTypedSyntax(content);
      content = renderInlineCodeRuns(
        content,
        characterSentinels,
        () => reserveToken("CHARACTER"),
        opaque,
      );
      content = protectMarkdownSyntax(content, characterSentinels, () => reserveToken("CHARACTER"));
      content = openNoDelimitersAroundWhitespace(content);
    }

    return content ? { ...node, content } : { ...node };
  }

  function prepareTableCellBlock(node: JSONContent): JSONContent[] {
    if (node.type !== "codeBlock") return [visit(node, true)];

    return textContent(node.content ?? [])
      .split("\n")
      .map((line) =>
        visit({
          type: "paragraph",
          content:
            line.length > 0
              ? [
                  {
                    type: "text",
                    text: line,
                    marks: [{ type: "code" }],
                  },
                ]
              : [],
        }),
      );
  }

  const prepared = visit(root);
  if (heldCharacters.size > 0) {
    for (const text of ["*", "_", "`", "\\", "\\\\"]) encodeRaw(text);
    for (const character of ["*", "_", "`"]) encodeBlockEscape(character);
  }
  // A character token's text can hold the other tokens, so it is written
  // first. Every token is reserved by now.
  const characters = new Map(
    Array.from(characterSentinels, ([character, sentinel]) => [sentinel, character] as const),
  );
  const others = new Map<string, string>([
    ...Array.from(
      blockEscapeSentinels,
      ([character, sentinel]) => [sentinel, `&#${character.codePointAt(0)};`] as const,
    ),
    ...Array.from(
      leadingWhitespaceSentinels,
      ([whitespace, sentinel]) => [sentinel, whitespace === " " ? "&#32;" : "&#9;"] as const,
    ),
    ...heldCharacters,
    ...[...opaque, ...scope].map((marker) => [marker, ""] as const),
  ]);
  const writeTokens = (text: string) =>
    restoreCharacterSentinels(restoreCharacterSentinels(text, characters), others);
  const inlineTokens: InlineTokens = {
    write: writeTokens,
    held: heldCharacters,
    opaque,
    scope,
    raw: (text) => characterSentinels.get(text) ?? text,
    reference: (character) => blockEscapeSentinels.get(character) ?? character,
  };
  // The library writes a note of only `&nbsp;` as empty, for its blank lines.
  // A sealed piece holding that text is the file's own, so it is written.
  let markdown = writingTableCellTokens(writeTokens, () =>
    markdownManager.writingTokens(inlineTokens, () =>
      holdsSealedPiece(prepared)
        ? markdownManager.renderNodes(prepared, prepared)
        : markdownManager.serialize(prepared),
    ),
  );
  if (prepared.content?.[0]?.type === "horizontalRule") {
    markdown = "***" + markdown.slice(3);
  }
  return rewriteCodeBlockFences(writeTokens(markdown), codeBlocks);
}

function holdsSealedPiece(node: JSONContent): boolean {
  return (
    node.type === "rawBlock" ||
    node.type === "rawInline" ||
    (node.content?.some(holdsSealedPiece) ?? false)
  );
}

function escapeLeadingIndentedCode(
  content: JSONContent[],
  encodeLeadingWhitespace: (value: " " | "\t") => string,
): JSONContent[] {
  const replacements = new Map<number, Map<number, string>>();
  let leadingColumn: number | null = 0;
  let leadingWhitespace: Array<readonly [number, number, " " | "\t"]> = [];

  for (const [nodeIndex, node] of content.entries()) {
    if (node.type === "hardBreak") {
      leadingColumn = 0;
      leadingWhitespace = [];
      continue;
    }
    if (typeof node.text !== "string" || node.marks?.some((mark) => mark.type === "code")) {
      leadingColumn = null;
      leadingWhitespace = [];
      continue;
    }

    for (let offset = 0; offset < node.text.length; offset += 1) {
      const character = node.text[offset];
      if (character === "\n") {
        leadingColumn = 0;
        leadingWhitespace = [];
        continue;
      }
      if (leadingColumn === null) continue;
      if (character !== " " && character !== "\t") {
        leadingColumn = null;
        leadingWhitespace = [];
        continue;
      }

      leadingWhitespace.push([nodeIndex, offset, character]);
      leadingColumn += character === " " ? 1 : 4 - (leadingColumn % 4);
      if (leadingColumn < 4) continue;

      for (const [
        index,
        [whitespaceNodeIndex, whitespaceOffset, whitespace],
      ] of leadingWhitespace.entries()) {
        const nodeReplacements = replacements.get(whitespaceNodeIndex) ?? new Map();
        nodeReplacements.set(
          whitespaceOffset,
          index === 0 ? encodeLeadingWhitespace(whitespace) : whitespace,
        );
        replacements.set(whitespaceNodeIndex, nodeReplacements);
      }
      leadingColumn = null;
      leadingWhitespace = [];
    }
  }

  if (replacements.size === 0) return content;
  return content.flatMap((node, nodeIndex) => {
    const nodeReplacements = replacements.get(nodeIndex);
    if (!nodeReplacements || typeof node.text !== "string") return [node];

    const output: JSONContent[] = [];
    let chunkStart = 0;
    for (const [offset, replacement] of nodeReplacements) {
      if (offset > chunkStart) {
        output.push({ ...node, text: node.text.slice(chunkStart, offset) });
      }
      output.push({ type: "text", text: replacement });
      chunkStart = offset + 1;
    }
    if (chunkStart < node.text.length) {
      output.push({ ...node, text: node.text.slice(chunkStart) });
    }
    return output;
  });
}

function escapePostNewlineMarkdownBlockOpeners(
  content: JSONContent[],
  encodeBlockEscape: (value: string) => string,
): JSONContent[] {
  type Replacement = { readonly text: string; readonly preserveMarks: boolean };
  const replacements = new Map<number, Map<number, Replacement>>();
  let capturesLine = false;
  let line = "";
  let positions: Array<readonly [number, number]> = [];
  let lineBreakPosition: readonly [number, number] | null = null;

  const addReplacement = (
    [nodeIndex, offset]: readonly [number, number],
    replacement: Replacement,
  ): void => {
    const nodeReplacements = replacements.get(nodeIndex) ?? new Map();
    nodeReplacements.set(offset, replacement);
    replacements.set(nodeIndex, nodeReplacements);
  };

  const finishLine = (): void => {
    if (capturesLine) {
      const escapeIndexes = leadingMarkdownBlockEscapeIndexes(line);
      // The line break keeps its marks, so a mark across it stays one.
      if (escapeIndexes.length > 0 && lineBreakPosition) {
        addReplacement(lineBreakPosition, { text: "\n", preserveMarks: true });
      }
      for (const escapeIndex of escapeIndexes) {
        const position = positions[escapeIndex];
        if (!position) continue;
        addReplacement(position, {
          text: encodeBlockEscape(line[escapeIndex] ?? ""),
          preserveMarks: true,
        });
      }
    }
    line = "";
    positions = [];
  };

  for (const [nodeIndex, node] of content.entries()) {
    if (typeof node.text !== "string" || node.marks?.some((mark) => mark.type === "code")) {
      finishLine();
      capturesLine = false;
      lineBreakPosition = null;
      continue;
    }
    for (let offset = 0; offset < node.text.length; offset += 1) {
      const character = node.text[offset];
      if (character === "\n") {
        finishLine();
        capturesLine = true;
        lineBreakPosition = [nodeIndex, offset];
        continue;
      }
      if (!capturesLine) continue;
      line += character;
      positions.push([nodeIndex, offset]);
    }
  }
  finishLine();

  if (replacements.size === 0) return content;
  return content.flatMap((node, nodeIndex) => {
    const nodeReplacements = replacements.get(nodeIndex);
    if (!nodeReplacements || typeof node.text !== "string") return [node];

    const output: JSONContent[] = [];
    let chunkStart = 0;
    for (const [offset, replacement] of nodeReplacements) {
      if (offset > chunkStart) {
        output.push({ ...node, text: node.text.slice(chunkStart, offset) });
      }
      output.push(
        replacement.preserveMarks
          ? { ...node, text: replacement.text }
          : { type: "text", text: replacement.text },
      );
      chunkStart = offset + 1;
    }
    if (chunkStart < node.text.length) {
      output.push({ ...node, text: node.text.slice(chunkStart) });
    }
    return output;
  });
}

function escapeLeadingMarkdownBlockSyntax(
  content: JSONContent[],
  encodeLeadingWhitespace: (value: " " | "\t") => string,
  encodeBlockEscape: (value: string) => string,
  encodeBackslash: (() => string) | undefined,
  definition: boolean,
): JSONContent[] {
  const output: JSONContent[] = [];
  let lineStart = true;
  const escapedContent = escapePostNewlineMarkdownBlockOpeners(
    escapeParagraphWhitespace(content, encodeBlockEscape),
    encodeBlockEscape,
  );
  const preparedContent = escapeLeadingIndentedCode(escapedContent, encodeLeadingWhitespace);
  // Every break in a run looks ahead to the same line, so keep the answer
  // for the run rather than rescanning it at each break.
  let lineAfterBreaks: boolean | undefined;

  for (let index = 0; index < preparedContent.length;) {
    const node = preparedContent[index];
    if (node.type !== "hardBreak") lineAfterBreaks = undefined;
    if (typeof node.text === "string" && !node.marks?.length) {
      const run: JSONContent[] = [];
      while (
        index < preparedContent.length &&
        typeof preparedContent[index].text === "string" &&
        !preparedContent[index].marks?.length
      ) {
        run.push(preparedContent[index]);
        index += 1;
      }
      output.push(
        ...escapeTextRunBlockOpeners(
          run,
          lineStart,
          encodeLeadingWhitespace,
          encodeBlockEscape,
          definition && output.length === 0,
        ),
      );
      lineStart = run.at(-1)?.text?.endsWith("\n") === true;
      continue;
    }

    // A hard break's two spaces on a line with nothing else read back as a
    // blank line, which ends the paragraph. A backslash keeps the break, but
    // a backslash before a blank line ends the paragraph and is literal.
    if (
      encodeBackslash &&
      node.type === "hardBreak" &&
      lineStart &&
      (lineAfterBreaks ??= showsLineAfter(preparedContent, index))
    ) {
      output.push({ type: "text", text: `${encodeBackslash()}\n` });
      index += 1;
      continue;
    }
    output.push(node);
    // A sealed piece can end a line, as the Rust writer sees from its output.
    lineStart =
      node.type === "hardBreak" ||
      (node.type === "rawInline" && String(node.attrs?.source ?? "").endsWith("\n"));
    index += 1;
  }
  return output;
}

// Whether the line after the hard break at `index` shows anything. Breaks that
// follow it directly start lines of their own, which this answers for in turn.
function showsLineAfter(content: JSONContent[], index: number): boolean {
  let next = index + 1;
  while (content[next]?.type === "hardBreak") next += 1;
  let line = "";
  for (; next < content.length && content[next].type !== "hardBreak"; next += 1) {
    const node = content[next];
    // A code span of blank space is written in backticks, so it shows.
    if (typeof node.text !== "string" || node.marks?.some((mark) => mark.type === "code")) {
      return true;
    }
    const lineEnd = node.text.indexOf("\n");
    if (lineEnd !== -1) return /[^ \t]/u.test(line + node.text.slice(0, lineEnd));
    line += node.text;
  }
  // Before another line, only spaces and tabs make it blank. On the paragraph's
  // last line any whitespace does, as a backslash followed only by whitespace
  // to the end is literal.
  return next < content.length ? /[^ \t]/u.test(line) : /\S/u.test(line);
}

// Whether a paragraph is plain text that marked reads back as the one link
// reference definition it holds, as the parser keeps a definition.
function isDefinitionParagraph(content: JSONContent[]): boolean {
  const [node] = content;
  if (content.length !== 1 || typeof node.text !== "string" || node.marks?.length) return false;
  if (!node.text.startsWith("[")) return false;
  const raw = literalProbe.def(node.text)?.raw;
  return raw !== undefined && definitionText(raw) === node.text;
}

function escapeParagraphWhitespace(
  content: JSONContent[],
  encodeBlockEscape: (value: string) => string,
): JSONContent[] {
  return content.map((node) =>
    typeof node.text === "string" &&
    /[\r\u00a0]/.test(node.text) &&
    !node.marks?.some((mark) => mark.type === "code")
      ? // Task-list parsing treats a literal NBSP as indentation, not content.
        { ...node, text: node.text.replace(/[\r\u00a0]/g, encodeBlockEscape) }
      : node,
  );
}

// With `definition`, the `[` that starts the run is written as `&#91;`, the
// reference later lines already use, which the parser reads back as text,
// not as an escape node. So a definition the parser keeps as text reopens as
// the same text.
function escapeTextRunBlockOpeners(
  run: JSONContent[],
  startsLine: boolean,
  encodeLeadingWhitespace: (value: " " | "\t") => string,
  encodeBlockEscape: (value: string) => string,
  definition: boolean,
): JSONContent[] {
  const text = run.map((node) => node.text ?? "").join("");
  const escapeOffsets = new Set<number>();
  const whitespaceReplacements = new Map<number, string>();
  let lineStart = startsLine ? 0 : text.indexOf("\n") + 1;
  while (lineStart > 0 || startsLine) {
    const lineEnd = text.indexOf("\n", lineStart);
    const line = text.slice(lineStart, lineEnd < 0 ? undefined : lineEnd);
    const leadingWhitespace = indentedCodeLeadingWhitespace(line);
    if (leadingWhitespace) {
      whitespaceReplacements.set(lineStart, encodeLeadingWhitespace(leadingWhitespace));
    } else {
      for (const escapeIndex of leadingMarkdownBlockEscapeIndexes(line)) {
        escapeOffsets.add(lineStart + escapeIndex);
      }
    }
    if (lineEnd < 0) break;
    lineStart = lineEnd + 1;
    startsLine = false;
  }
  if (escapeOffsets.size === 0 && whitespaceReplacements.size === 0) return run;

  const output: JSONContent[] = [];
  let offset = 0;
  for (const node of run) {
    const nodeText = node.text ?? "";
    let chunkStart = 0;
    for (let index = 0; index < nodeText.length; index += 1) {
      const absoluteIndex = offset + index;
      const whitespaceReplacement = whitespaceReplacements.get(absoluteIndex);
      if (!escapeOffsets.has(absoluteIndex) && !whitespaceReplacement) continue;
      if (index > chunkStart) {
        output.push({ ...node, text: nodeText.slice(chunkStart, index) });
      }
      output.push(
        whitespaceReplacement
          ? { ...node, text: whitespaceReplacement }
          : definition && absoluteIndex === 0
            ? { ...node, text: encodeBlockEscape("[") }
            : {
                type: "escapedPunctuation",
                attrs: { value: nodeText[index] },
              },
      );
      chunkStart = index + 1;
    }
    if (chunkStart < nodeText.length) {
      output.push({ ...node, text: nodeText.slice(chunkStart) });
    }
    offset += nodeText.length;
  }
  return output;
}

function indentedCodeLeadingWhitespace(text: string): " " | "\t" | null {
  let column = 0;
  for (const character of text) {
    if (character === " ") column += 1;
    else if (character === "\t") column += 4 - (column % 4);
    else break;
    if (column >= 4) return text[0] === "\t" ? "\t" : " ";
  }
  return null;
}

function leadingMarkdownBlockEscapeIndexes(text: string): number[] {
  const indent = /^( {0,3})/.exec(text)?.[1].length ?? 0;
  const rest = text.slice(indent);

  if (/^#{1,6}(?:[\t ]|$)/.test(rest)) return [indent];
  if (rest.startsWith("$$")) return [indent, indent + 1];
  if (/^[-+*](?:[\t ]|$)/.test(rest)) return [indent];
  if (/^(?:`{3,}|~{3,})/.test(rest)) return [indent];
  const thematicBreak = /^(?:-(?:[\t ]*-){2,}|\*(?:[\t ]*\*){2,}|_(?:[\t ]*_){2,})[\t ]*$/;
  if (thematicBreak.test(rest)) {
    return [indent];
  }
  if (/^(?:=+|-+)[\t ]*$/.test(rest)) return [indent];
  if (rest.startsWith("![")) return [indent + 1];
  // A link with no text starts no definition, and the parser reads it as text.
  if (/^\[(?!\]\()/.test(rest)) return [indent];
  const ordered = /^(\d{1,9})([.)])(?:[\t ]|$)/.exec(rest);
  if (ordered) return [indent + ordered[1].length];
  return [];
}

// The tag span of a block's inline content: from its first tag to its last
// `>`, across marks, with each node's share of the text. Code is not part of
// it. The serializer writes references inside it and the parser reads them,
// where only the serializer's `&lt;` and `&gt;` open and close one. So a tag
// the serializer writes as a real one, a table cell's `<br>`, is not a bound.
// Nor is a `<` or `>` in an empty link the serializer writes as it is.
function rawHtmlSpan(
  content: JSONContent[],
  realTag?: string,
  emptyLinks?: Array<Array<[number, number]>>,
): { texts: string[]; start: number; end: number } | undefined {
  const texts = content.map((node) =>
    typeof node.text === "string" && !node.marks?.some((mark) => mark.type === "code")
      ? node.text
      : "",
  );
  const joined = emptyLinks
    ? texts
        .map((text, index) =>
          mapRanges(text, emptyLinks[index], 0, (part) => part.replace(/[<>]/g, "\0")),
        )
        .join("")
    : texts.join("");
  const bounds = realTag ? joined.replaceAll(realTag, "\0".repeat(realTag.length)) : joined;
  const start = bounds.search(/<[!/?A-Za-z]/);
  const end = bounds.lastIndexOf(">") + 1;
  return start < 0 || end <= start ? undefined : { texts, start, end };
}

// Tiptap writes a text's `<`, `>`, and `&` as `&lt;`, `&gt;`, and `&amp;`, so
// raw HTML kept as text no longer reads as HTML when the file reopens, and the
// syntax it kept literal, from emphasis to atoms, links, and escapes, would
// read again. In the tag span, every other ASCII punctuation character but the
// `!`, `/`, and `?` that open a tag is written as a reference the parser reads
// back as that character, and so is a space that ends a line, which would make
// a line break. An empty line would end the paragraph, so its newline is one
// too. A line of spaces or tabs already starts or ends with one. A highlight's
// own `\=` stays as written.
//
// The parser keeps a link with no text as the text the file holds, so outside
// the span the serializer writes one as it is, through `asWritten`. Inside the
// span its `[` is a reference, so it reads back as the span's other text does.
//
// With `whole`, all of the text is the span, as for a definition the parser
// keeps as text.
function escapeRawHtmlPunctuation(
  content: JSONContent[],
  encodeBlockEscape: (value: string) => string,
  insideTableCell: boolean,
  asWritten: ((text: string, highlighted: boolean) => string) | undefined,
  whole = false,
): JSONContent[] {
  const linkRanges = (node: JSONContent): Array<[number, number]> =>
    asWritten && typeof node.text === "string" && !node.marks?.some((mark) => mark.type === "code")
      ? emptyLinkRanges(node.text)
      : [];
  const write =
    (node: JSONContent) =>
    (part: string): string =>
      asWritten
        ? asWritten(part, node.marks?.some((mark) => mark.type === "highlight") === true)
        : part;
  // A link written as references holds no `[` once written, so it is no
  // link here either, and its references bound no span.
  let emptyLinks = content.map(linkRanges);
  if (
    emptyLinks.some((ranges, index) =>
      ranges.some(([from, to]) => opensBlock((content[index].text ?? "").slice(from, to))),
    )
  ) {
    content = content.map((node, index) => {
      const text = node.text ?? "";
      const ranges = emptyLinks[index].filter(([from, to]) => opensBlock(text.slice(from, to)));
      return ranges.length ? { ...node, text: mapRanges(text, ranges, 0, write(node)) } : node;
    });
    emptyLinks = content.map(linkRanges);
  }
  const writeEmptyLinks = (node: JSONContent, index: number): JSONContent =>
    emptyLinks[index].length
      ? { ...node, text: mapRanges(node.text ?? "", emptyLinks[index], 0, write(node)) }
      : node;
  const tag = whole
    ? { texts: content.map((node) => node.text ?? ""), start: 0, end: Infinity }
    : rawHtmlSpan(
        content,
        insideTableCell ? GFM_TABLE_CELL_BLOCK_SEPARATOR : undefined,
        emptyLinks,
      );
  if (!tag) return content.map(writeEmptyLinks);
  const { texts, start, end } = tag;
  const joined = texts.join("");
  let offset = 0;
  return content.map((node, index) => {
    const text = texts[index];
    const from = Math.max(start - offset, 0);
    const to = Math.min(end - offset, text.length);
    const at = offset + from;
    offset += text.length;
    if (from >= to) return writeEmptyLinks(node, index);
    const punctuation = node.marks?.some((mark) => mark.type === "highlight")
      ? /\\=|["-%'-.:;=@[-`{-~]| |\n/g
      : /["-%'-.:;=@[-`{-~]| |\n/g;
    const html = text.slice(from, to).replace(punctuation, (character, position: number) => {
      if (character.length > 1) return character;
      // The space's newline, or the newline's line, can sit in the next or
      // previous node.
      if (character === " " && (at + position + 1 >= end || joined[at + position + 1] !== "\n")) {
        return character;
      }
      if (character === "\n" && joined[at + position - 1] !== "\n") return character;
      return encodeBlockEscape(character);
    });
    const ranges = emptyLinks[index];
    return {
      ...node,
      text:
        mapRanges(text.slice(0, from), ranges, 0, write(node)) +
        html +
        mapRanges(text.slice(to), ranges, to, write(node)),
    };
  });
}

// Whether a link with no text holds a line that would end the paragraph it
// is in, written as it is: after at most three spaces, a character that can
// open a block or a table's delimiter row, `1.` or `1)`, or nothing but
// spaces. A `\r` counts too: marked reads it as a newline, and the `&#13;`
// that keeps it one would stay a reference in a link written as it is. It
// errs toward yes, since such a link is written as references, which read
// back the same. The engine's projector decides the same way.
export function opensBlock(link: string): boolean {
  return OPENS_BLOCK_RE.test(link);
}
const OPENS_BLOCK_RE = /\r|\n(?: {0,3}(?:[#$>*+\-_=`~<|:]|1[.)])| *(?:\n|$))/;
const OPENS_LINE_RE = new RegExp(OPENS_BLOCK_RE.source, "y");

// Where `text` holds a link with no text, as the parser reads one: marked's
// inline `link` rule and `Tokenizer.link` checks, from `[](`. The parser asks
// marked at each `[](`, which reads the rest of the text each time. This
// reads the same rule once across the text, so a run of candidates that fail
// costs no more than the text it spans. The importer's tests compare the two
// readings.
export function emptyLinkRanges(text: string): Array<[number, number]> {
  let at = text.indexOf("[](");
  if (at < 0) return [];
  const read = emptyLinkReader(text);
  const ranges: Array<[number, number]> = [];
  while (at >= 0) {
    const end = read(at);
    if (end < 0) {
      at = text.indexOf("[](", at + 1);
    } else {
      ranges.push([at, end]);
      at = text.indexOf("[](", end);
    }
  }
  return ranges;
}

const TITLE_CLOSE: Record<string, string> = { '"': '"', "'": "'", "(": ")" };

// A run of bare destination text, which every candidate whose destination
// starts in it shares: where it stops, its last two `)`, and what the rule
// reads after it, each found once.
type BareRun = {
  start: number;
  stop: number;
  close: number;
  previousClose: number;
  tail?: number;
  shapes: Map<number, [number, number]>;
  walk?: ParenthesisWalk;
};

// marked's `findClosingBracket` for each candidate whose destination starts
// in a run: its first unmatched `)` and its depth, in candidate order, and the
// depth at the run's stop and at its last `)`.
type ParenthesisWalk = {
  solids: number[];
  lowers: number[];
  depths: number[];
  stopDepth: number;
  closeDepth: number;
  next: number;
};

// A title's scan from a start: the first delimiter no backslash escapes, the
// close after it, and the last escaped delimiter whose close succeeds.
type TitleScan = {
  start: number;
  end: number;
  close: number;
  escaped: number;
  escapedClose: number;
};

// The end of the link with no text at each `[](` in `text`, or -1, read in
// order. marked's rule, after `[](`, is `\s*`, a destination
// `<(?:\\.|[^\n<>\\])+>` or `[^ \t\n\x00-\x1f]*`, an optional title after
// `[ \t]+(?:\n[ \t]*)?|\n[ \t]*`, then `\s*\)`. Its regex tries the longest
// choices first, so each step names the first choice that succeeds.
//
// The reader keeps no table of the text. Each candidate scans its own
// leading whitespace, and an angle destination stops at the next `<`. Work
// that candidates share sits in memos that only move forward: the bare run,
// and each delimiter's title scan for each of three streams of title starts
// that only grow. A run whose destinations hold `)` is walked once. So the
// work is linear in the text, and the storage is linear in the candidates
// of one run. Every character it reads goes through `charAt` or
// `charCodeAt`, which the tests count.
function emptyLinkReader(text: string): (link: number) => number {
  const n = text.length;
  const char = (index: number) => text.charAt(index);
  const space = (index: number) => index < n && /\s/.test(char(index));
  const stops = (index: number) => {
    const code = text.charCodeAt(index);
    return code === 32 || code <= 31;
  };
  const tabEnd = (index: number) => {
    let at = index;
    while (char(at) === " " || char(at) === "\t") at += 1;
    return at;
  };
  // `\s*\)` from an index: the end of the `)`, or -1.
  const closeAt = (index: number) => {
    let at = index;
    while (space(at)) at += 1;
    return char(at) === ")" ? at + 1 : -1;
  };
  const trimEnd = (index: number) => {
    let at = index;
    while (at > 0 && space(at - 1)) at -= 1;
    return at;
  };

  const titles = new Map<number, TitleScan>();
  const title = (at: number, stream: number): number => {
    const opener = char(at);
    const delimiter = TITLE_CLOSE[opener];
    if (!delimiter) return -1;
    const key = stream * 3 + "\"'(".indexOf(opener);
    const from = at + 1;
    let scan = titles.get(key);
    if (!scan || from < scan.start || from > scan.end) {
      scan = { start: from, end: n, close: -1, escaped: -1, escapedClose: -1 };
      for (let index = from; index < n;) {
        const character = char(index);
        if (character === "\\" && char(index + 1) === delimiter) {
          const close = closeAt(index + 2);
          if (close >= 0) {
            scan.escaped = index + 1;
            scan.escapedClose = close;
          }
          index += 2;
        } else if (character === delimiter) {
          scan.end = index;
          scan.close = closeAt(index + 1);
          break;
        } else {
          index += 1;
        }
      }
      titles.set(key, scan);
    }
    if (scan.close >= 0) return scan.close;
    return scan.escaped > from ? scan.escapedClose : -1;
  };
  // After a destination: the end of the title and `)`, or of `)` alone.
  const tail = (end: number, stream: number): number => {
    const spaced = tabEnd(end);
    const at = char(spaced) === "\n" ? tabEnd(spaced + 1) : spaced > end ? spaced : -1;
    const titled = at >= 0 ? title(at, stream) : -1;
    return titled >= 0 ? titled : closeAt(end);
  };
  // Where an angle destination's characters stop.
  const angled = (index: number) => {
    let at = index;
    while (at < n) {
      const character = char(at);
      if (character === "\\") {
        if (at + 1 >= n || /[\n\r\u2028\u2029]/.test(char(at + 1))) return at;
        at += 2;
      } else if (character === "\n" || character === "<" || character === ">") {
        return at;
      } else {
        at += 1;
      }
    }
    return at;
  };

  let run: BareRun | undefined;
  const bareRun = (solid: number): BareRun => {
    if (run && run.start <= solid && solid <= run.stop) return run;
    let stop = solid;
    let close = -1;
    let previousClose = -1;
    for (; stop < n && !stops(stop); stop += 1) {
      if (char(stop) === ")") {
        previousClose = close;
        close = stop;
      }
    }
    run = { start: solid, stop, close, previousClose, shapes: new Map() };
    return run;
  };
  const walk = (bare: BareRun): ParenthesisWalk => {
    const solids = [bare.start];
    const lowers = [n];
    const depths = [0];
    const open = [0];
    let depth = 0;
    let closeDepth = 0;
    for (let index = bare.start; index < bare.stop;) {
      const character = char(index);
      const step = character === "\\" ? 2 : 1;
      if (index <= bare.close && bare.close < index + step) closeDepth = depth;
      if (character === "(") {
        depth += 1;
        if (char(index - 1) === "]" && char(index - 2) === "[") {
          let solid = index + 1;
          while (space(solid)) solid += 1;
          if (solid < bare.stop) {
            solids.push(solid);
            lowers.push(n);
            depths.push(depth);
            open.push(solids.length - 1);
          }
        }
      } else if (character === ")") {
        depth -= 1;
        while (open.length > 0 && depths[open[open.length - 1]] > depth) {
          lowers[open.pop() as number] = index;
        }
      }
      index += step;
    }
    return { solids, lowers, depths, stopDepth: depth, closeDepth, next: 0 };
  };

  // marked's checks on the destination from `from` to `to`: in angles it ends
  // with an unescaped `>`, and with unbalanced parentheses the link ends at
  // the first unmatched `)`, cut `4 + index` from the link's start even after
  // leading whitespace, then trimmed.
  const checked = (link: number, solid: number, from: number, to: number, end: number): number => {
    if (to <= solid) return end;
    let shape = run?.shapes.get(to);
    if (!shape) {
      const stop = trimEnd(to);
      let slashes = 0;
      while (char(stop - 2 - slashes) === "\\") slashes += 1;
      shape = [stop, slashes];
      if (run && (to === run.stop || to === run.close)) run.shapes.set(to, shape);
    }
    const [stop, slashes] = shape;
    if (char(solid) === "<") {
      return char(stop - 1) === ">" && Math.min(slashes, stop - 1 - solid) % 2 === 0 ? end : -1;
    }
    // A bare destination ends at its run's stop or last `)`.
    const bare = run as BareRun;
    const close = to === bare.stop ? bare.close : bare.previousClose;
    if (close < from) return end;
    const walked = (bare.walk ??= walk(bare));
    while (walked.solids[walked.next] < solid) walked.next += 1;
    const at = walked.next;
    if (walked.lowers[at] < to) return trimEnd(link + 4 + walked.lowers[at] - from);
    const depth = to === bare.stop ? walked.stopDepth : walked.closeDepth;
    return depth > walked.depths[at] ? -1 : end;
  };

  return (link) => {
    const after = link + 3;
    let solid = after;
    while (space(solid)) solid += 1;
    // Carried back from the position after each whitespace one: where its
    // bare destination stops and what follows, where spaces and tabs end,
    // and where they end after the nearest newline.
    let stop = -1;
    let tailed = -1;
    let tabs = solid;
    let newline = -1;
    for (let from = solid; from >= after; from -= 1) {
      if (from === solid) {
        if (char(from) === "<") {
          const close = angled(from + 1);
          if (close > from + 1 && char(close) === ">") {
            const end = tail(close + 1, 2);
            if (end >= 0) return checked(link, solid, from, close + 1, end);
          }
        }
        const bare = bareRun(solid);
        stop = bare.stop;
        tailed = bare.tail ??= tail(stop, 0);
      } else {
        const following = tabs;
        const character = char(from);
        if (character !== " " && character !== "\t") tabs = from;
        if (character === "\n") newline = following;
        if (stops(from)) {
          stop = from;
          const at = char(tabs) === "\n" ? newline : tabs > from ? tabs : -1;
          const titled = at >= 0 ? title(at, 1) : -1;
          tailed = titled >= 0 ? titled : char(solid) === ")" ? solid + 1 : -1;
        }
      }
      if (tailed >= 0) return checked(link, solid, from, stop, tailed);
      // A shorter bare destination can end where `\s*\)` succeeds. Whitespace
      // that reaches a `)` would already have closed the link at the stop, so
      // that is the run's last `)`.
      const close = stop >= solid ? (run as BareRun).close : -1;
      if (close >= from) return checked(link, solid, from, close, close + 1);
    }
    return -1;
  };
}

// `text`, which starts at `base` in its node, with each part a sorted range
// covers passed through `map`.
function mapRanges(
  text: string,
  ranges: Array<[number, number]>,
  base: number,
  map: (part: string) => string,
): string {
  let output = "";
  let cursor = 0;
  for (const [rangeFrom, rangeTo] of ranges) {
    const from = Math.max(rangeFrom - base, cursor);
    const to = Math.min(rangeTo - base, text.length);
    if (from >= to) continue;
    output += text.slice(cursor, from) + map(text.slice(from, to));
    cursor = to;
  }
  return output + text.slice(cursor);
}

const DELIMITER_MARKS = new Set(["bold", "italic", "strike", "underline", "highlight"]);

type Mark = NonNullable<JSONContent["marks"]>[number];

const sameMark = (left: Mark, right: Mark): boolean =>
  left.type === right.type &&
  JSON.stringify(left.attrs ?? {}) === JSON.stringify(right.attrs ?? {});

// Markdown reads no delimiter beside only whitespace as a mark, and the reader
// gives whitespace at a mark's edge no mark. A run of only whitespace keeps
// only a mark that continues through it to text on both sides, so the writer
// writes the same delimiters for what it reads back. The engine writer does
// the same.
function openNoDelimitersAroundWhitespace(content: JSONContent[]): JSONContent[] {
  const blank = content.map((node) => node.type === "text" && /^\s*$/u.test(node.text ?? ""));
  if (!blank.includes(true)) return content;
  // For each blank run, the marks it shares with the text the order visits
  // before it, through blank runs that carry them too.
  const reachingText = (order: number[]): Mark[][] => {
    const reached: Mark[][] = content.map(() => []);
    let before: number | undefined;
    for (const index of order) {
      if (content[index]!.type !== "text") {
        before = undefined;
        continue;
      }
      if (blank[index] && before !== undefined) {
        const carried = blank[before] ? reached[before]! : (content[before]!.marks ?? []);
        reached[index] = (content[index]!.marks ?? []).filter((mark) =>
          carried.some((other) => sameMark(other, mark)),
        );
      }
      before = index;
    }
    return reached;
  };
  const indexes = content.map((_, index) => index);
  const fromBefore = reachingText(indexes);
  const fromAfter = reachingText([...indexes].reverse());
  return content.map((node, index) => {
    if (!blank[index] || !node.marks?.length) return node;
    const back = (mark: Mark) => fromBefore[index]!.some((other) => sameMark(other, mark));
    const ahead = (mark: Mark) => fromAfter[index]!.some((other) => sameMark(other, mark));
    const marks = node.marks.filter(
      (mark) => !DELIMITER_MARKS.has(mark.type) || (back(mark) && ahead(mark)),
    );
    if (marks.length === node.marks.length) return node;
    return marks.length ? { ...node, marks } : { type: node.type, text: node.text };
  });
}

function protectMarkdownSyntax(
  content: JSONContent[],
  sentinels: Map<string, string>,
  reserveSentinel: () => string,
): JSONContent[] {
  return content.map((node) => {
    if (typeof node.text !== "string") return node;
    return {
      ...node,
      text: replaceCharacters(node.text, sentinels, reserveSentinel, /[\\`*_[\]~]/g),
    };
  });
}

function textContent(content: JSONContent[]): string {
  return content
    .map((node) => (typeof node.text === "string" ? node.text : textContent(node.content ?? [])))
    .join("");
}

function renderInlineCodeRuns(
  content: JSONContent[],
  entitySentinels: Map<string, string>,
  reserveSentinel: () => string,
  opaque: readonly [string, string],
): JSONContent[] {
  const output: JSONContent[] = [];
  for (let index = 0; index < content.length;) {
    const node = content[index];
    if (!isInlineCodeText(node)) {
      output.push(node);
      index += 1;
      continue;
    }

    let end = index + 1;
    let value = node.text ?? "";
    while (end < content.length && sameInlineCodeMark(node, content[end])) {
      value += content[end].text ?? "";
      end += 1;
    }
    const marks = node.marks?.filter((mark) => mark.type !== "code");
    output.push({
      ...node,
      text:
        opaque[0] +
        renderInlineCode(replaceCharacters(value, entitySentinels, reserveSentinel)) +
        opaque[1],
      marks: marks?.length ? marks : undefined,
    });
    index = end;
  }
  return output;
}

function replaceCharacters(
  value: string,
  replacements: Map<string, string>,
  reserveSentinel: () => string,
  pattern = /[&<>]/g,
): string {
  return value.replace(pattern, (character) => {
    const existing = replacements.get(character);
    if (existing) return existing;

    const sentinel = reserveSentinel();
    replacements.set(character, sentinel);
    return sentinel;
  });
}

function isInlineCodeText(node: JSONContent): boolean {
  return (
    node.type === "text" &&
    typeof node.text === "string" &&
    (node.marks ?? []).some((mark) => mark.type === "code")
  );
}

function sameInlineCodeMark(left: JSONContent, right: JSONContent): boolean {
  if (!isInlineCodeText(right)) return false;
  const leftCode = left.marks?.find((mark) => mark.type === "code");
  const rightCode = right.marks?.find((mark) => mark.type === "code");
  return JSON.stringify(leftCode?.attrs ?? {}) === JSON.stringify(rightCode?.attrs ?? {});
}

function renderInlineCode(value: string): string {
  const fence = backtickFence(value, 1);
  const hasEdgeBacktick = value.startsWith("`") || value.endsWith("`");
  const hasEdgeSpace = value.startsWith(" ") || value.endsWith(" ");
  const padding = hasEdgeBacktick || (hasEdgeSpace && !/^ *$/.test(value)) ? " " : "";
  return `${fence}${padding}${value}${padding}${fence}`;
}

function rewriteCodeBlockFences(markdown: string, codeBlocks: Map<string, string>): string {
  const lines = markdown.split("\n");
  const output: string[] = [];
  let restoredBlocks = 0;

  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index];
    const tokenMatch = /(\uE000DOHC_CODE_BLOCK_\d+\uE001)$/.exec(line);
    const token = tokenMatch?.[1];
    const content = token ? codeBlocks.get(token) : undefined;
    if (content === undefined) {
      output.push(line);
      continue;
    }

    const opening = output.pop();
    const closing = lines[index + 1];
    const openingFence = opening && /(`{3})(.*)$/.exec(opening);
    const closingFence = closing && /(`{3,})([ \t]*)$/.exec(closing);
    if (!opening || !openingFence || !closing || !closingFence || !tokenMatch) {
      throw new Error("could not restore a fenced code block serialization sentinel");
    }

    const openingPrefix = opening.slice(0, openingFence.index);
    const serializedContentPrefix = line.slice(0, tokenMatch.index);
    const serializedClosingPrefix = closing.slice(0, closingFence.index);
    const listContinuationPrefix = continuationPrefixForListMarker(openingPrefix);
    const contentPrefix = listContinuationPrefix ?? serializedContentPrefix;
    const closingPrefix = listContinuationPrefix ?? serializedClosingPrefix;
    const language = openingFence[2];
    const fence = codeBlockFence(content, language);
    const info = language.startsWith(fence[0]) ? ` ${language}` : language;
    const blankPrefix = /^\s*$/.test(contentPrefix) ? contentPrefix : contentPrefix.trimEnd();
    const contentLines = content
      .split("\n")
      .map((line) => (line.length === 0 ? blankPrefix : `${contentPrefix}${line}`));
    output.push(
      `${openingPrefix}${fence}${info}`,
      ...contentLines,
      `${closingPrefix}${fence}${closingFence[2]}`,
    );
    restoredBlocks += 1;
    index += 1;
  }

  if (restoredBlocks !== codeBlocks.size) {
    throw new Error("could not find every fenced code block serialization sentinel");
  }

  return output.join("\n");
}

function continuationPrefixForListMarker(prefix: string): string | null {
  const taskItem = /^(.*?)([-+*]) \[[ xX]\] $/.exec(prefix);
  if (taskItem) return `${taskItem[1]}  `;

  const listItem = /^(.*?)([-+*]|\d+[.)]) $/.exec(prefix);
  if (!listItem) return null;
  return `${listItem[1]}${" ".repeat(listItem[2].length + 1)}`;
}

function restoreCharacterSentinels(
  markdown: string,
  replacements: ReadonlyMap<string, string>,
): string {
  if (replacements.size === 0 || !markdown.includes("\uE000")) return markdown;
  // Every sentinel the serializer reserves has this shape, so one pass finds
  // them all, however many there are.
  return markdown.replace(
    /\uE000DOHC(?:[A-Z_]+_\d+|[A-Z]+\d+)\uE001/gu,
    (sentinel) => replacements.get(sentinel) ?? sentinel,
  );
}

/** Whether a Markdown file's reader takes the start of `markdown` as frontmatter, even an empty one. */
export function startsWithFrontmatter(markdown: string): boolean {
  return parseFrontmatter(markdown, false).body !== markdown;
}
