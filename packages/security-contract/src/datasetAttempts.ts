import { APP_BACKEND_INPUT_BYTES, parseAppBackendJson, type AppBackendJson } from "./appBackend.js";

export interface DatasetPendingAttempt { token: string; idempotencyKey: string; input: AppBackendJson }
export type DatasetAttemptRequest = { action: "get" } | { action: "save"; idempotencyKey: string; input: AppBackendJson } | { action: "clear"; token: string };
export interface DatasetAttemptResult { attempt: DatasetPendingAttempt | null }
const isRecord = (v: unknown): v is Record<string, unknown> => !!v && typeof v === "object" && !Array.isArray(v);
const keyPattern = /^[A-Za-z0-9._:-]{1,128}$/;
const tokenPattern = /^[A-Za-z0-9_-]{43}$/;
export function parseDatasetAttemptRequest(value: unknown): DatasetAttemptRequest {
  if (!isRecord(value)) throw new Error("Invalid pending submission request.");
  const keys = Object.keys(value).sort().join();
  if (value.action === "get" && keys === "action") return { action: "get" };
  if (value.action === "clear" && keys === "action,token" && typeof value.token === "string" && value.token.length === 43 && tokenPattern.test(value.token)) return { action: "clear", token: value.token };
  if (value.action === "save" && keys === "action,idempotencyKey,input" && typeof value.idempotencyKey === "string" && !/[\r\n]/.test(value.idempotencyKey) && keyPattern.test(value.idempotencyKey)) return { action: "save", idempotencyKey: value.idempotencyKey, input: parseAppBackendJson(value.input, APP_BACKEND_INPUT_BYTES) };
  throw new Error("Invalid pending submission request.");
}
export function parseDatasetAttemptResult(value: unknown): DatasetAttemptResult {
  if (!isRecord(value) || Object.keys(value).join() !== "attempt") throw new Error("Invalid pending submission result.");
  if (value.attempt === null) return { attempt: null };
  const row = value.attempt;
  if (!isRecord(row) || Object.keys(row).sort().join() !== "idempotencyKey,input,token" || typeof row.token !== "string" || (row.token.length !== 43 || !tokenPattern.test(row.token))) throw new Error("Invalid pending submission result.");
  const input = parseDatasetAttemptRequest({ action: "save", idempotencyKey: row.idempotencyKey, input: row.input });
  if (input.action !== "save") throw new Error("Invalid pending submission result.");
  return { attempt: { token: row.token, idempotencyKey: input.idempotencyKey, input: input.input } };
}
