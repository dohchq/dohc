import { RECEIPT_MAX_BYTES, RECEIPT_TYPES, decodeBase64, mutationKey, type RegistrationAttempt } from "./client.ts";

const MAX_RECOVERY_BYTES = 8 * 1024 * 1024;
const record = (value: unknown): value is Record<string, unknown> => !!value && typeof value === "object" && !Array.isArray(value);
const exact = (value: Record<string, unknown>, keys: string) => Object.keys(value).sort().join() === keys;
const text = (value: unknown, max: number): value is string => typeof value === "string" && value.length > 0 && value.length <= max;
const key = (value: unknown): value is string => text(value, 128) && /^[A-Za-z0-9._:-]+$/.test(value);

/** Recovery retains the original principal's request, not permission to impersonate that principal. */
export function recoveryText(attempt: RegistrationAttempt): string {
  return JSON.stringify({version: 1, kind: "dohc-fundraiser-retry", attempt});
}

export function parseRecovery(raw: string): RegistrationAttempt {
  if (new TextEncoder().encode(raw).byteLength > MAX_RECOVERY_BYTES) throw new Error("This recovery file is too large.");
  let value: unknown;
  try { value = JSON.parse(raw); } catch { throw new Error("Choose a fundraiser recovery JSON file."); }
  const invalid = () => { throw new Error("This recovery file is invalid. Choose the original downloaded file."); };
  if (!record(value) || !exact(value, "attempt,kind,version") || value.version !== 1 || value.kind !== "dohc-fundraiser-retry" || !record(value.attempt)) return invalid();
  const attempt = value.attempt;
  if (!exact(attempt, "fileId,input,receipt,registerKey,uploadKey") || !key(attempt.registerKey) || !key(attempt.uploadKey) ||
      !(attempt.fileId === null || text(attempt.fileId, 128)) || !record(attempt.input) || !record(attempt.receipt)) return invalid();
  const input = attempt.input, receipt = attempt.receipt;
  if (!exact(input, "fullName,mobile,paymentMethod,receiptSha256,retrySecret,sessions,submissionId") || !text(input.fullName, 150) || !text(input.mobile, 24) ||
      !text(input.submissionId, 36) || !/^[a-f0-9-]{36}$/.test(input.submissionId) ||
      !text(input.retrySecret, 43) || !/^[A-Za-z0-9_-]{43}$/.test(input.retrySecret) ||
      !text(input.receiptSha256, 64) || !/^[a-f0-9]{64}$/.test(input.receiptSha256) ||
      !["gcash", "bdo", "unionbank", "bpi"].includes(String(input.paymentMethod)) || !Array.isArray(input.sessions) ||
      input.sessions.length < 1 || input.sessions.length > 2) return invalid();
  const sessions = new Set<string>();
  for (const row of input.sessions) {
    if (!record(row) || !exact(row, "players,sessionId,spectators") || !["s1", "s2"].includes(String(row.sessionId)) ||
        sessions.has(String(row.sessionId)) || !Array.isArray(row.players) || !Array.isArray(row.spectators) ||
        row.players.length > 36 || row.spectators.length > 100 || row.players.length + row.spectators.length === 0 ||
        [...row.players, ...row.spectators].some(name => !text(name, 150))) return invalid();
    sessions.add(String(row.sessionId));
  }
  if (!exact(receipt, "bytesBase64,contentType,name") || !text(receipt.name, 255) || /[\\/\u0000-\u001f\u007f]/.test(receipt.name) ||
      !RECEIPT_TYPES.includes(String(receipt.contentType)) || !text(receipt.bytesBase64, Math.ceil(RECEIPT_MAX_BYTES / 3) * 4) ||
      receipt.bytesBase64.length % 4 !== 0 || !/^[A-Za-z0-9+/]*={0,2}$/.test(receipt.bytesBase64)) return invalid();
  let bytes: Uint8Array;
  try { bytes = decodeBase64(receipt.bytesBase64); } catch { return invalid(); }
  if (!bytes.byteLength || bytes.byteLength > RECEIPT_MAX_BYTES) return invalid();
  return attempt as unknown as RegistrationAttempt;
}

export async function readRecoveryFile(file: File): Promise<RegistrationAttempt> {
  if (file.size > MAX_RECOVERY_BYTES) throw new Error("This recovery file is too large.");
  const original = parseRecovery(await file.text());
  const bytes = decodeBase64(original.receipt.bytesBase64);
  const hash = [...new Uint8Array(await crypto.subtle.digest("SHA-256", bytes))].map(byte => byte.toString(16).padStart(2, "0")).join("");
  if (hash !== original.input.receiptSha256) throw new Error("The receipt in this recovery file changed. Choose the original downloaded file.");
  // Staged files expire and belong to one browser profile. The app-level secret prevents double registration.
  return {...original, registerKey: mutationKey("register"), uploadKey: mutationKey("upload"), fileId: null};
}

/** Call from an explicit click. The trusted host permits downloads without same-origin access. */
export function downloadBlob(blob: Blob, name: string): void {
  const url = URL.createObjectURL(blob), link = document.createElement("a");
  link.href = url; link.download = name; document.body.append(link); link.click(); link.remove();
  setTimeout(() => URL.revokeObjectURL(url), 30_000);
}
