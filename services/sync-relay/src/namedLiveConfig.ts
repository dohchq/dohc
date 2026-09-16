import { createLiveFrameSession, type LiveFrameSessionPolicy } from "@dohc/live-session-contract/live-frame";
import type { OrderedLiveUpdateCutPolicy } from "@dohc/ydoc-projection/live-journal-validation";
import { liveValidation } from "./liveValidation.js";
import { parseNamedLiveRouteLimits } from "./namedLiveRoutes.js";
import type { NamedFrameHostBounds } from "./namedLiveFrameHost.js";

function record(value: unknown, fields: string[]): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value) || Object.keys(value).sort().join() !== fields.sort().join()) throw new TypeError("Invalid named live configuration fields.");
  return { ...value };
}
function positive(value: unknown): number {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 1 || value > 2_147_483_647) throw new TypeError("Invalid named live budget.");
  return value;
}

export function parseNamedLiveConfig(value: unknown) {
  const config = record(value, ["version", "tickets", "transport", "frames", "host", "validation", "maxListeners"]);
  if (config.version !== 1) throw new TypeError("Invalid named live configuration version.");
  const ticket = record(config.tickets, ["retainedTicketsPerPrincipalGrant", "expiredTicketCleanupBatchSize"]);
  const tickets = { retainedTicketsPerPrincipalGrant: positive(ticket.retainedTicketsPerPrincipalGrant), expiredTicketCleanupBatchSize: positive(ticket.expiredTicketCleanupBatchSize) };
  const transport = parseNamedLiveRouteLimits(config.transport);
  const frame = record(config.frames, ["receive", "maxQueuedBytes", "maxQueuedFrames", "maxControlBytes", "maxControlFrames", "maxAssemblyBytes"]);
  const receive = record(frame.receive, ["maxFrameBytes", "maxStateVectorBytes", "maxUpdateBytes", "maxSyncBytes"]);
  const frames = { ...frame, receive: { ...receive } } as unknown as LiveFrameSessionPolicy;
  createLiveFrameSession("server", frames).close();
  const hostFields = ["maxClientVectorBytes", "maxSyncOutputBytes", "maxAppliedUpdateBytes", "maxSubmissionBytes", "maxAdmissionBytes"];
  const host = record(config.host, hostFields) as unknown as NamedFrameHostBounds;
  for (const number of Object.values(host)) positive(number);
  if (host.maxSyncOutputBytes < 2 || host.maxAppliedUpdateBytes < 2) throw new TypeError("Invalid named live budget.");
  const validation = record(config.validation, ["maxStructVisits", "maxValueNodeVisits", "maxDecodedPayloadByteVisits", "maxStructClientGroupVisits",
    "maxDeleteClientGroupVisits", "maxDeleteIntervalVisits", "maxIndexOperations"]) as unknown as OrderedLiveUpdateCutPolicy;
  for (const number of Object.values(validation)) positive(number);
  const validate = liveValidation.validator(validation);
  const maxListeners = positive(config.maxListeners);
  if (maxListeners < 2 * transport.maxConnections || transport.maxPendingBytes < frames.receive.maxFrameBytes) throw new TypeError("Named transport budgets cannot cover configured connections and frames.");
  return { tickets, transport, frames, host, validate, maxListeners };
}
