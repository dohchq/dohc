import { getDohcYDocMeta } from "@dohc/ydoc-projection";
import type * as Y from "yjs";
import { post } from "./bridge";

const KNOWN_FORMATS: unknown[] = [1, 2];

export const opensFormat = (doc: Y.Doc) =>
  KNOWN_FORMATS.includes(getDohcYDocMeta(doc).schemaVersion);

export const refuseFormat = () => post("unsupportedFormat");
