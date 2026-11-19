import * as Y from "yjs";

const ILL_FORMED_UTF16_PATTERN =
  /[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/;

export function isWellFormedUtf16(value: string): boolean {
  return typeof value.isWellFormed === "function"
    ? value.isWellFormed()
    : !ILL_FORMED_UTF16_PATTERN.test(value);
}

const REPLACEMENT = "�";

function replacements(value: string): number {
  let count = 0;
  for (let at = value.indexOf(REPLACEMENT); at !== -1; at = value.indexOf(REPLACEMENT, at + 1))
    count += 1;
  return count;
}

function visitJsonStrings(value: unknown, visit: (value: string) => void): void {
  if (typeof value === "string") visit(value);
  else if (Array.isArray(value)) for (const item of value) visitJsonStrings(item, visit);
  else if (value !== null && typeof value === "object")
    for (const [key, item] of Object.entries(value)) {
      visit(key);
      visitJsonStrings(item, visit);
    }
}

function visitValueStrings(item: Y.Item, visit: (value: string) => void): void {
  if (item.parentSub !== null) visit(item.parentSub);
  const content = item.content;
  if (content instanceof Y.ContentFormat) {
    visit(content.key);
    visitJsonStrings(content.value, visit);
  } else if (content instanceof Y.ContentEmbed) visitJsonStrings(content.embed, visit);
  else if (content instanceof Y.ContentAny || content instanceof Y.ContentJSON)
    visitJsonStrings(content.arr, visit);
  else if (content instanceof Y.ContentType) {
    const type = content.type;
    if (type instanceof Y.XmlElement) visit(type.nodeName);
    else if (type instanceof Y.XmlHook) visit(type.hookName);
  }
}

type SharedType = Y.AbstractType<Y.YEvent<any>>;

function liveTextReplacements(type: SharedType): number {
  let count = 0;
  for (let item = type._start; item !== null; item = item.right)
    if (!item.deleted && item.content instanceof Y.ContentString)
      count += replacements(item.content.str);
  return count;
}

export interface Utf16Verdict {
  readonly illFormed: boolean;
  /** U+FFFD the transaction added, as a split surrogate pair leaves in text. */
  readonly newReplacement: boolean;
}

/** Checks each transaction's UTF-16 from what it inserted, deleted and split, never the whole note. */
export class Utf16Ledger {
  private readonly textReplacements = new WeakMap<SharedType, number>();
  private readonly verdicts = new WeakMap<Y.Transaction, Utf16Verdict>();
  private readonly rootNames = new Set<string>();
  private illFormedRoot = false;

  constructor(private readonly doc: Y.Doc) {
    this.readRootNames();
    for (const type of doc.share.values())
      this.textReplacements.set(type, liveTextReplacements(type));
    for (const structs of doc.store.clients.values())
      for (const struct of structs)
        if (struct instanceof Y.Item && !struct.deleted && struct.content instanceof Y.ContentType)
          this.textReplacements.set(struct.content.type, liveTextReplacements(struct.content.type));
    doc.on("afterTransaction", this.observe);
  }

  dispose(): void {
    this.doc.off("afterTransaction", this.observe);
  }

  /** The verdict on a transaction this ledger observed. */
  verdict(transaction: Y.Transaction): Utf16Verdict {
    const verdict = this.verdicts.get(transaction);
    if (verdict === undefined) throw new Error("The UTF-16 check did not observe this edit.");
    return verdict;
  }

  private readRootNames(): number {
    let added = 0;
    for (const name of this.doc.share.keys()) {
      if (this.rootNames.has(name)) continue;
      this.rootNames.add(name);
      if (!isWellFormedUtf16(name)) this.illFormedRoot = true;
      added += replacements(name);
    }
    return added;
  }

  // Runs before Yjs collects deleted content, so a deleted string still holds its text.
  private readonly observe = (transaction: Y.Transaction): void => {
    const added = this.doc.share.size === this.rootNames.size ? 0 : this.readRootNames();
    let illFormed = this.illFormedRoot;
    const net = new Map<SharedType, number>();
    const deletedText = new Map<SharedType, number>();
    const recount = new Set<SharedType>();
    const tally = (counts: Map<SharedType, number>, type: SharedType, count: number) => {
      if (count !== 0) counts.set(type, (counts.get(type) ?? 0) + count);
    };
    transaction.afterState.forEach((after, client) => {
      const before = transaction.beforeState.get(client) ?? 0;
      if (after === before) return;
      const structs = this.doc.store.clients.get(client)!;
      for (let index = Y.findIndexSS(structs, before); index < structs.length; index += 1) {
        const struct = structs[index]!;
        if (!(struct instanceof Y.Item) || struct.deleted) continue;
        const parent = struct.parent as SharedType;
        if (struct.content instanceof Y.ContentString) {
          if (!isWellFormedUtf16(struct.content.str)) illFormed = true;
          if (struct.content.str.includes(REPLACEMENT)) recount.add(parent);
        }
        visitValueStrings(struct, (value) => {
          if (!isWellFormedUtf16(value)) illFormed = true;
          tally(net, parent, replacements(value));
        });
      }
    });
    Y.iterateDeletedStructs(transaction, transaction.deleteSet, (struct) => {
      if (!(struct instanceof Y.Item)) return;
      if (struct.id.clock >= (transaction.beforeState.get(struct.id.client) ?? 0)) return;
      const parent = struct.parent as SharedType;
      if (struct.content instanceof Y.ContentString) {
        const count = replacements(struct.content.str);
        if (count > 0) recount.add(parent);
        tally(deletedText, parent, count);
      }
      visitValueStrings(struct, (value) => tally(net, parent, -replacements(value)));
    });
    for (const right of transaction._mergeStructs) {
      if (!(right instanceof Y.Item) || !(right.content instanceof Y.ContentString)) continue;
      if (right.origin === null || !right.content.str.startsWith(REPLACEMENT)) continue;
      const left = Y.getItem(this.doc.store, right.origin);
      if (left instanceof Y.Item && left.content instanceof Y.ContentString)
        if (left.content.str.endsWith(REPLACEMENT)) recount.add(right.parent as SharedType);
    }
    for (const type of recount) {
      const after = liveTextReplacements(type);
      tally(
        net,
        type,
        after - (this.textReplacements.get(type) ?? 0) + (deletedText.get(type) ?? 0),
      );
      this.textReplacements.set(type, after);
    }
    let newReplacement = added > 0;
    for (const count of net.values()) if (count > 0) newReplacement = true;
    this.verdicts.set(transaction, { illFormed, newReplacement });
  };
}
