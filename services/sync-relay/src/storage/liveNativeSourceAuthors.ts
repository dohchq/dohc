import {isDeepStrictEqual} from "node:util";
import {parseLiveAuthorContext} from "@dohc/live-session-contract";
import type {AdmittedLiveUpdateMetadata} from "@dohc/live-session-contract/live-update-admission";
import {nativeSourceAgentDeclaration, type NativeRestoreProposalReceipt} from "../liveRestoreProposal";
import type {StorageContext} from "./context";

/** Bind a native draft to its admitted request, including an agent omitted by the window cap. */
export function nativeSourceAuthorMatches(storage: StorageContext,
  source: NativeRestoreProposalReceipt["nativeSources"][number], metadata: AdmittedLiveUpdateMetadata): boolean {
  const row = storage.db.prepare("SELECT author_context_json FROM sync_relay_live_update_journal WHERE delivery_id=?")
    .get(metadata.accepted.receipt.deliveryId);
  if (!row) return false;
  const context = row.author_context_json === null ? undefined : parseLiveAuthorContext(JSON.parse(String(row.author_context_json)));
  const agent = context?.agent;
  const declared = agent === undefined ? undefined : {agentId: agent.agentId, onBehalfOf: agent.onBehalfOf ?? null, depth: agent.depth ?? 0};
  return isDeepStrictEqual(nativeSourceAgentDeclaration(source), declared);
}
