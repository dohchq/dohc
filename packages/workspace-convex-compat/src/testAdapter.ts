/// <reference types="vite/client" />
import { convexTest } from "convex-test";
import type {
  Actor,
  CreateAtomInput,
  SaveAssetInput,
  WorkspaceBackend,
  WorkspaceFile,
  WriteAtomInput,
} from "@dohc/workspace-contracts";
import { WorkspaceError } from "@dohc/workspace-contracts";
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

export const convexTestAdapter = {
  name: "convex",
  async setup() {
    const t = convexTest(schema, modules);
    const revisions = new Map<string, number>();
    const backend = createConvexWorkspaceBackend(t, revisions);

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
): WorkspaceBackend {
  return {
    async listFiles(actor) {
      const rows = await asActor(t, actor).query(api.atoms.list, {
        activeWorkspaceId: actor.workspaceId,
      });
      return (rows as AtomListRow[]).map((row) =>
        rowToWorkspaceFile(actor, row, revisionFor(revisions, actor, row.path)),
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
    async saveAsset(_actor, _input: SaveAssetInput) {
      throw new WorkspaceError(
        "unsupported_media_type",
        "Convex asset contract mapping is implemented in Phase 6",
      );
    },
    async deleteFile(actor, path) {
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
