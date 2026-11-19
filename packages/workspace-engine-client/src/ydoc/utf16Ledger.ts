import * as Y from "yjs";

const ILL_FORMED_UTF16_PATTERN =
  /[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/;

export function isWellFormedUtf16(value: string): boolean {
  return typeof value.isWellFormed === "function"
    ? value.isWellFormed()
    : !ILL_FORMED_UTF16_PATTERN.test(value);
}

function jsonWellFormed(value: unknown): boolean {
  if (typeof value === "string") return isWellFormedUtf16(value);
  if (Array.isArray(value)) return value.every(jsonWellFormed);
  if (value !== null && typeof value === "object")
    return Object.entries(value).every(
      ([key, item]) => isWellFormedUtf16(key) && jsonWellFormed(item),
    );
  return true;
}

function contentWellFormed(content: Y.Item["content"]): boolean {
  if (content instanceof Y.ContentString) return isWellFormedUtf16(content.str);
  if (content instanceof Y.ContentFormat)
    return isWellFormedUtf16(content.key) && jsonWellFormed(content.value);
  if (content instanceof Y.ContentEmbed) return jsonWellFormed(content.embed);
  if (content instanceof Y.ContentAny || content instanceof Y.ContentJSON)
    return jsonWellFormed(content.arr);
  if (content instanceof Y.ContentType) {
    const type = content.type;
    if (type instanceof Y.XmlElement) return isWellFormedUtf16(type.nodeName);
    if (type instanceof Y.XmlHook) return isWellFormedUtf16(type.hookName);
  }
  return true;
}

function replacements(value: string): number {
  let count = 0;
  for (let at = value.indexOf("�"); at !== -1; at = value.indexOf("�", at + 1)) count += 1;
  return count;
}

type SharedType = Y.AbstractType<Y.YEvent<any>>;

/** U+FFFD in a type's own live text, where Yjs leaves one for each half of a split surrogate pair. */
function liveReplacements(type: SharedType): number {
  let count = 0;
  for (let item = type._start; item !== null; item = item.right)
    if (!item.deleted && item.content instanceof Y.ContentString)
      count += replacements(item.content.str);
  return count;
}

export interface Utf16Verdict {
  readonly illFormed: boolean;
  /** U+FFFD the transaction added without inserting it, as a split surrogate pair leaves. */
  readonly newReplacement: boolean;
}

/** Checks each transaction's UTF-16 from what it inserted, deleted and touched, never the whole note. */
export class Utf16Ledger {
  private readonly counts = new WeakMap<SharedType, number>();
  private readonly verdicts = new WeakMap<Y.Transaction, Utf16Verdict>();
  private roots: number;

  constructor(private readonly doc: Y.Doc) {
    for (const type of doc.share.values()) this.counts.set(type, liveReplacements(type));
    for (const structs of doc.store.clients.values())
      for (const struct of structs)
        if (struct instanceof Y.Item && !struct.deleted && struct.content instanceof Y.ContentType)
          this.counts.set(struct.content.type, liveReplacements(struct.content.type));
    this.roots = doc.share.size;
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

  // Runs before Yjs collects deleted content, so a deleted string still holds its text.
  private readonly observe = (transaction: Y.Transaction): void => {
    let illFormed = false;
    if (this.doc.share.size !== this.roots) {
      this.roots = this.doc.share.size;
      for (const [name, type] of this.doc.share) {
        if (!isWellFormedUtf16(name)) illFormed = true;
        if (!this.counts.has(type)) this.counts.set(type, 0);
      }
    }
    const touched = new Set<SharedType>(transaction.changed.keys());
    transaction.afterState.forEach((after, client) => {
      const before = transaction.beforeState.get(client) ?? 0;
      if (after === before) return;
      const structs = this.doc.store.clients.get(client)!;
      for (let index = Y.findIndexSS(structs, before); index < structs.length; index += 1) {
        const struct = structs[index]!;
        if (!(struct instanceof Y.Item)) continue;
        if (struct.parentSub !== null && !isWellFormedUtf16(struct.parentSub)) illFormed = true;
        if (!contentWellFormed(struct.content)) illFormed = true;
        touched.add(struct.parent as SharedType);
        if (struct.content instanceof Y.ContentType) touched.add(struct.content.type);
      }
    });
    const deleted = new Map<SharedType, number>();
    Y.iterateDeletedStructs(transaction, transaction.deleteSet, (struct) => {
      if (!(struct instanceof Y.Item)) return;
      const parent = struct.parent as SharedType;
      touched.add(parent);
      if (struct.content instanceof Y.ContentString)
        deleted.set(parent, (deleted.get(parent) ?? 0) + replacements(struct.content.str));
    });
    let newReplacement = false;
    for (const type of touched) {
      const after = liveReplacements(type);
      if (after - (this.counts.get(type) ?? 0) + (deleted.get(type) ?? 0) > 0)
        newReplacement = true;
      this.counts.set(type, after);
    }
    this.verdicts.set(transaction, { illFormed, newReplacement });
  };
}
