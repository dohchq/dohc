import { attrsEqual, type JSONContent } from "@tiptap/core";
import { MarkdownManager } from "@tiptap/markdown";

import { writeHeldCharacters } from "./held-characters.js";

type Mark = NonNullable<JSONContent["marks"]>[number];
type OpeningMode = "markdown" | "underscore";

const RANK: Record<string, number> = {
  link: 0,
  highlight: 1,
  bold: 2,
  code: 3,
  italic: 4,
  strike: 5,
  underline: 6,
};

const DELIMITERS: Record<string, string> = {
  highlight: "==",
  bold: "**",
  italic: "*",
  strike: "~~",
  underline: "++",
};

const UNDERSCORES: Record<string, string> = { bold: "__", italic: "_" };

const FLANKING = new Set(["bold", "italic", "strike"]);
const STARRED = new Set(["bold", "italic"]);

const LOOSE = /^[\s!-)+-/:-@[-^`{-}]/u;

function looseBefore(written: string): boolean {
  if (written === "") return true;
  if (/#\d+;$/u.test(written)) return false;
  return LOOSE.test(written.slice(-1));
}

function looseAfter(written: string): boolean {
  if (written === "") return true;
  if (/^&(?:amp;)?#/u.test(written)) return false;
  return LOOSE.test(written);
}

export type InlineTokens = {
  write: (text: string) => string;
  held: ReadonlyMap<string, string>;
  opaque: readonly [string, string];
  scope: readonly [string, string];
  raw: (text: string) => string;
  reference: (character: string) => string;
};

const NO_TOKENS: InlineTokens = {
  write: (text) => text,
  held: new Map(),
  opaque: ["", ""],
  scope: ["", ""],
  raw: (text) => text,
  reference: (character) => character,
};

function opening(mark: Mark, mode: OpeningMode, tokens: InlineTokens): string {
  if (mode === "underscore") return UNDERSCORES[mark.type] ?? "";
  if (STARRED.has(mark.type)) return DELIMITERS[mark.type]!;
  const written = mark.type === "link" ? "[" : (DELIMITERS[mark.type] ?? "");
  if (written === "") return "";
  return tokens.scope[0] + tokens.opaque[0] + written + tokens.opaque[1];
}

function closing(mark: Mark, mode: OpeningMode, tokens: InlineTokens): string {
  if (mode === "underscore") return UNDERSCORES[mark.type] ?? "";
  if (STARRED.has(mark.type)) return DELIMITERS[mark.type]!;
  let written = DELIMITERS[mark.type] ?? "";
  if (mark.type === "link") {
    const href = mark.attrs?.href ?? "";
    const title = mark.attrs?.title ?? "";
    written = title ? `](${href} "${title}")` : `](${href})`;
  }
  if (written === "") return "";
  return tokens.opaque[0] + written + tokens.opaque[1] + tokens.scope[1];
}

const carries = (marks: Mark[] | undefined, mark: Mark): boolean =>
  (marks ?? []).some((other) => other.type === mark.type && attrsEqual(other.attrs, mark.attrs));

export class DohcMarkdownManager extends MarkdownManager {
  private tokens: InlineTokens = NO_TOKENS;

  writingTokens<T>(tokens: InlineTokens, render: () => T): T {
    const previous = this.tokens;
    this.tokens = tokens;
    try {
      return render();
    } finally {
      this.tokens = previous;
    }
  }

  override renderNodes(
    nodeOrNodes: JSONContent | JSONContent[],
    parentNode?: JSONContent,
    separator = "",
    index = 0,
    level = 0,
  ): string {
    if (!Array.isArray(nodeOrNodes)) {
      return super.renderNodes(nodeOrNodes, parentNode, separator, index, level);
    }
    return this.renderInline(nodeOrNodes, parentNode, separator, level);
  }

  private renderInline(
    nodes: JSONContent[],
    parentNode: JSONContent | undefined,
    separator: string,
    level: number,
  ): string {
    const rendered = new Map<number, string>();
    const layered = nodes.some((node) => (node.marks?.length ?? 0) > 1);
    const plain = layered
      ? this.writeMarks(nodes, parentNode, separator, level, true, rendered)
      : undefined;
    const nested = this.writeMarks(nodes, parentNode, separator, level, false, rendered)!;
    if (plain !== undefined && plain !== nested) {
      const kept = writeHeldCharacters(plain, this.tokens, true);
      if (!kept.strands) return kept.written;
    }
    return writeHeldCharacters(nested, this.tokens).written;
  }

  private writeMarks(
    nodes: JSONContent[],
    parentNode: JSONContent | undefined,
    separator: string,
    level: number,
    plain: boolean,
    rendered: Map<number, string>,
  ): string | undefined {
    const result: string[] = [];
    const active = new Map<string, Mark>();
    const modes = new Map<string, OpeningMode>();
    let boldOpenedWithItalic = false;
    const noteRun = (opened: Mark[]): void => {
      const at = opened.findIndex((mark) => mark.type === "bold");
      if (at === -1) return;
      boldOpenedWithItalic = modes.get("bold") === "markdown" && opened[at - 1]?.type === "italic";
    };
    let reopened = new Set<string>();
    let tangled = false;
    let looseEdge: boolean | undefined = true;
    const tokens = this.tokens;
    const opaque = nodes.some((node) => node.type === "text") ? tokens.opaque : ["", ""];
    const writtenEnd = (): string => {
      let end = "";
      for (let at = result.length - 1; at >= 0 && end.length < 64; at -= 1) {
        end = tokens.write(result[at]!.slice(-256)) + end;
      }
      return end;
    };
    const textAt = (index: number): string => {
      let text = rendered.get(index);
      if (text === undefined) {
        text = this.renderNodeToMarkdown(nodes[index]!, parentNode, index, level);
        rendered.set(index, text);
      }
      return text;
    };
    const ends = new Map<string, { from: number; end: number; mark: Mark }>();
    const endOf = (index: number, mark: Mark): number => {
      const known = ends.get(mark.type);
      if (known && known.from <= index && index <= known.end && carries([known.mark], mark)) {
        return known.end;
      }
      let end = index;
      while (nodes[end + 1]?.type === "text" && carries(nodes[end + 1]!.marks, mark)) end += 1;
      ends.set(mark.type, { from: index, end, mark });
      return end;
    };
    const looseAfterRun = (end: number): boolean => {
      if (/\s$/u.test(textAt(end))) return true;
      const after = nodes[end + 1];
      if (!after || after.type === "hardBreak") return true;
      if (after.type !== "text") return false;
      const head = tokens.write(textAt(end + 1).slice(0, 256));
      if (/^\s/u.test(head)) return true;
      const opens = (after.marks ?? []).filter((mark) => !carries(nodes[end]!.marks, mark));
      if (opens.length > 0) return !opens.some((mark) => FLANKING.has(mark.type));
      return looseAfter(head);
    };
    const nestFlankingInside = (index: number, toOpen: Mark[], before: () => boolean): Mark[] => {
      const order = toOpen.slice().reverse();
      const outer = Array.from(active.values());
      const tight = order.some((mark, at) => {
        if (!FLANKING.has(mark.type)) return false;
        const inside = order.slice(at + 1).filter((other) => !FLANKING.has(other.type));
        if (inside.length === 0) return false;
        if (at === 0 && !before()) return true;
        const end = endOf(index, mark);
        if (!inside.some((other) => endOf(index, other) === end)) return false;
        if ([...outer, ...order.slice(0, at)].some((other) => endOf(index, other) === end)) {
          const bold = active.get("bold");
          return (
            mark.type === "italic" && boldOpenedWithItalic && !!bold && endOf(index, bold) === end
          );
        }
        return !looseAfterRun(end);
      });
      if (!tight) return toOpen;
      return [
        ...order.filter((mark) => !FLANKING.has(mark.type)),
        ...order.filter((mark) => FLANKING.has(mark.type)),
      ].reverse();
    };
    const reopensOutside = (index: number, toOpen: Mark[]): string[] => {
      const opening = toOpen.filter((mark) => !FLANKING.has(mark.type));
      if (opening.length === 0 || /^\s*$/u.test(result.at(-1) ?? "")) return [];
      const order = Array.from(active.keys());
      const at = order.findIndex((type) => {
        if (!FLANKING.has(type)) return false;
        const end = endOf(index, active.get(type)!);
        if (!opening.some((other) => endOf(index, other) === end)) return false;
        const outer = order.slice(0, order.indexOf(type));
        if (outer.some((other) => endOf(index, active.get(other)!) === end)) return false;
        return !looseAfterRun(end);
      });
      return at === -1 ? [] : order.slice(at).reverse();
    };
    const closesWith = (closing: string[]): string[] => {
      const order = Array.from(active.keys());
      const from = Math.min(...closing.map((type) => order.indexOf(type)));
      const inner = order.slice(from);
      const keeps = inner.some((type) => !closing.includes(type));
      tangled ||= inner.some((type) => !closing.includes(type) && !STARRED.has(type));
      const closes = !plain && keeps && inner.some((type) => !STARRED.has(type)) ? inner : closing;
      return closes.slice().sort((a, b) => order.indexOf(b) - order.indexOf(a));
    };

    nodes.forEach((node, i) => {
      const next = nodes[i + 1] ?? null;
      if (!node.type) return;
      if (node.type !== "text") {
        let before = "";
        for (const [type, mark] of active) {
          before += closing(mark, modes.get(type) ?? "markdown", tokens);
        }
        active.clear();
        modes.clear();
        const written = this.renderNodeToMarkdown(node, parentNode, i, level);
        result.push(before + opaque[0] + written + opaque[1]);
        looseEdge = true;
        return;
      }

      let text = textAt(i);
      const reopening = reopened;
      reopened = new Set();
      if (active.size === 0 && !node.marks?.length) {
        looseEdge = undefined;
        result.push(text);
        return;
      }
      const current = new Map((node.marks ?? []).map((mark) => [mark.type, mark]));
      const toClose = Array.from(current)
        .filter(([, mark]) => !next || !carries(next.marks, mark))
        .map(([type]) => type);
      const blank = /^\s*$/u.test(text);
      let reopensHere = false;
      if (!blank && !plain) {
        let head = "";
        for (const type of reopensOutside(i, this.marksToOpen(active, current, next))) {
          head += closing(active.get(type)!, modes.get(type) ?? "markdown", tokens);
          active.delete(type);
          modes.delete(type);
        }
        if (head !== "") {
          const last = result.pop()!;
          const spaces = /\s*$/u.exec(last)![0];
          result.push(last.slice(0, last.length - spaces.length) + head + spaces);
          reopensHere = true;
        }
      }
      const before = (): boolean =>
        reopensHere || /^\s/u.test(text) || (looseEdge ?? looseBefore(writtenEnd()));
      const toOpen = blank
        ? []
        : plain
          ? this.marksToOpen(active, current, next)
          : nestFlankingInside(i, this.marksToOpen(active, current, next), before);
      const activeClosing = toClose.filter((type) => active.has(type));
      const crossed = activeClosing.length > 0 && toOpen.length > 0;

      let middleTrailing = "";
      if (toClose.length > 0 && !crossed) {
        middleTrailing = /\s+$/.exec(text)?.[0] ?? "";
        text = text.slice(0, text.length - middleTrailing.length);
      }
      let closed = false;
      if (!crossed && activeClosing.length > 0) {
        closed = true;
        for (const type of closesWith(activeClosing)) {
          text += closing(
            current.get(type) ?? active.get(type)!,
            modes.get(type) ?? "markdown",
            tokens,
          );
          active.delete(type);
          modes.delete(type);
        }
      }
      let leading = "";
      if (toOpen.length > 0) {
        leading = /^\s+/.exec(text)?.[0] ?? "";
        text = text.slice(leading.length);
      }
      toOpen.forEach((mark, at) => {
        const outermost = at === toOpen.length - 1;
        const asterisked =
          outermost && reopening.has(mark.type) && leading === "" && writtenEnd().endsWith("*");
        const mode: OpeningMode = asterisked ? "underscore" : "markdown";
        text = opening(mark, mode, tokens) + text;
        modes.set(mark.type, mode);
      });
      noteRun(toOpen);
      if (!crossed) {
        for (const mark of toOpen.slice().reverse()) active.set(mark.type, mark);
      }
      text = leading + text;

      let closeAtEnd: string[];
      if (crossed) {
        const nextTypes = new Set((next?.marks ?? []).map((mark) => mark.type));
        for (const mark of toOpen) {
          if (nextTypes.has(mark.type) && STARRED.has(mark.type)) reopened.add(mark.type);
        }
        tangled ||= reopened.size > 0;
        closeAtEnd = [...toOpen.map((mark) => mark.type), ...closesWith(activeClosing)];
      } else {
        closeAtEnd = closesWith(marksToCloseAtEnd(active, current, next));
      }
      let trailing = "";
      if (closeAtEnd.length > 0) {
        trailing = /\s+$/.exec(text)?.[0] ?? "";
        text = text.slice(0, text.length - trailing.length);
      }
      for (const type of closeAtEnd) {
        const mark = active.get(type) ?? current.get(type);
        if (mark) text += closing(mark, modes.get(type) ?? "markdown", tokens);
        closed = true;
        active.delete(type);
        modes.delete(type);
      }
      looseEdge = closed && trailing === "" && middleTrailing === "" ? true : undefined;
      result.push(text + trailing + middleTrailing);
    });
    return plain && tangled ? undefined : result.join(separator);
  }

  private marksToOpen(
    active: Map<string, Mark>,
    current: Map<string, Mark>,
    next: JSONContent | null,
  ): Mark[] {
    const toOpen = Array.from(current.values()).filter((mark) => {
      const open = active.get(mark.type);
      return !open || !attrsEqual(open.attrs, mark.attrs);
    });
    if (toOpen.length <= 1) return toOpen;
    const innerFirst = (a: Mark, b: Mark) =>
      (RANK[b.type] ?? Number.MAX_SAFE_INTEGER) - (RANK[a.type] ?? Number.MAX_SAFE_INTEGER) ||
      a.type.localeCompare(b.type);
    const continues = (mark: Mark) => carries(next?.marks, mark);
    return [
      ...toOpen.filter((mark) => !continues(mark)).sort(innerFirst),
      ...toOpen.filter(continues).sort(innerFirst),
    ];
  }
}

function marksToCloseAtEnd(
  active: Map<string, Mark>,
  current: Map<string, Mark>,
  next: JSONContent | null,
): string[] {
  const nextMarks = next?.marks;
  const currentMarks = Array.from(current.values());
  const sameSet =
    nextMarks &&
    nextMarks.length === current.size &&
    nextMarks.every((mark) => carries(currentMarks, mark));
  if (next && nextMarks?.length && sameSet) return [];
  const types = Array.from(active.entries()).reverse();
  if (next && nextMarks?.length) {
    return types.filter(([, mark]) => !carries(nextMarks, mark)).map(([type]) => type);
  }
  return types.map(([type]) => type);
}
