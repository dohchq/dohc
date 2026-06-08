import type { AssetKind, AtomKind, WorkspaceFile } from "./domain";

export type Actor = {
  userId: string;
  workspaceId: string;
};

export type CreateAtomInput = {
  path: string;
  kind: AtomKind;
  /**
   * Markdown/text cache for the atom. This is not a raw Y.Doc update.
   * Backends that store canonical collaborative state must persist that state
   * separately and keep this body synchronized as a derived readable cache.
   */
  body: string;
};

export type WriteAtomInput = {
  path: string;
  expectedRevision: string;
  /**
   * Replacement markdown/text cache for the atom. Implementations must apply
   * policy and revision checks before updating canonical document state and
   * deriving the cache; raw Y.Doc bytes never travel through this field.
   */
  body: string;
};

export type SaveAssetInput = {
  path: string;
  kind: AssetKind;
  mediaType: string;
  bytes: Uint8Array;
};

export type WorkspaceBackend = {
  listFiles(actor: Actor): Promise<WorkspaceFile[]>;
  readText(
    actor: Actor,
    path: string,
  ): Promise<{
    /** Derived markdown/text cache, not the canonical Y.Doc state. */
    body: string;
    revision: string;
  }>;
  createAtom(actor: Actor, input: CreateAtomInput): Promise<WorkspaceFile>;
  writeAtom(actor: Actor, input: WriteAtomInput): Promise<WorkspaceFile>;
  saveAsset(actor: Actor, input: SaveAssetInput): Promise<WorkspaceFile>;
  deleteFile(actor: Actor, path: string): Promise<void>;
};
