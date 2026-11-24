import { readFileSync } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { transform } from "esbuild";
import { describeDatasetRevision } from "@dohc/security-contract/dataset-artifacts";
import {
  parseAppDatasetReference,
  parseDatasetDefinition,
  resolveAppDatasetReferenceBinding,
} from "@dohc/security-contract/dataset";
import type { AppBackendJson } from "@dohc/security-contract/app-backend";
import { createDatasetJournal } from "./journal.ts";
import { createDatasetSupervisor } from "./supervisor.ts";
import { createDatasetHost } from "./dataset-host.ts";
import { privateFolder } from "./private-folder.test-helper";

export const accountingFile = (file: string) =>
  readFileSync(new URL(`../../../examples/accounting/${file}`, import.meta.url), "utf8");

export const receiptPdf = {
  fileId: "receipt_pdf_0001",
  name: "receipt.pdf",
  contentType: "application/pdf",
  byteLength: 2048,
  sha256: "b".repeat(64),
};
export const receiptText = {
  fileId: "receipt_txt_0001",
  name: "notes.txt",
  contentType: "text/plain",
  byteLength: 16,
  sha256: "c".repeat(64),
};

export type Caller = "owner" | "accountant" | "stranger";

/**
 * The accounting example on the real dataset host, supervised worker, and isolated runtime.
 * "books" is the owner's app with every operation. "portal" is the accountant's link app.
 */
export async function accountingFixture() {
  const definition = parseDatasetDefinition(JSON.parse(accountingFile("dataset.json")), {
    descriptorPath: "accounting/dataset.json",
  });
  const schemaSql = accountingFile("schema.sql");
  const operationSource = accountingFile("operations.js");
  const revision = describeDatasetRevision({ definition, revision: 1, schemaSql, operationSource });
  const named = (declaration: { dataset: unknown }) => {
    const reference = parseAppDatasetReference(declaration.dataset);
    return resolveAppDatasetReferenceBinding(reference, definition.datasetId, revision);
  };
  const books = named(JSON.parse(accountingFile("app.publish.json")));
  const portal = named(JSON.parse(accountingFile("portal/app.publish.json")));
  const directory = await mkdtemp(join(tmpdir(), "dohc-accounting-"));
  const db = new DatabaseSync(join(directory, "host.sqlite"));
  db.exec(
    "PRAGMA journal_mode=WAL; PRAGMA synchronous=FULL; CREATE TABLE attachments(file_id TEXT PRIMARY KEY);",
  );
  function transaction<T>(run: () => T): T {
    db.exec("BEGIN IMMEDIATE");
    try {
      const result = run();
      db.exec("COMMIT");
      return result;
    } catch (error) {
      db.exec("ROLLBACK");
      throw error;
    }
  }
  const journal = createDatasetJournal({ db, transaction });
  const workers = privateFolder(join(directory, "workers"));
  const supervisor = await createDatasetSupervisor({ journal, directory: workers });
  const host = createDatasetHost<Caller>({
    db,
    transaction,
    journal,
    supervisor,
    resolveAuthority(context, request) {
      if (request.workspaceId !== "workspace") throw new Error("Wrong workspace");
      if (request.access.kind === "app" && !["books", "portal"].includes(request.access.appId))
        throw new Error("Wrong app credential");
      return {
        principalKey: context,
        ...(request.access.kind === "app" ? { appId: request.access.appId } : {}),
        caller:
          context === "owner"
            ? { kind: "owner", userId: "owner" }
            : context === "stranger"
              ? {
                  kind: "named",
                  userId: "stranger",
                  grantId: "folder-view",
                  access: "view",
                  helper: false,
                }
              : { kind: "link", principalId: "accountant", grantId: "accountant-link" },
      };
    },
    compileOperations: async (source) =>
      (await transform(source, { loader: "js", target: "es2022" })).code,
    operationResources: () => ({
      files: [receiptPdf, receiptText],
      accountAndAttach: (candidate) => {
        for (const fileId of candidate.attachedFileIds)
          db.prepare("INSERT OR IGNORE INTO attachments VALUES(?)").run(fileId);
      },
    }),
  });
  const scope = { workspaceId: "workspace", datasetId: definition.datasetId };
  await host.activate("owner", { workspaceId: "workspace", revision, schemaSql, operationSource });
  host.setBinding("owner", { ...scope, appId: "books", binding: books });
  host.setBinding("owner", { ...scope, appId: "portal", binding: portal });
  const operation = (name: string) => {
    const found = definition.operations.find((candidate) => candidate.name === name);
    if (!found) throw new Error(`No operation ${name}`);
    return found;
  };
  let sequence = 0;
  async function call(
    name: string,
    input: AppBackendJson = {},
    caller: Caller = "owner",
    appId: "books" | "portal" | null = caller === "owner" ? null : "portal",
  ) {
    return host.invoke(caller, {
      ...scope,
      revision: 1,
      revisionSha256: revision.revisionSha256,
      operationId: operation(name).operationId,
      input,
      idempotencyKey: `call-${++sequence}`,
      ...(appId ? { access: { kind: "app", appId } as const } : {}),
    });
  }
  async function result<T = any>(
    name: string,
    input: AppBackendJson = {},
    caller: Caller = "owner",
    appId?: "books" | "portal" | null,
  ): Promise<T> {
    return (await call(name, input, caller, appId)).result as T;
  }
  async function close() {
    await supervisor.close();
    db.close();
    await rm(directory, { recursive: true, force: true, maxRetries: 8, retryDelay: 25 });
  }
  return {
    host,
    db,
    scope,
    definition,
    revision,
    books,
    portal,
    directory,
    workers,
    call,
    result,
    close,
  };
}
