import { spawn } from "node:child_process";
import { randomBytes } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { AppBackendRuntimeError, approvedTables, boundedText, runtimeLimits } from "./protocol.ts";
import type { AppOperationResult, ChildReply, ChildRequest, EvaluateAppOperationInput, InitializeAppDatabaseInput } from "./protocol.ts";
export type { AppOperationResult, AppOperationFile, AppOperationRefusal, EvaluateAppOperationInput, InitializeAppDatabaseInput, JsonValue, RuntimeLimits } from "./protocol.ts";
export { AppBackendRuntimeError } from "./protocol.ts";

let active = 0;
const MAX_ACTIVE = 8;

async function run(request: Omit<ChildRequest, "directory">, signal?: AbortSignal): Promise<AppOperationResult> {
  if (signal?.aborted) throw new Error("App operation was cancelled.");
  if (active >= MAX_ACTIVE) throw new Error("App runtime is busy. Try again.");
  active += 1;
  let directory: string | undefined;
  try {
    directory = await mkdtemp(join(tmpdir(), "dohc-app-operation-"));
    const child = spawn(process.execPath, ["--disable-warning=ExperimentalWarning", "--max-old-space-size=96", fileURLToPath(import.meta.resolve("@dohc/app-backend-runtime/child"))], {
      env: {},
      cwd: directory,
      stdio: ["ignore", "ignore", "ignore", "ipc"],
      serialization: "advanced",
      windowsHide: true,
    });
    const reply = await new Promise<ChildReply>((resolveReply, reject) => {
      let received: ChildReply | undefined;
      let failure: Error | undefined;
      const abort = () => { failure = new Error("App operation was cancelled."); child.kill("SIGKILL"); };
      const deadline = setTimeout(() => {
        failure = new Error("App operation exceeded its deadline.");
        child.kill("SIGKILL");
      }, request.limits.deadlineMs);
      signal?.addEventListener("abort", abort, {once:true});
      if (signal?.aborted) abort();
      child.once("message", message => { received = message as ChildReply; });
      child.once("error", error => { failure ??= error; child.kill(); });
      child.once("close", code => {
        clearTimeout(deadline);
        signal?.removeEventListener("abort",abort);
        if (failure) reject(failure);
        else if (code !== 0 || !received) reject(new Error("App operation process stopped."));
        else resolveReply(received);
      });
      child.send({ ...request, directory }, error => {
        if (error) { failure ??= error; child.kill(); }
      });
    });
    if (!reply.ok) {
      if (reply.refusal) throw new AppBackendRuntimeError(reply.refusal);
      throw new Error(reply.error);
    }
    if (!(reply.database instanceof Uint8Array) || reply.database.byteLength > request.limits.databaseBytes) throw new Error("Invalid app database result.");
    boundedText(reply.resultJson, request.limits.resultBytes, "Operation result");
    if (!(reply.changeset instanceof Uint8Array) || reply.changeset.byteLength > request.limits.databaseBytes) throw new Error("Invalid app changeset result.");
    return { result: JSON.parse(reply.resultJson), database: reply.database, changeset: reply.changeset, changed: reply.changed, attachedFileIds: reply.attachedFileIds };
  } finally {
    try {
      if (directory) {
        const expectedParent = resolve(tmpdir());
        if (!resolve(directory).startsWith(`${expectedParent}${process.platform === "win32" ? "\\" : "/"}dohc-app-operation-`)) throw new Error("Invalid app temporary directory.");
        await rm(directory, { recursive: true, force: true });
      }
    } finally { active -= 1; }
  }
}

export async function evaluateAppOperation(input: EvaluateAppOperationInput): Promise<AppOperationResult> {
  const limits = runtimeLimits(input.limits);
  if (!(input.database instanceof Uint8Array) || input.database.byteLength > limits.databaseBytes || input.database.byteLength < 100) throw new Error("Invalid app database snapshot.");
  if (!/^[A-Za-z][A-Za-z0-9_]{0,63}$/.test(input.operation)) throw new Error("Invalid app operation name.");
  if (!Number.isSafeInteger(input.nowMs) || input.nowMs < 0 || !/^[A-Za-z0-9._:-]{1,128}$/.test(input.requestId)) throw new Error("Invalid app operation context.");
  const secret = input.secret ?? randomBytes(32).toString("base64url");
  if (!/^[A-Za-z0-9_-]{43}$/.test(secret)) throw new Error("Invalid app operation secret.");
  const files = input.files ?? [];
  if (!Array.isArray(files) || files.length > 32 || files.some(file =>
    !/^[A-Za-z0-9._:-]{1,128}$/.test(file.fileId) || typeof file.name !== "string" || Buffer.byteLength(file.name) > 512 ||
    typeof file.contentType !== "string" || Buffer.byteLength(file.contentType) > 128 || !/^[a-f0-9]{64}$/.test(file.sha256) ||
    !Number.isSafeInteger(file.byteLength) || file.byteLength < 0) || new Set(files.map(file => file.fileId)).size !== files.length) throw new Error("Invalid app files.");
  return run({
    kind: "evaluate", tables: approvedTables(input.tables), limits,
    source: boundedText(input.source, limits.sourceBytes, "Operation source"),
    operation: input.operation,
    callerJson: boundedText(JSON.stringify(input.caller), limits.inputBytes, "Caller"),
    inputJson: boundedText(JSON.stringify(input.input), limits.inputBytes, "Operation input"),
    nowMs: input.nowMs, requestId: input.requestId, database: input.database, readOnly: input.readOnly === true,
    files: files.map(({fileId,name,contentType,byteLength,sha256})=>({fileId,name,contentType,byteLength,sha256})), secret,
  } as Omit<ChildRequest, "directory">,input.signal);
}

export async function initializeAppDatabase(input: InitializeAppDatabaseInput): Promise<Uint8Array> {
  const limits = runtimeLimits(input.limits);
  return (await run({ kind: "initialize", tables: approvedTables(input.tables), limits,
    schemaSql: boundedText(input.schemaSql, limits.sourceBytes, "Database schema") } as Omit<ChildRequest, "directory">,input.signal)).database;
}
