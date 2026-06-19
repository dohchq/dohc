import { describe, expect, it } from "vitest";
import type {
  Actor,
  SaveAssetInput,
  WorkspaceBackend,
  WorkspaceFile,
} from "@dohc/workspace-contracts";
import type { ImportDataRequest } from "@dohc/workspace-contracts";
import { importData } from "./dataImport";

const actor: Actor = { userId: "user_1", workspaceId: "ws_1" };

function workspaceFile(path: string, kind: WorkspaceFile["kind"]): WorkspaceFile {
  return {
    id: `${kind}_${path}`,
    workspaceId: actor.workspaceId,
    path,
    kind,
    contentType: kind === "asset" ? "application/octet-stream" : "text/plain",
    revision: "1",
    updatedAt: 1,
  };
}

function fakeBackend() {
  const atoms = new Map<string, string>();
  const assets = new Map<string, { mediaType: string; bytes: Uint8Array }>();
  const createdAtoms: Array<{ path: string; body: string; contentType: string }> = [];
  const savedAssets: SaveAssetInput[] = [];

  const backend: WorkspaceBackend = {
    async listFiles() {
      return [
        ...Array.from(atoms.keys()).map((path) => workspaceFile(path, "atom")),
        ...Array.from(assets.keys()).map((path) => workspaceFile(path, "asset")),
      ];
    },
    async readText(_actor, path) {
      const body = atoms.get(path);
      if (body === undefined) throw new Error(`missing atom ${path}`);
      return { body, revision: "1" };
    },
    async readAsset(_actor, path) {
      const asset = assets.get(path);
      if (!asset) throw new Error(`missing asset ${path}`);
      return {
        mediaType: asset.mediaType,
        kind: "csv",
        bytes: asset.bytes,
        revision: "1",
      };
    },
    async createAtom(_actor, input) {
      createdAtoms.push({
        path: input.path,
        body: input.body,
        contentType: input.kind,
      });
      atoms.set(input.path, input.body);
      return workspaceFile(input.path, "atom");
    },
    async writeAtom() {
      throw new Error("not used");
    },
    async saveAsset(_actor, input) {
      savedAssets.push(input);
      assets.set(input.path, { mediaType: input.mediaType, bytes: input.bytes });
      return workspaceFile(input.path, "asset");
    },
    async updateAsset() {
      throw new Error("not used");
    },
    async renameFile() {
      throw new Error("not used");
    },
    async deleteFile() {
      throw new Error("not used");
    },
  };

  return {
    backend,
    atoms,
    assets,
    createdAtoms,
    savedAssets,
  };
}

