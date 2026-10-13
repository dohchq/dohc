import { z } from "zod";
import { WorkspaceDaemonRequester } from "@dohc/workspace-engine-client";

const Statuses = z.record(z.string(), z.object({
  state: z.enum(["pending", "accepted", "refused"]),
  contentHash: z.string().nullable(),
  reason: z.string().optional(),
  originalRecordId: z.string().optional(),
  canDiscard: z.boolean(),
}));
export type ShareRecordStatus = z.infer<typeof Statuses>[string];

/** Status is optional evidence. An unavailable engine must not prevent reads. */
export async function shareRecordStatuses(
  requester: WorkspaceDaemonRequester,
  params: Parameters<WorkspaceDaemonRequester["request"]>[1],
  options: Parameters<WorkspaceDaemonRequester["request"]>[2],
): Promise<z.infer<typeof Statuses>> {
  try { return Statuses.parse(await requester.request("share.records.status", params, options)); }
  catch { return {}; }
}
