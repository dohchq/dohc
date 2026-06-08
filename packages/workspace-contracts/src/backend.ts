import type { AssetKind, AtomKind, WorkspaceFile } from "./domain";

export type Actor = {
  userId: string;
  workspaceId: string;
};

export type CreateAtomInput = {
  path: string;
  kind: AtomKind;
  body: string;
};

export type WriteAtomInput = {
  path: string;
  expectedRevision: string;
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
  ): Promise<{ body: string; revision: string }>;
  createAtom(actor: Actor, input: CreateAtomInput): Promise<WorkspaceFile>;
  writeAtom(actor: Actor, input: WriteAtomInput): Promise<WorkspaceFile>;
  saveAsset(actor: Actor, input: SaveAssetInput): Promise<WorkspaceFile>;
  deleteFile(actor: Actor, path: string): Promise<void>;
};
