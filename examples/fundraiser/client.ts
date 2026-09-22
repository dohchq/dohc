import type {
  AttendeePage, AttendeesInput, FileReply, InvokeReply, ListRegistrationsInput, ManualEntryInput, PaymentTotal, PublicSession,
  RegisterInput, RegisterResult, RegistrationPage, RegistrationSummary, SetPlayerReclubInput, SetStatusInput, StatusResult, UploadReply,
} from "./ui-types.ts";

export type BackendStatus = 400 | 404 | 409 | 413 | 429 | 503;
const STATUSES: readonly number[] = [400, 404, 409, 413, 429, 503];

export class BackendError extends Error {
  constructor(readonly status: BackendStatus, readonly refusal?: {code: string; message: string}) {
    super(refusal?.message ?? `Backend request refused (${status}).`);
    this.name = "BackendError";
  }
  /** The host may still have applied the request. Retry with the same key; never mint a new one. */
  get uncertain(): boolean { return this.status === 429 || this.status === 503; }
}
export const backendStatus = (error: unknown): BackendStatus | null => error instanceof BackendError ? error.status : null;

/** Optional embedding hooks. Durable retries use the trusted host's browser participant scope. */
export interface AppContext {
  /** A private status token the host already knows, for example from a status link. */
  readonly initialStatusToken?: string;
  /** Called after a registration is saved so the host can keep the private token. */
  rememberStatusToken?(token: string): void;
  /** A retained attempt to resume, for example from a recovery file. The form restores its draft, stays frozen, and offers Retry. */
  readonly pendingAttempt?: RegistrationAttempt;
  /** Called with the attempt when its outcome becomes unknown, and with null once it settles or is discarded. */
  pendingAttemptChanged?(attempt: RegistrationAttempt | null): void;
}
export const defaultAppContext: AppContext = {};

export interface ReceiptUpload { name: string; contentType: string; bytesBase64: string }
export interface BackendPort {
  invoke<T>(operation: string, input: unknown, idempotencyKey: string): Promise<InvokeReply<T>>;
  upload(receipt: ReceiptUpload, idempotencyKey: string): Promise<UploadReply>;
  file(fileId: string, operation: string, input: unknown): Promise<FileReply>;
  attempt(request: RegistrationAttemptRequest): Promise<RegistrationAttemptResult>;
  close(): void;
}

const INVOKE_TIMEOUT_MS = 30_000, TRANSFER_TIMEOUT_MS = 90_000, MAX_IN_FLIGHT = 3;
const record = (value: unknown): value is Record<string, unknown> => !!value && typeof value === "object" && !Array.isArray(value);
const isFile = (value: unknown): boolean => record(value) && typeof value.fileId === "string" && typeof value.name === "string" &&
  typeof value.contentType === "string" && typeof value.byteLength === "number" && typeof value.sha256 === "string";

type Pending = { message: Record<string, unknown>; timeoutMs: number; check(value: unknown): boolean; resolve(value: unknown): void; reject(error: Error): void; timer?: ReturnType<typeof setTimeout> };

