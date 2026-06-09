/// <reference types="vite/client" />
import { convexTest } from "convex-test";
import type {
  Actor,
  CreateAtomInput,
  ReadAssetOutput,
  RenameFileInput,
  SaveAssetInput,
  WorkspaceBackend,
  WorkspaceFile,
  WriteAtomInput,
} from "@dohc/workspace-contracts";
import { composeRenamedPath, WorkspaceError } from "@dohc/workspace-contracts";
import schema from "../../../apps/app/convex/schema";
import { api } from "../../../apps/app/convex/_generated/api";

const modules = import.meta.glob("../../../apps/app/convex/**/*.ts");

type ConvexTestHandle = ReturnType<typeof convexTest>;

type AtomListRow = {
  _id: string;
  path: string;
  updatedAt: number;
  type: "html" | "command" | "skill" | null;
};

type StoredAsset = WorkspaceFile & {
  mediaType: string;
  assetKind: SaveAssetInput["kind"];
  bytes: Uint8Array;
  revisionNumber: number;
};

export const convexTestAdapter = {
  name: "convex",
  async setup() {
    const t = convexTest(schema, modules);
    const revisions = new Map<string, number>();
    const assets = new Map<string, StoredAsset>();
    const backend = createConvexWorkspaceBackend(t, revisions, assets);

    return {
      backend,
      actor: { userId: "workspace_a", workspaceId: "workspace_a" },
      otherActor: { userId: "workspace_b", workspaceId: "workspace_b" },
    };
  },
  async teardown() {},
};

