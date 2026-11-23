import { getDohcYDocMeta } from "@dohc/ydoc-projection";
import type * as Y from "yjs";
import { post } from "./bridge";

const KNOWN_FORMAT = 1;

export const opensFormat = (doc: Y.Doc) => getDohcYDocMeta(doc).schemaVersion === KNOWN_FORMAT;

export const refuseFormat = () => post("unsupportedFormat");