/** Accepts the parent's channel once, queues requests until it arrives, and keeps the broker's in-flight limit. */
export function connectBackend(): BackendPort {
  let port: MessagePort | undefined, closed = false, inFlight = 0;
  const waiting: Pending[] = [], sent = new Map<string, Pending>();
  const fail = (item: Pending, status: BackendStatus) => { clearTimeout(item.timer); item.reject(new BackendError(status)); };
  const pump = () => {
    while (port && !closed && inFlight < MAX_IN_FLIGHT && waiting.length) {
      const item = waiting.shift()!, id = item.message.id as string;
      clearTimeout(item.timer);
      inFlight++;
      sent.set(id, item);
      item.timer = setTimeout(() => { if (sent.delete(id)) { inFlight--; fail(item, 503); pump(); } }, item.timeoutMs);
      try { port.postMessage(item.message); }
      catch { sent.delete(id); inFlight--; fail(item, 503); }
    }
  };
  const receiveChannel = (event: MessageEvent) => {
    if (closed || port || event.source !== window.parent || event.source === window) return;
    if (!record(event.data) || event.data.kind !== "dohc-app-channel" || event.data.version !== 1 || event.ports.length !== 1) return;
    window.removeEventListener("message", receiveChannel);
    port = event.ports[0]!;
    port.onmessage = ({ data }: MessageEvent) => {
      if (!record(data) || typeof data.id !== "string") return;
      const item = sent.get(data.id);
      if (!item) return;
      sent.delete(data.id); inFlight--; clearTimeout(item.timer);
      if (data.ok === true && item.check(data.value)) item.resolve(data.value);
      else {
        const status = data.ok !== true && STATUSES.includes(data.status as number) ? data.status as BackendStatus : 503;
        const error = data.error;
        const refusal = status === 409 && record(error) && Object.keys(error).sort().join() === "code,message" &&
          typeof error.code === "string" && /^[a-z][a-z0-9_]{0,63}$/.test(error.code) &&
          typeof error.message === "string" && error.message.length > 0 && new TextEncoder().encode(error.message).byteLength <= 1024 && !/[\u0000-\u001f\u007f]/.test(error.message)
          ? {code: error.code, message: error.message} : undefined;
        item.reject(new BackendError(status, refusal));
      }
      pump();
    };
    port.start();
    pump();
  };
  window.addEventListener("message", receiveChannel);
  const request = (message: Record<string, unknown>, timeoutMs: number, check: (value: unknown) => boolean): Promise<unknown> =>
    new Promise((resolve, reject) => {
      if (closed) { reject(new BackendError(503)); return; }
      const item: Pending = { message: { id: crypto.randomUUID(), ...message }, timeoutMs, check, resolve, reject };
      item.timer = setTimeout(() => {
        const index = waiting.indexOf(item);
        if (index >= 0) { waiting.splice(index, 1); fail(item, 503); }
      }, timeoutMs);
      waiting.push(item);
      pump();
    });
  return {
    invoke: <T>(operation: string, input: unknown, idempotencyKey: string) => request({ op: "backend.invoke", operation, idempotencyKey, input }, INVOKE_TIMEOUT_MS,
      value => record(value) && "result" in value && typeof value.revision === "number" && typeof value.replayed === "boolean") as Promise<InvokeReply<T>>,
    upload: (receipt, idempotencyKey) => request({ op: "backend.upload", idempotencyKey, ...receipt }, TRANSFER_TIMEOUT_MS,
      value => record(value) && isFile(value.file) && typeof value.replayed === "boolean") as Promise<UploadReply>,
    file: (fileId, operation, input) => request({ op: "backend.file", fileId, operation, input }, TRANSFER_TIMEOUT_MS,
      value => record(value) && isFile(value.file) && typeof value.bytesBase64 === "string") as Promise<FileReply>,
    attempt: input => request({ op: "backend.attempt", operation: "register", request: input }, INVOKE_TIMEOUT_MS,
      validRegistrationAttemptResult) as Promise<RegistrationAttemptResult>,
    close() {
      closed = true;
      window.removeEventListener("message", receiveChannel);
      port?.close();
      for (const item of [...sent.values(), ...waiting]) fail(item, 503);
      sent.clear(); waiting.length = 0;
    },
  };
}

export interface FundraiserClient {
  registrationAttempt(request: RegistrationAttemptRequest): Promise<RegistrationAttemptResult>;
  listPublicSessions(): Promise<PublicSession[]>;
  uploadReceipt(receipt: ReceiptUpload, idempotencyKey: string): Promise<UploadReply>;
  register(input: RegisterInput, idempotencyKey: string): Promise<InvokeReply<RegisterResult>>;
  lookupStatus(token: string): Promise<StatusResult>;
  listRegistrations(input: ListRegistrationsInput): Promise<RegistrationPage>;
  setStatus(input: SetStatusInput, idempotencyKey: string): Promise<RegistrationSummary>;
  manualEntry(input: ManualEntryInput, idempotencyKey: string): Promise<InvokeReply<RegistrationSummary>>;
  attendees(input: AttendeesInput): Promise<AttendeePage>;
  setPlayerReclub(input: SetPlayerReclubInput, idempotencyKey: string): Promise<SetPlayerReclubInput>;
  totals(): Promise<PaymentTotal[]>;
  receipt(registrationId: string): Promise<FileReply>;
  close(): void;
}