describe("Postgres data import service", () => {
  it("saves generated CSV, TXT, and JSON files as text atoms", async () => {
    const fixture = fakeBackend();

    for (const request of [
      {
        source: {
          kind: "inline",
          name: "generated.csv",
          mediaType: "text/csv",
          body: "id,name\n1,Ice",
        },
        target: {
          kind: "atom",
          path: "generated/report.csv",
          contentType: "text/csv",
        },
        mode: "infer-schema",
      },
      {
        source: {
          kind: "inline",
          name: "notes.txt",
          mediaType: "text/plain",
          body: "plain text",
        },
        target: {
          kind: "atom",
          path: "generated/notes.txt",
          contentType: "text/plain",
        },
        mode: "infer-schema",
      },
      {
        source: {
          kind: "inline",
          name: "rows.json",
          mediaType: "application/json",
          body: JSON.stringify([{ id: "row_1" }]),
        },
        target: {
          kind: "atom",
          path: "generated/rows.json",
          contentType: "application/json",
        },
        mode: "infer-schema",
      },
    ] satisfies ImportDataRequest[]) {
      await expect(
        importData({ backend: fixture.backend, actor, request }),
      ).resolves.toMatchObject({
        ok: true,
        target: request.target,
        sourceHash: expect.any(String),
      });
    }

    expect(fixture.createdAtoms).toEqual([
      {
        path: "generated/report.csv",
        body: "id,name\n1,Ice",
        contentType: "csv",
      },
      {
        path: "generated/notes.txt",
        body: "plain text",
        contentType: "text",
      },
      {
        path: "generated/rows.json",
        body: JSON.stringify([{ id: "row_1" }]),
        contentType: "json",
      },
    ]);
    expect(fixture.savedAssets).toEqual([]);
  });

  it("imports uploaded CSV into a materialized SQLite asset", async () => {
    const fixture = fakeBackend();
    const csv = "id,merchant,amount\ntx_1,Grab,420";
    fixture.assets.set("uploads/transactions.csv", {
      mediaType: "text/csv",
      bytes: new TextEncoder().encode(csv),
    });

    const request: ImportDataRequest = {
      source: { kind: "asset", path: "uploads/transactions.csv" },
      target: {
        kind: "sqlite",
        path: "finance/ledger.sqlite",
        tableName: "transactions",
      },
      mode: "infer-schema",
    };

    const result = await importData({
      backend: fixture.backend,
      actor,
      request,
      sqlite: {
        importData: async (input) => ({
          ok: true as const,
          tableName: input.tableName,
          rowCount: 1,
          sourceHash: "source-hash",
          tableSchema: [{ name: "id", type: "TEXT", primaryKey: true }],
          snapshot: {
            transactions: {
              columns: [{ name: "id", type: "TEXT", primaryKey: true }],
              rows: [{ id: "tx_1", merchant: "Grab", amount: 420 }],
            },
          },
          operation: {
            op: "import_data",
            table: "transactions",
            rowCount: 1,
            sourceHash: "source-hash",
          },
          bytesBase64: Buffer.from("SQLite format 3\0fake").toString("base64"),
          size: 20,
          sha256: "sqlite-hash",
        }),
      },
    });

    expect(result).toMatchObject({
      ok: true,
      target: request.target,
      rowCount: 1,
      sourceHash: "source-hash",
      operation: {
        op: "import_data",
        table: "transactions",
        rowCount: 1,
      },
    });
    expect(fixture.savedAssets).toEqual([
      expect.objectContaining({
        path: "finance/ledger.sqlite",
        kind: "sqlite",
        mediaType: "application/vnd.sqlite3",
        bytes: expect.any(Uint8Array),
      }),
    ]);
  });

  it("returns import errors for unsupported or undecodable asset sources", async () => {
    const fixture = fakeBackend();
    fixture.assets.set("uploads/receipt.pdf", {
      mediaType: "application/pdf",
      bytes: new TextEncoder().encode("%PDF"),
    });
    fixture.assets.set("uploads/bad.csv", {
      mediaType: "text/csv",
      bytes: new Uint8Array([0xff, 0xfe, 0xfd]),
    });

    const baseRequest = {
      target: {
        kind: "sqlite",
        path: "finance/ledger.sqlite",
        tableName: "transactions",
      },
      mode: "infer-schema",
    } satisfies Omit<ImportDataRequest, "source">;

    await expect(
      importData({
        backend: fixture.backend,
        actor,
        request: {
          ...baseRequest,
          source: { kind: "asset", path: "uploads/receipt.pdf" },
        },
        sqlite: {
          importData: async () => {
            throw new Error("should not import binary source");
          },
        },
      }),
    ).resolves.toMatchObject({
      ok: false,
      code: "unsupported_media_type",
    });

    await expect(
      importData({
        backend: fixture.backend,
        actor,
        request: {
          ...baseRequest,
          source: { kind: "asset", path: "uploads/bad.csv" },
        },
        sqlite: {
          importData: async () => {
            throw new Error("should not import undecodable source");
          },
        },
      }),
    ).resolves.toMatchObject({
      ok: false,
      code: "invalid_text_encoding",
    });
  });
});