function createConvexWorkspaceBackend(
  t: ConvexTestHandle,
  revisions: Map<string, number>,
  assets: Map<string, StoredAsset>,
): WorkspaceBackend {
  return {
    async listFiles(actor) {
      const rows = await asActor(t, actor).query(api.atoms.list, {
        activeWorkspaceId: actor.workspaceId,
      });
      const atomFiles = (rows as AtomListRow[]).map((row) =>
        rowToWorkspaceFile(actor, row, revisionFor(revisions, actor, row.path)),
      );
      const assetFiles = [...assets.values()].filter(
        (asset) => asset.workspaceId === actor.workspaceId,
      );
      return [...atomFiles, ...assetFiles].sort((a, b) =>
        a.path.localeCompare(b.path),
      );
    },
    async readText(actor, path) {
      const row = await asActor(t, actor).query(api.atoms.getByPath, {
        path,
        activeWorkspaceId: actor.workspaceId,
      });
      if (!row) throw new WorkspaceError("not_found", "Atom not found");
      return {
        body: row.body,
        revision: String(revisionFor(revisions, actor, path)),
      };
    },
    async getFileMetadata(actor, path) {
      const row = await asActor(t, actor).query(api.atoms.getByPath, {
        path,
        activeWorkspaceId: actor.workspaceId,
      });
      if (row) {
        return rowToWorkspaceFile(
          actor,
          {
            _id: row._id,
            path: row.path,
            updatedAt: row.updatedAt,
            type: null,
          },
          revisionFor(revisions, actor, path),
        );
      }
      return assets.get(assetKey(actor, path)) ?? null;
    },
    async readAsset(actor, path): Promise<ReadAssetOutput> {
      const asset = assets.get(assetKey(actor, path));
      if (!asset) throw new WorkspaceError("not_found", "Asset not found");
      return {
        mediaType: asset.mediaType,
        kind: asset.assetKind,
        bytes: new Uint8Array(asset.bytes),
        revision: asset.revision,
      };
    },
    async createAtom(actor, input: CreateAtomInput) {
      const existing = await asActor(t, actor).query(api.atoms.getByPath, {
        path: input.path,
        activeWorkspaceId: actor.workspaceId,
      });
      if (existing) throw new WorkspaceError("conflict", "File path exists");

      await asActor(t, actor).mutation(api.atoms.upsert, {
        path: input.path,
        body: input.body,
        source: "user",
        activeWorkspaceId: actor.workspaceId,
      });
      revisions.set(revisionKey(actor, input.path), 1);
      const row = await asActor(t, actor).query(api.atoms.getByPath, {
        path: input.path,
        activeWorkspaceId: actor.workspaceId,
      });
      if (!row) throw new WorkspaceError("not_found", "Atom not found");
      return rowToWorkspaceFile(
        actor,
        {
          _id: row._id,
          path: row.path,
          updatedAt: row.updatedAt,
          type: null,
        },
        1,
      );
    },
    async writeAtom(actor, input: WriteAtomInput) {
      const currentRevision = revisionFor(revisions, actor, input.path);
      if (String(currentRevision) !== input.expectedRevision) {
        throw new WorkspaceError("conflict", "Expected revision is stale");
      }

      const row = await asActor(t, actor).query(api.atoms.getByPath, {
        path: input.path,
        activeWorkspaceId: actor.workspaceId,
      });
      if (!row) throw new WorkspaceError("not_found", "Atom not found");

      await asActor(t, actor).mutation(api.atoms.upsert, {
        path: input.path,
        body: input.body,
        source: "user",
        activeWorkspaceId: actor.workspaceId,
      });
      const nextRevision = currentRevision + 1;
      revisions.set(revisionKey(actor, input.path), nextRevision);

      const updated = await asActor(t, actor).query(api.atoms.getByPath, {
        path: input.path,
        activeWorkspaceId: actor.workspaceId,
      });
      if (!updated) throw new WorkspaceError("not_found", "Atom not found");
      return rowToWorkspaceFile(
        actor,
        {
          _id: updated._id,
          path: updated.path,
          updatedAt: updated.updatedAt,
          type: null,
        },
        nextRevision,
      );
    },
    async saveAsset(actor, input: SaveAssetInput) {
      const revisionNumber = 1;
      const asset: StoredAsset = {
        id: `${actor.workspaceId}:${input.path}`,
        workspaceId: actor.workspaceId,
        path: input.path,
        kind: "asset",
        contentType: input.mediaType,
        revision: String(revisionNumber),
        updatedAt: Date.now(),
        mediaType: input.mediaType,
        assetKind: input.kind,
        bytes: new Uint8Array(input.bytes),
        revisionNumber,
      };
      assets.set(assetKey(actor, input.path), asset);
      return asset;
    },
    async renameFile(actor, input: RenameFileInput) {
      const asset = assets.get(assetKey(actor, input.fromPath));
      if (asset) {
        if (asset.revision !== input.expectedRevision) {
          throw new WorkspaceError("conflict", "Expected revision is stale");
        }
        const nextPath = composeRenamedPath(input.fromPath, input.toName);
        const nextRevision = asset.revisionNumber + 1;
        const renamed: StoredAsset = {
          ...asset,
          path: nextPath,
          revision: String(nextRevision),
          revisionNumber: nextRevision,
          updatedAt: Date.now(),
        };
        assets.delete(assetKey(actor, input.fromPath));
        assets.set(assetKey(actor, nextPath), renamed);
        return renamed;
      }

      const currentRevision = revisionFor(revisions, actor, input.fromPath);
      if (String(currentRevision) !== input.expectedRevision) {
        throw new WorkspaceError("conflict", "Expected revision is stale");
      }
      const toPath = composeRenamedPath(input.fromPath, input.toName);
      await asActor(t, actor).mutation(api.atoms.move, {
        fromPath: input.fromPath,
        toPath,
        activeWorkspaceId: actor.workspaceId,
      });
      const nextRevision = currentRevision + 1;
      revisions.delete(revisionKey(actor, input.fromPath));
      revisions.set(revisionKey(actor, toPath), nextRevision);
      const row = await asActor(t, actor).query(api.atoms.getByPath, {
        path: toPath,
        activeWorkspaceId: actor.workspaceId,
      });
      if (!row) throw new WorkspaceError("not_found", "Atom not found");
      return rowToWorkspaceFile(
        actor,
        {
          _id: row._id,
          path: row.path,
          updatedAt: row.updatedAt,
          type: null,
        },
        nextRevision,
      );
    },
    async deleteFile(actor, path) {
      if (assets.delete(assetKey(actor, path))) return;
      await asActor(t, actor).mutation(api.atoms.remove, {
        path,
        activeWorkspaceId: actor.workspaceId,
      });
      revisions.delete(revisionKey(actor, path));
    },
  };
}

function asActor(t: ConvexTestHandle, actor: Actor) {
  return t.withIdentity({ subject: actor.userId });
}

function revisionKey(actor: Actor, path: string) {
  return `${actor.workspaceId}:${path}`;
}

function assetKey(actor: Actor, path: string) {
  return `${actor.workspaceId}:${path}`;
}

function revisionFor(
  revisions: Map<string, number>,
  actor: Actor,
  path: string,
) {
  return revisions.get(revisionKey(actor, path)) ?? 1;
}

function rowToWorkspaceFile(
  actor: Actor,
  row: AtomListRow,
  revision: number,
): WorkspaceFile {
  return {
    id: String(row._id),
    workspaceId: actor.workspaceId,
    path: row.path,
    kind: "atom",
    contentType: contentTypeForPath(row.path, row.type),
    revision: String(revision),
    updatedAt: row.updatedAt,
  };
}

function contentTypeForPath(
  path: string,
  type: AtomListRow["type"] | null,
) {
  if (type === "html" || path.toLowerCase().endsWith(".html")) {
    return "text/html";
  }
  if (path.toLowerCase().endsWith(".csv")) return "text/csv";
  if (path.toLowerCase().endsWith(".json")) return "application/json";
  if (path.toLowerCase().endsWith(".txt")) return "text/plain";
  return "text/markdown";
}