/** Reads use a fresh key per call. Mutations receive the key their caller retains across retries. */
export function createFundraiserClient(port: BackendPort = connectBackend()): FundraiserClient {
  const read = async <T>(operation: string, input: unknown): Promise<T> => (await port.invoke<T>(operation, input, `read:${crypto.randomUUID()}`)).result;
  return {
    registrationAttempt: request => port.attempt(request),
    listPublicSessions: () => read("listPublicSessions", {}),
    uploadReceipt: (receipt, key) => port.upload(receipt, key),
    register: (input, key) => port.invoke<RegisterResult>("register", input, key),
    lookupStatus: token => read("lookupStatus", { token }),
    listRegistrations: input => read("listRegistrations", input),
    setStatus: async (input, key) => (await port.invoke<RegistrationSummary>("setStatus", input, key)).result,
    manualEntry: (input, key) => port.invoke<RegistrationSummary>("manualEntry", input, key),
    attendees: input => read("attendees", input),
    setPlayerReclub: async (input, key) => (await port.invoke<SetPlayerReclubInput>("setPlayerReclub", input, key)).result,
    totals: () => read("totals", {}),
    receipt: async id => port.file((await read<{ fileId: string }>("receiptAccess", { id })).fileId, "receiptAccess", { id }),
    close: () => port.close(),
  };
}

export const mutationKey = (kind: string): string => `${kind}:${crypto.randomUUID()}`;

