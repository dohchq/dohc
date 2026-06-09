import { WorkspaceError } from "./errors";
import type {
  Actor,
  CreateAtomInput,
  SaveAssetInput,
  WorkspaceBackend,
  WriteAtomInput,
} from "./backend";
import type { WorkspaceFile } from "./domain";
import { runWorkspaceBackendConformance } from "./conformance";
import type { WorkspaceBackendTestAdapter } from "./testHarness";

type StoredText = WorkspaceFile & {
  body: string;
  revisionNumber: number;
};

type StoredAsset = WorkspaceFile & {
  mediaType: string;
  assetKind: SaveAssetInput["kind"];
  bytes: Uint8Array;
  revisionNumber: number;
};

function makeFile(args: {
  id: string;
  workspaceId: string;
  path: string;
  kind: WorkspaceFile["kind"];
  contentType: string;
  revisionNumber: number;
}): WorkspaceFile {
  return {
    id: args.id,
    workspaceId: args.workspaceId,
    path: args.path,
    kind: args.kind,
    contentType: args.contentType,
    revision: String(args.revisionNumber),
    updatedAt: args.revisionNumber,
  };
}

function createMemoryBackend(memberships: Set<string>): WorkspaceBackend {
  const texts = new Map<string, StoredText>();
  const assets = new Map<string, StoredAsset>();

  function key(workspaceId: string, path: string) {
    return `${workspaceId}:${path}`;
  }

  function assertMember(actor: Actor) {
    if (!memberships.has(`${actor.workspaceId}:${actor.userId}`)) {
      throw new WorkspaceError("forbidden", "User is not a workspace member");
    }
  }

  return {
    async listFiles(actor) {
      assertMember(actor);
      return [...texts.values(), ...assets.values()]
        .filter((file) => file.workspaceId === actor.workspaceId)
        .sort((a, b) => a.path.localeCompare(b.path));
    },
    async readText(actor, path) {
      assertMember(actor);
      const file = texts.get(key(actor.workspaceId, path));
      if (!file) throw new WorkspaceError("not_found", "File not found");
      return { body: file.body, revision: file.revision };
    },
    async readAsset(actor, path) {
      assertMember(actor);
      const file = assets.get(key(actor.workspaceId, path));
      if (!file) throw new WorkspaceError("not_found", "File not found");
      return {
        mediaType: file.mediaType,
        kind: file.assetKind,
        bytes: new Uint8Array(file.bytes),
        revision: file.revision,
      };
    },
    async createAtom(actor, input: CreateAtomInput) {
      assertMember(actor);
      const revisionNumber = 1;
      const file = {
        ...makeFile({
          id: `${actor.workspaceId}:${input.path}`,
          workspaceId: actor.workspaceId,
          path: input.path,
          kind: "atom",
          contentType: `text/${input.kind}`,
          revisionNumber,
        }),
        body: input.body,
        revisionNumber,
      };
      texts.set(key(actor.workspaceId, input.path), file);
      return file;
    },
    async writeAtom(actor, input: WriteAtomInput) {
      assertMember(actor);
      const existing = texts.get(key(actor.workspaceId, input.path));
      if (!existing) throw new WorkspaceError("not_found", "File not found");
      if (existing.revision !== input.expectedRevision) {
        throw new WorkspaceError("conflict", "Expected revision is stale");
      }
      const revisionNumber = existing.revisionNumber + 1;
      const file = {
        ...existing,
        body: input.body,
        revision: String(revisionNumber),
        revisionNumber,
        updatedAt: revisionNumber,
      };
      texts.set(key(actor.workspaceId, input.path), file);
      return file;
    },
    async saveAsset(actor, input: SaveAssetInput) {
      assertMember(actor);
      const revisionNumber = 1;
      const file = {
        ...makeFile({
          id: `${actor.workspaceId}:${input.path}`,
          workspaceId: actor.workspaceId,
          path: input.path,
          kind: "asset",
          contentType: input.mediaType,
          revisionNumber,
        }),
        mediaType: input.mediaType,
        assetKind: input.kind,
        bytes: new Uint8Array(input.bytes),
        revisionNumber,
      };
      assets.set(key(actor.workspaceId, input.path), file);
      return file;
    },
    async renameFile(actor, input) {
      assertMember(actor);
      const fromKey = key(actor.workspaceId, input.fromPath);
      const text = texts.get(fromKey);
      const asset = assets.get(fromKey);
      const existing = text ?? asset;
      if (!existing) throw new WorkspaceError("not_found", "File not found");
      if (existing.revision !== input.expectedRevision) {
        throw new WorkspaceError("conflict", "Expected revision is stale");
      }
      const nextPath = composePath(input.fromPath, input.toName);
      const nextKey = key(actor.workspaceId, nextPath);
      if (texts.has(nextKey) || assets.has(nextKey)) {
        throw new WorkspaceError("conflict", "File path already exists");
      }
      const revisionNumber = existing.revisionNumber + 1;
      const renamed = {
        ...existing,
        path: nextPath,
        revision: String(revisionNumber),
        revisionNumber,
        updatedAt: revisionNumber,
      };
      if (text) {
        texts.delete(fromKey);
        texts.set(nextKey, renamed as StoredText);
      } else {
        assets.delete(fromKey);
        assets.set(nextKey, renamed as StoredAsset);
      }
      return renamed;
    },
    async deleteFile(actor, path) {
      assertMember(actor);
      texts.delete(key(actor.workspaceId, path));
      assets.delete(key(actor.workspaceId, path));
    },
  };
}

function composePath(fromPath: string, toName: string) {
  const folderPath = fromPath.includes("/")
    ? fromPath.slice(0, fromPath.lastIndexOf("/"))
    : "";
  const cleanName = toName.trim().replace(/^\/+|\/+$/g, "");
  return folderPath ? `${folderPath}/${cleanName}` : cleanName;
}

const memoryAdapter: WorkspaceBackendTestAdapter = {
  name: "memory",
  async setup() {
    const memberships = new Set(["workspace_a:alice", "workspace_b:bob"]);
    return {
      backend: createMemoryBackend(memberships),
      actor: { userId: "alice", workspaceId: "workspace_a" },
      otherActor: { userId: "bob", workspaceId: "workspace_b" },
    };
  },
  async teardown() {},
};

runWorkspaceBackendConformance(memoryAdapter);
