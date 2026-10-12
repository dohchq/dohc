import { parseLiveUpdateIdentifier } from "./liveUpdateAdmission.js";

export const MAX_LIVE_AUTHOR_ENTRY_BYTES = 4096;
export const MAX_LIVE_AUTHOR_IDENTITIES = 1024;
export const MAX_LIVE_AUTHOR_BYTES = 128 * 1024;
export const LIVE_AUTHOR_CHECKPOINT_IDENTITIES = 960;
export const LIVE_AUTHOR_CHECKPOINT_BYTES = 96 * 1024;

export interface LiveDeclaredAgent {
  readonly agentId: string;
  readonly agentName?: string;
  readonly onBehalfOf?: string;
  readonly depth?: number;
}
export type LiveAuthorContext = (
  | { readonly kind: "account"; readonly accountId: string }
  | { readonly kind: "link"; readonly publicPrincipalId: string }
  | { readonly kind: "signed-out" }
) & { readonly agent?: LiveDeclaredAgent };
export interface AutomationDeclaration {
  readonly automationId: string;
  readonly attribution: {readonly actorKind: "automation"; readonly onBehalfOf?: string; readonly depth: number; readonly run?: {readonly claimId: string; readonly automationName: string}};
}
export function parseAutomationDeclaration(value: unknown): AutomationDeclaration {
  const entry = record(value, ["automationId", "attribution"]);
  const attribution = record(entry.attribution, ["actorKind", "depth"], ["onBehalfOf", "run"]);
  if (attribution.actorKind !== "automation" || !Number.isSafeInteger(attribution.depth) || (attribution.depth as number) < 0 || (attribution.depth as number) > 64) throw new TypeError("Invalid automation attribution.");
  const run = attribution.run === undefined ? undefined : record(attribution.run, ["claimId", "automationName"]);
  if (run && (typeof run.automationName !== "string" || !run.automationName.trim() || new TextEncoder().encode(run.automationName).byteLength > 1024 || /[\u0000-\u001f\u007f]/.test(run.automationName))) throw new TypeError("Invalid automation name.");
  return {automationId: parseLiveUpdateIdentifier(entry.automationId), attribution: {actorKind: "automation",
    ...(attribution.onBehalfOf === undefined ? {} : {onBehalfOf: parseLiveUpdateIdentifier(attribution.onBehalfOf)}),
    depth: attribution.depth as number,
    ...(run ? {run: {claimId: parseLiveUpdateIdentifier(run.claimId), automationName: run.automationName as string}} : {})}};
}
export type LiveAuthorEntry =
  | { readonly kind: "unattributed" }
  | ({readonly kind: "automation"} & AutomationDeclaration)
  | { readonly kind: "human"; readonly humanId: string; readonly humanName: string }
  | { readonly kind: "link"; readonly publicPrincipalId: string; readonly label: string }
  | ({ readonly kind: "agent" } & LiveDeclaredAgent);
export type LiveAuthorSnapshot = readonly LiveAuthorEntry[];

function record(value: unknown, required: readonly string[], optional: readonly string[] = []): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) throw new TypeError("Invalid live author record.");
  const entry = value as Record<string, unknown>;
  if (required.some(key => !Object.hasOwn(entry, key)) || Object.keys(entry).some(key => !required.includes(key) && !optional.includes(key)))
    throw new TypeError("Invalid live author fields.");
  return entry;
}
function agent(value: unknown): LiveDeclaredAgent {
  const entry = record(value, ["agentId"], ["agentName", "onBehalfOf", "depth"]);
  const result: LiveDeclaredAgent = {
    agentId: parseLiveUpdateIdentifier(entry.agentId),
    ...(Object.hasOwn(entry, "agentName") ? {agentName: parseLiveUpdateIdentifier(entry.agentName)} : {}),
    ...(Object.hasOwn(entry, "onBehalfOf") ? {onBehalfOf: parseLiveUpdateIdentifier(entry.onBehalfOf)} : {}),
    ...(Object.hasOwn(entry, "depth") ? {depth: entry.depth as number} : {}),
  };
  if (result.depth !== undefined && (!Number.isSafeInteger(result.depth) || result.depth < 0 || result.depth > 64)) throw new TypeError("Invalid declared agent depth.");
  return result;
}
export function parseLiveAuthorContext(value: unknown): LiveAuthorContext {
  const entry = record(value, ["kind"], ["accountId", "publicPrincipalId", "agent"]);
  const declared = Object.hasOwn(entry, "agent") ? {agent: agent(entry.agent)} : {};
  if (entry.kind === "account") {
    record(value, ["kind", "accountId"], ["agent"]);
    return {kind: "account", accountId: parseLiveUpdateIdentifier(entry.accountId), ...declared};
  }
  if (entry.kind === "link") {
    record(value, ["kind", "publicPrincipalId"], ["agent"]);
    return {kind: "link", publicPrincipalId: parseLiveUpdateIdentifier(entry.publicPrincipalId), ...declared};
  }
  if (entry.kind !== "signed-out") throw new TypeError("Invalid author context kind.");
  record(value, ["kind"], ["agent"]);
  return {kind: "signed-out", ...declared};
}
export function parseLiveAuthorSnapshot(value: unknown): LiveAuthorSnapshot {
  if (!Array.isArray(value) || value.length > 2) throw new TypeError("Invalid live author snapshot.");
  const result = Array.from(value, item => {
    const entry = record(item, ["kind"], ["humanId", "humanName", "publicPrincipalId", "label", "agentId", "agentName", "onBehalfOf", "depth", "automationId", "attribution"]);
    let author: LiveAuthorEntry;
    if (entry.kind === "unattributed") {
      record(item, ["kind"]);
      author = {kind: "unattributed"};
    } else if (entry.kind === "automation") {
      const {kind: _kind, ...fields} = entry;
      author = {kind: "automation", ...parseAutomationDeclaration(fields)};
    } else if (entry.kind === "human") {
      record(item, ["kind", "humanId", "humanName"]);
      author = {kind: "human", humanId: parseLiveUpdateIdentifier(entry.humanId), humanName: parseLiveUpdateIdentifier(entry.humanName)};
    } else if (entry.kind === "link") {
      record(item, ["kind", "publicPrincipalId", "label"]);
      author = {kind: "link", publicPrincipalId: parseLiveUpdateIdentifier(entry.publicPrincipalId), label: parseLiveUpdateIdentifier(entry.label)};
    } else if (entry.kind === "agent") {
      const {kind: _kind, ...fields} = entry;
      author = {kind: "agent", ...agent(fields)};
    } else throw new TypeError("Invalid author kind.");
    if (new TextEncoder().encode(JSON.stringify(author)).byteLength > MAX_LIVE_AUTHOR_ENTRY_BYTES) throw new TypeError("Live author entry is too large.");
    return author;
  });
  if (result.length === 2 && ((result[0]?.kind === "agent" || result[0]?.kind === "automation") || result[1]?.kind !== "agent")) throw new TypeError("Noncanonical author snapshot.");
  return result;
}
export function liveAuthorIdentity(entry: LiveAuthorEntry): string {
  if (entry.kind === "unattributed") return JSON.stringify([entry.kind, null, ""]);
  if (entry.kind === "automation") return JSON.stringify([entry.kind, entry.attribution.run?.claimId ?? null, entry.automationId]);
  return JSON.stringify([entry.kind, entry.kind === "agent" ? entry.onBehalfOf ?? null : null, entry.kind === "human" ? entry.humanId : entry.kind === "link" ? entry.publicPrincipalId : entry.agentId]);
}