/** Everything a retry needs after an uncertain outcome. Keys and payload never change once created. */
export interface RegistrationAttempt {
  readonly registerKey: string;
  readonly uploadKey: string;
  readonly input: Omit<RegisterInput, "receiptFileId">;
  readonly receipt: ReceiptUpload;
  /** Set once the host confirms the upload, so a retry does not upload twice. */
  fileId: string | null;
}
export interface RetainedRegistrationAttempt { token: string; idempotencyKey: string; input: RegisterInput }
export type RegistrationAttemptRequest = { action: "get" } | { action: "save"; idempotencyKey: string; input: RegisterInput } | { action: "clear"; token: string };
export interface RegistrationAttemptResult { attempt: RetainedRegistrationAttempt | null }
export type RegistrationRetry = RegistrationAttempt | (Omit<RegistrationAttempt, "receipt"> & { receipt: null });
function validRegistrationAttemptResult(value: unknown): boolean {
  if (!record(value) || Object.keys(value).join() !== "attempt") return false;
  if (value.attempt === null) return true;
  const row = value.attempt;
  if (!record(row) || Object.keys(row).sort().join() !== "idempotencyKey,input,token" || typeof row.token !== "string" || row.token.length !== 43 || !/^[A-Za-z0-9_-]{43}$/.test(row.token) || typeof row.idempotencyKey !== "string" || !/^[A-Za-z0-9._:-]{1,128}$/.test(row.idempotencyKey) || !record(row.input)) return false;
  const input = row.input;
  return Object.keys(input).sort().join() === "fullName,mobile,paymentMethod,receiptFileId,receiptSha256,retrySecret,sessions,submissionId" &&
    typeof input.fullName === "string" && input.fullName.length <= 150 && typeof input.mobile === "string" && input.mobile.length <= 24 &&
    typeof input.receiptFileId === "string" && /^[A-Za-z0-9_-]{16,128}$/.test(input.receiptFileId) &&
    typeof input.submissionId === "string" && /^[a-f0-9-]{36}$/.test(input.submissionId) && typeof input.retrySecret === "string" && /^[A-Za-z0-9_-]{43}$/.test(input.retrySecret) &&
    typeof input.receiptSha256 === "string" && /^[a-f0-9]{64}$/.test(input.receiptSha256) && ["gcash", "bdo", "unionbank", "bpi"].includes(String(input.paymentMethod)) &&
    Array.isArray(input.sessions) && input.sessions.length > 0 && input.sessions.length <= 2 && input.sessions.every(session => record(session) &&
      Object.keys(session).sort().join() === "players,sessionId,spectators" && ["s1", "s2"].includes(String(session.sessionId)) &&
      Array.isArray(session.players) && session.players.length <= 36 && Array.isArray(session.spectators) && session.spectators.length <= 100 &&
      [...session.players, ...session.spectators].every(name => typeof name === "string" && name.length <= 150));
}
export function restoreRegistrationAttempt(saved: RetainedRegistrationAttempt): RegistrationRetry {
  const { receiptFileId, ...input } = saved.input;
  return { registerKey: saved.idempotencyKey, uploadKey: "", input, fileId: receiptFileId, receipt: null };
}
/** A new draft gets fresh staging. Only uncertain attempts retain their original request identity. */
export type RegistrationDraft = Omit<RegisterInput, "receiptFileId" | "submissionId" | "retrySecret" | "receiptSha256">;
export async function createRegistrationAttempt(input: RegistrationDraft, receipt: ReceiptUpload): Promise<RegistrationAttempt> {
  const hash = await crypto.subtle.digest("SHA-256", decodeBase64(receipt.bytesBase64));
  const receiptSha256 = [...new Uint8Array(hash)].map(byte => byte.toString(16).padStart(2, "0")).join("");
  const retrySecret = encodeBase64(crypto.getRandomValues(new Uint8Array(32))).replaceAll("+", "-").replaceAll("/", "_").replace(/=+$/, "");
  return { registerKey: mutationKey("register"), uploadKey: mutationKey("upload"),
    input: {...input, submissionId: crypto.randomUUID(), retrySecret, receiptSha256}, receipt, fileId: null };
}
export async function submitRegistration(client: FundraiserClient, attempt: RegistrationRetry): Promise<InvokeReply<RegisterResult>> {
  if (attempt.fileId === null) {
    if (!attempt.receipt) throw new BackendError(503);
    attempt.fileId = (await client.uploadReceipt(attempt.receipt, attempt.uploadKey)).file.fileId;
  }
  return client.register({ ...attempt.input, receiptFileId: attempt.fileId }, attempt.registerKey);
}

export const RECEIPT_TYPES: readonly string[] = ["image/jpeg", "image/png", "application/pdf"];
export const RECEIPT_MAX_BYTES = 5 * 1024 * 1024;

export function encodeBase64(bytes: Uint8Array): string {
  let binary = "";
  for (let start = 0; start < bytes.length; start += 0x8000) binary += String.fromCharCode(...bytes.subarray(start, start + 0x8000));
  return btoa(binary);
}
export function decodeBase64(text: string) {
  const binary = atob(text), bytes = new Uint8Array(binary.length);
  for (let index = 0; index < binary.length; index++) bytes[index] = binary.charCodeAt(index);
  return bytes;
}
/** Names travel to the host as metadata. Keep them to one path segment without control characters. */
export function safeFileName(name: string, contentType: string): string {
  const cleaned = name.replace(/[\\/\u0000-\u001f\u007f]/g, "_").trim().slice(0, 120);
  if (cleaned && cleaned !== "." && cleaned !== "..") return cleaned;
  return contentType === "application/pdf" ? "receipt.pdf" : contentType === "image/png" ? "receipt.png" : "receipt.jpg";
}
export async function receiptUploadFromFile(file: File): Promise<ReceiptUpload> {
  return { name: safeFileName(file.name, file.type), contentType: file.type, bytesBase64: encodeBase64(new Uint8Array(await file.arrayBuffer())) };
}
