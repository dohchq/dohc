import { spawn } from "node:child_process";
import { randomBytes } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { isAbsolute, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { AppBackendRuntimeError, approvedTables, boundedText, runtimeLimits } from "./protocol.js";
import type { AppOperationResult, AppRuntimeChild, AppRuntimeLauncher, ChildReply, ChildRequest, EvaluateAppOperationInput, InitializeAppDatabaseInput, ValidateAppDatabaseInput } from "./protocol.js";
export type { AppOperationResult, AppOperationFile, AppOperationRefusal, AppRuntimeChild, AppRuntimeLaunchOptions, AppRuntimeLauncher, EvaluateAppOperationInput, InitializeAppDatabaseInput, ValidateAppDatabaseInput, JsonValue, RuntimeLimits } from "./protocol.js";
export { AppBackendRuntimeError, isAppBackendRuntimeError } from "./protocol.js";

let active = 0;
const MAX_ACTIVE = 8;

const nodeLauncher: AppRuntimeLauncher = options => {
  if (process.versions.electron) throw new Error("Electron must configure an app runtime utility-process launcher.");
  const child = spawn(process.execPath, ["--disable-warning=ExperimentalWarning", "--max-old-space-size=96", options.entryPath], {
    env: options.env, cwd: options.cwd, stdio: ["ignore", "ignore", "ignore", "ipc"], serialization: "advanced", windowsHide: true,
  });
  child.on("message", options.onMessage);
  child.on("error", options.onError);
  child.on("close", options.onExit);
  return { postMessage(message) { child.send(message as object, error => { if(error) options.onError(error); }); }, kill() { child.kill("SIGKILL"); } };
};

export interface AppBackendRuntimeOptions { launch?: AppRuntimeLauncher; entryPath?: string }

function validateEntryPath(entryPath: string | undefined): void {
  if (entryPath !== undefined && (typeof entryPath !== "string" || !isAbsolute(entryPath) || entryPath.includes("\0"))) {
    throw new Error("The app runtime child path must be absolute.");
  }
}

async function run(request: Omit<ChildRequest, "directory">, signal?: AbortSignal, launch: AppRuntimeLauncher = nodeLauncher, entryPath?: string): Promise<AppOperationResult> {
  validateEntryPath(entryPath);
  if (signal?.aborted) throw new Error("App operation was cancelled.");
  if (active >= MAX_ACTIVE) throw new Error("App runtime is busy. Try again.");
  active += 1;
  let directory: string | undefined;
  try {
    directory = await mkdtemp(join(tmpdir(), "dohc-app-operation-"));
    const cwd = directory;
    const reply = await new Promise<ChildReply>((resolveReply, reject) => {
      let received: ChildReply | undefined;
      let failure: Error | undefined;
      let child: AppRuntimeChild | undefined;
      const abort = () => { failure = new Error("App operation was cancelled."); child?.kill(); };
      const deadline = setTimeout(() => {
        failure = new Error("App operation exceeded its deadline.");
        child?.kill();
      }, request.limits.deadlineMs);
      signal?.addEventListener("abort", abort, {once:true});
      if (signal?.aborted) abort();
      const onError = (error: Error) => { failure ??= error; child?.kill(); };
      const onExit = (code: number | null) => {
        clearTimeout(deadline);
        signal?.removeEventListener("abort",abort);
        if (failure) reject(failure);
        else if (code !== 0 || !received) reject(new Error("App operation process stopped."));
        else resolveReply(received);
      };
      try {
        child = launch({entryPath:entryPath ?? fileURLToPath(import.meta.resolve("@dohc/app-backend-runtime/child")),cwd,env:{},
          onMessage:message=>{ received=message as ChildReply; },onError,onExit});
        if (failure) child.kill();
        else child.postMessage({...request,directory});
      } catch (error) {
        if (child) onError(error instanceof Error ? error : new Error(String(error)));
        else { clearTimeout(deadline);signal?.removeEventListener("abort",abort);reject(error); }
      }
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
        // Windows keeps the utility child cwd handle open briefly after its
        // exit event. Retry the bounded temp cleanup instead of leaking a
        // workspace-owned operation directory on every request.
        await rm(directory, { recursive: true, force: true, maxRetries: 8, retryDelay: 25 });
      }
    } finally { active -= 1; }
  }
}

export async function evaluateAppOperation(input: EvaluateAppOperationInput, options: AppBackendRuntimeOptions = {}): Promise<AppOperationResult> {
  const limits = runtimeLimits(input.limits);
  if (!(input.database instanceof Uint8Array) || input.database.byteLength > limits.databaseBytes || input.database.byteLength < 100) throw new Error("Invalid app database snapshot.");
  if (!/^[A-Za-z][A-Za-z0-9_.-]{0,63}$/.test(input.operation)) throw new Error("Invalid app operation name.");
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
  } as Omit<ChildRequest, "directory">,input.signal,options.launch,options.entryPath);
}

export async function initializeAppDatabase(input: InitializeAppDatabaseInput, options: AppBackendRuntimeOptions = {}): Promise<Uint8Array> {
  const limits = runtimeLimits(input.limits);
  return (await run({ kind: "initialize", journaled:input.journaled===true, tables: approvedTables(input.tables), limits,
    schemaSql: boundedText(input.schemaSql, limits.sourceBytes, "Database schema") } as Omit<ChildRequest, "directory">,input.signal,options.launch,options.entryPath)).database;
}

export async function validateAppDatabase(input: ValidateAppDatabaseInput, options: AppBackendRuntimeOptions = {}): Promise<void> {
  const limits=runtimeLimits(input.limits);
  if (!(input.database instanceof Uint8Array) || input.database.byteLength < 100 || input.database.byteLength > limits.databaseBytes) throw new Error("Invalid app database snapshot.");
  await run({kind:"validate",journaled:input.journaled===true,tables:approvedTables(input.tables),limits,database:input.database,
    schemaSql:boundedText(input.schemaSql,limits.sourceBytes,"Database schema")} as Omit<ChildRequest,"directory">,input.signal,options.launch,options.entryPath);
}

export function createAppBackendRuntime(options: AppBackendRuntimeOptions = {}) {
  validateEntryPath(options.entryPath);
  options = {...options};
  return {
    evaluateAppOperation: (input: EvaluateAppOperationInput) => evaluateAppOperation(input,options),
    initializeAppDatabase: (input: InitializeAppDatabaseInput) => initializeAppDatabase(input,options),
    validateAppDatabase: (input: ValidateAppDatabaseInput) => validateAppDatabase(input,options),
  };
}
