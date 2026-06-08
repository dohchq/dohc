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
      return [...texts.values()].filter(
        (file) => file.workspaceId === actor.workspaceId,
      );
    },
    async readText(actor, path) {
      assertMember(actor);
      const file = texts.get(key(actor.workspaceId, path));
      if (!file) throw new WorkspaceError("not_found", "File not found");
      return { body: file.body, revision: file.revision };
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
    async saveAsset(_actor, _input: SaveAssetInput) {
      throw new WorkspaceError(
        "unsupported_media_type",
        "Memory backend only supports text atoms",
      );
    },
    async deleteFile(actor, path) {
      assertMember(actor);
      texts.delete(key(actor.workspaceId, path));
    },
  };
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
