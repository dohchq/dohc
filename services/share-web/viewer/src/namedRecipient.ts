import {normalizeShareLabel} from "@dohc/security-contract/share-labels";
import {parseLiveUpdateIdentifier} from "@dohc/live-session-contract/live-update-admission";
import {LiveAuthorityUnavailableError, parseNamedLiveBrowserLimits, type NamedLiveBrowserLimits} from "@dohc/ydoc-projection/named-live-browser-transport";
import {RETRY_BUDGET_MS} from "./retry";

// The existing share-web authenticated metadata ceiling also bounds invitation and account responses.
const RESPONSE_BYTES = 2 * 1024 * 1024;
const record = (value: unknown): value is Record<string, unknown> => value !== null && typeof value === "object" && !Array.isArray(value);
export interface NamedRecipientFiles {subjectName: string | null; sharerName: string | null; access: "edit";userId: string; workspaceId: string; shareId: string; grantId: string;
  files: {objectId: string; path: string}[]; limits: NamedLiveBrowserLimits}
export async function namedRequest(path: string, signal: AbortSignal, body?: unknown): Promise<unknown> {
  signal = AbortSignal.any([signal, AbortSignal.timeout(RETRY_BUDGET_MS)]);
  const response = await fetch(path, {method: body === undefined ? "GET" : "POST", credentials: "same-origin", cache: "no-store",
    redirect: "error", signal, headers: {accept: "application/json", ...(body === undefined ? {} : {"content-type": "application/json"})},
    ...(body === undefined ? {} : {body: JSON.stringify(body)})});
  try {
    if ([401, 403, 404].includes(response.status)) throw new LiveAuthorityUnavailableError("Unavailable");
    if (response.status !== 200 || response.redirected || !response.body ||
      response.headers.get("content-type")?.split(";", 1)[0]?.trim().toLowerCase() !== "application/json") throw Error("Unavailable");
    const reader = response.body.getReader(), decoder = new TextDecoder("utf-8", {fatal: true});
    let length = 0, text = "";
    const cancel = () => {void reader.cancel().catch(() => {});};
    signal.addEventListener("abort", cancel, {once: true});
    try {
      while (true) {
        signal.throwIfAborted();
        const chunk = await reader.read(); signal.throwIfAborted();
        if (chunk.done) break;
        if (chunk.value.length > RESPONSE_BYTES - length) throw Error("Response too large");
        length += chunk.value.length; text += decoder.decode(chunk.value, {stream: true});
      }
      return JSON.parse(text + decoder.decode()) as unknown;
    } finally {signal.removeEventListener("abort", cancel); await reader.cancel().catch(() => {}); reader.releaseLock();}
  } finally {await response.body?.cancel().catch(() => {});}
}
export function accountUser(value: unknown): {id: string; name: string} | null {
  if (!record(value) || Object.keys(value).join() !== "user") throw Error("Invalid account");
  if (value.user === null) return null;
  if (!record(value.user) || Object.keys(value.user).sort().join() !== "id,name" || typeof value.user.name !== "string") throw Error("Invalid account");
  return {id: parseLiveUpdateIdentifier(value.user.id), name: value.user.name};
}
export function namedFiles(value: unknown, userId: string, grantId: string): NamedRecipientFiles {
  if (!record(value) || Object.keys(value).sort().join() !== "access,files,grantId,limits,shareId,sharerName,subjectName,userId,workspaceId" ||
    value.access !== "edit" || value.userId !== userId || value.grantId !== grantId || !Array.isArray(value.files)) throw Error("Invalid selection");
  const seen = new Set<string>();
  const files = value.files.map(file => {
    if (!record(file) || Object.keys(file).sort().join() !== "objectId,path" || typeof file.path !== "string" ||
      !/\.md$/i.test(file.path) || file.path.length > 1024 || seen.has(file.objectId as string)) throw Error("Invalid file");
    const objectId = parseLiveUpdateIdentifier(file.objectId); seen.add(objectId);
    return {objectId, path: file.path};
  });
  return {subjectName: normalizeShareLabel(value.subjectName), sharerName: normalizeShareLabel(value.sharerName, 320), access: "edit", userId, grantId, workspaceId: parseLiveUpdateIdentifier(value.workspaceId), shareId: parseLiveUpdateIdentifier(value.shareId),
    files, limits: parseNamedLiveBrowserLimits(value.limits)};
}
