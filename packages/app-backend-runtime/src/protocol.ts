export type JsonValue = null | boolean | number | string | JsonValue[] | { [key: string]: JsonValue };

export interface RuntimeLimits {
  sourceBytes: number;
  inputBytes: number;
  databaseBytes: number;
  resultBytes: number;
  queryBytes: number;
  queryRows: number;
  statements: number;
  memoryBytes: number;
  stackBytes: number;
  evaluationMs: number;
  deadlineMs: number;
}

export const DEFAULT_LIMITS: Readonly<RuntimeLimits> = Object.freeze({
  sourceBytes: 256 * 1024,
  inputBytes: 64 * 1024,
  databaseBytes: 16 * 1024 * 1024,
  resultBytes: 256 * 1024,
  queryBytes: 256 * 1024,
  queryRows: 1000,
  statements: 128,
  memoryBytes: 16 * 1024 * 1024,
  stackBytes: 256 * 1024,
  evaluationMs: 1000,
  deadlineMs: 8000,
});

export interface EvaluateAppOperationInput {
  source: string;
  operation: string;
  caller: JsonValue;
  input: JsonValue;
  nowMs: number;
  requestId: string;
  secret?: string;
  database: Uint8Array;
  tables: string[];
  readOnly?: boolean;
  files?: AppOperationFile[];
  limits?: Partial<RuntimeLimits>;
  signal?: AbortSignal;
}

export interface AppOperationFile {
  fileId: string;
  name: string;
  contentType: string;
  byteLength: number;
  sha256: string;
}

export interface AppOperationRefusal { code: string; message: string }

export class AppBackendRuntimeError extends Error {
  readonly code = "operation_refused";
  readonly refusal: AppOperationRefusal;
  constructor(refusal: AppOperationRefusal) {
    super(refusal.message);
    this.refusal = refusal;
    this.name = "AppBackendRuntimeError";
  }
}

export interface InitializeAppDatabaseInput {
  schemaSql: string;
  tables: string[];
  limits?: Partial<RuntimeLimits>;
  signal?: AbortSignal;
}

export interface ValidateAppDatabaseInput extends InitializeAppDatabaseInput {
  database: Uint8Array;
}

export interface AppRuntimeLaunchOptions {
  entryPath: string;
  cwd: string;
  env: Record<string, string>;
  onMessage(message: unknown): void;
  onError(error: Error): void;
  onExit(code: number | null): void;
}
export interface AppRuntimeChild {
  postMessage(message: unknown): void;
  kill(): void;
}
export type AppRuntimeLauncher = (options: AppRuntimeLaunchOptions) => AppRuntimeChild;

export interface AppOperationResult {
  result: JsonValue;
  database: Uint8Array;
  changed: boolean;
  changeset: Uint8Array;
  attachedFileIds: string[];
}

export type ChildRequest = {
  directory: string;
  limits: RuntimeLimits;
  tables: string[];
} & ({ kind: "initialize"; schemaSql: string } | {kind:"validate"; schemaSql:string; database:Uint8Array} | {
  kind: "evaluate";
  source: string;
  operation: string;
  callerJson: string;
  inputJson: string;
  nowMs: number;
  requestId: string;
  secret: string;
  database: Uint8Array;
  readOnly: boolean;
  files: AppOperationFile[];
});

export type ChildReply = { ok: true; resultJson: string; database: Uint8Array; changed: boolean; changeset: Uint8Array; attachedFileIds: string[] }
  | { ok: false; error: string; refusal?: AppOperationRefusal };

export function runtimeLimits(input: Partial<RuntimeLimits> = {}): RuntimeLimits {
  const limits = { ...DEFAULT_LIMITS };
  for (const [key, value] of Object.entries(input)) {
    if (!(key in limits) || !Number.isSafeInteger(value) || value! < 1 || value! > DEFAULT_LIMITS[key as keyof RuntimeLimits]) {
      throw new Error("Invalid app runtime limit.");
    }
    limits[key as keyof RuntimeLimits] = value!;
  }
  return limits;
}

export function boundedText(value: string, maxBytes: number, label: string): string {
  if (typeof value !== "string" || Buffer.byteLength(value) > maxBytes) throw new Error(`${label} exceeds the app runtime limit.`);
  return value;
}

export function approvedTables(tables: string[]): string[] {
  if (!Array.isArray(tables) || tables.length < 1 || tables.length > 64 ||
    tables.some(table => typeof table !== "string" || !/^[A-Za-z_][A-Za-z0-9_]{0,63}$/.test(table) || /^(sqlite|dohc)_/i.test(table)) ||
    new Set(tables.map(table => table.toLowerCase())).size !== tables.length) throw new Error("Invalid approved app tables.");
  return [...tables];
}
