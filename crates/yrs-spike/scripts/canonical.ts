// JS-side canonical content JSON for a Y.Doc — the same shape the Rust
// harness emits from yrs (src/main.rs `content_json`), computed independently
// from Yjs so the two implementations' views of one converged doc can be
// compared at CONTENT level (maps, text deltas with formatting attributes,
// the full XML element tree), not just state vectors.
//
// The Yjs v1 wire format does not carry root-type kinds, so both sides read
// roots through the same declared schema (typed getters), mirroring how the
// TS engine reads dohc docs.

import * as Y from "yjs";
import type { RootSchema } from "./rustPeer.js";

type Json = null | boolean | number | string | Json[] | { [key: string]: Json };

export function canonicalContent(doc: Y.Doc, schema: RootSchema): Json {
  const roots: Record<string, Json> = {};
  for (const [name, kind] of Object.entries(schema)) {
    if (kind === "map") {
      const m = doc.getMap(name);
      if (m.size === 0) continue;
      const value: Record<string, Json> = {};
      for (const [k, v] of m.entries()) value[k] = anyWrapped(v);
      roots[name] = { type: "map", value };
    } else if (kind === "text") {
      const t = doc.getText(name);
      if (t.length === 0) continue;
      roots[name] = { type: "text", delta: deltaJson(t.toDelta() as DeltaItem[]) };
    } else {
      const f = doc.getXmlFragment(name);
      if (f.length === 0) continue;
      roots[name] = { type: "xmlFragment", children: xmlChildren(f) };
    }
  }
  for (const name of doc.share.keys()) {
    if (!(name in schema)) roots[name] = { type: "undeclaredRoot" };
  }
  return roots;
}

interface DeltaItem {
  insert: unknown;
  attributes?: Record<string, unknown>;
}

function deltaJson(delta: DeltaItem[]): Json[] {
  return delta.map((item): Json => {
    const insert = plainJson(item.insert);
    return item.attributes !== undefined
      ? { insert, attrs: plainJson(item.attributes) }
      : { insert };
  });
}

function xmlChildren(node: Y.XmlFragment | Y.XmlElement): Json[] {
  const children: Json[] = [];
  for (let i = 0; i < node.length; i += 1) {
    const child = node.get(i);
    children.push(xmlJson(child));
  }
  return children;
}

function xmlJson(node: Y.XmlElement | Y.XmlText | Y.XmlHook | Y.XmlFragment): Json {
  if (node instanceof Y.XmlElement) {
    return {
      type: "element",
      tag: node.nodeName,
      attrs: plainJson(node.getAttributes()),
      children: xmlChildren(node),
    };
  }
  if (node instanceof Y.XmlText) {
    return { type: "xmlText", delta: deltaJson(node.toDelta() as DeltaItem[]) };
  }
  if (node instanceof Y.XmlFragment) {
    return { type: "xmlFragment", children: xmlChildren(node) };
  }
  return { type: "unsupported", debug: String(node) };
}

/** Map/attr values and delta embeds are plain (Any) values in dohc docs. */
function plainJson(value: unknown): Json {
  if (value === null || value === undefined) return null;
  if (typeof value === "boolean" || typeof value === "string") return value;
  if (typeof value === "number") return value;
  if (value instanceof Uint8Array) {
    return { __bytes__: Buffer.from(value).toString("base64") };
  }
  if (Array.isArray(value)) return value.map(plainJson);
  if (typeof value === "object") {
    const out: Record<string, Json> = {};
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
      out[k] = plainJson(v);
    }
    return out;
  }
  return String(value);
}

function anyWrapped(value: unknown): Json {
  return { type: "any", value: plainJson(value) };
}

// ---- normalization + comparison ---------------------------------------------
//
// Applied to BOTH sides' trees before comparison:
//  - deep-sort object keys (Rust already sorts; JS insertion order varies),
//  - merge adjacent string delta runs whose attrs are identical (the two
//    implementations may chunk one logical run differently),
//  - drop empty attrs objects.

export function normalize(value: Json): Json {
  if (Array.isArray(value)) return value.map(normalize);
  if (value !== null && typeof value === "object") {
    const obj = value as { [key: string]: Json };
    if (Array.isArray(obj.delta)) {
      return { ...sortKeys(obj), delta: mergeRuns(obj.delta.map(normalize)) };
    }
    return sortKeys(obj);
  }
  return value;
}

function sortKeys(obj: { [key: string]: Json }): { [key: string]: Json } {
  const out: { [key: string]: Json } = {};
  for (const key of Object.keys(obj).sort()) {
    const v = normalize(obj[key]!);
    if (key === "attrs" && v !== null && typeof v === "object" && !Array.isArray(v) && Object.keys(v).length === 0) {
      continue; // drop empty attrs
    }
    out[key] = v;
  }
  return out;
}

function mergeRuns(delta: Json[]): Json[] {
  const out: Json[] = [];
  for (const item of delta) {
    const prev = out[out.length - 1];
    if (
      prev !== undefined &&
      isRun(prev) &&
      isRun(item) &&
      typeof prev.insert === "string" &&
      typeof item.insert === "string" &&
      stableStringify(prev.attrs ?? null) === stableStringify(item.attrs ?? null)
    ) {
      prev.insert += item.insert;
    } else {
      out.push(item);
    }
  }
  return out;
}

function isRun(v: Json): v is { insert: string; attrs?: Json } {
  return v !== null && typeof v === "object" && !Array.isArray(v) && "insert" in v;
}

export function stableStringify(value: Json): string {
  if (Array.isArray(value)) return `[${value.map(stableStringify).join(",")}]`;
  if (value !== null && typeof value === "object") {
    const entries = Object.keys(value)
      .sort()
      .map((k) => `${JSON.stringify(k)}:${stableStringify(value[k]!)}`);
    return `{${entries.join(",")}}`;
  }
  return JSON.stringify(value);
}

export function contentsEqual(a: unknown, b: unknown): boolean {
  return stableStringify(normalize(a as Json)) === stableStringify(normalize(b as Json));
}

export function contentDiff(a: unknown, b: unknown): string {
  const sa = stableStringify(normalize(a as Json));
  const sb = stableStringify(normalize(b as Json));
  if (sa === sb) return "";
  let at = 0;
  while (at < sa.length && at < sb.length && sa[at] === sb[at]) at += 1;
  const from = Math.max(0, at - 120);
  return [
    `first divergence at char ${at}:`,
    `  a: ...${sa.slice(from, at + 160)}`,
    `  b: ...${sb.slice(from, at + 160)}`,
  ].join("\n");
}
