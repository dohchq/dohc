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

export type ReadAssetOutput = {
  mediaType: string;
  kind: AssetKind;
  bytes: Uint8Array;
  revision: string;
};

export type RenameFileInput = {
  fromPath: string;
  toName: string;
  expectedRevision: string;
};

export type WorkspaceBackend = {
  listFiles(actor: Actor): Promise<WorkspaceFile[]>;
  getFileMetadata?(actor: Actor, path: string): Promise<WorkspaceFile | null>;
  readText(
    actor: Actor,
    path: string,
  ): Promise<{
    /** Derived markdown/text cache, not the canonical Y.Doc state. */
    body: string;
    revision: string;
  }>;
  readAsset(actor: Actor, path: string): Promise<ReadAssetOutput>;
  createAtom(actor: Actor, input: CreateAtomInput): Promise<WorkspaceFile>;
  writeAtom(actor: Actor, input: WriteAtomInput): Promise<WorkspaceFile>;
  saveAsset(actor: Actor, input: SaveAssetInput): Promise<WorkspaceFile>;
  renameFile(actor: Actor, input: RenameFileInput): Promise<WorkspaceFile>;
  deleteFile(actor: Actor, path: string): Promise<void>;
};
