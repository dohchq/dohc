import { getDohcYDocMeta } from "@dohc/ydoc-projection";
import type * as Y from "yjs";
import { post } from "./bridge";

/** The one note format this build's editor binds to. */
const KNOWN_FORMAT = 1;

export const opensFormat = (doc: Y.Doc) => getDohcYDocMeta(doc).schemaVersion === KNOWN_FORMAT;

/** Tells the app this page needs a newer build, which it shows instead of the page. */
export const refuseFormat = () => post("unsupportedFormat");
