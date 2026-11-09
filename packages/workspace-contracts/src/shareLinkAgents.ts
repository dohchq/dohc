import { z } from "zod";

const Id = z.string().min(1).max(200);
const Cursor = z.string().min(1).max(1024);

// One agent connected through a link. Its name is the one its client
// reported at sign-in, which dohc cannot check; null when it reported none.
export const RelayShareLinkAgent = z.object({
  connectionId: Id,
  reportedName: z.string().min(1).max(100).nullable(),
  connectedAtMs: z.number().int().nonnegative(),
  lastActionAtMs: z.number().int().nonnegative().nullable(),
});
export type RelayShareLinkAgent = z.infer<typeof RelayShareLinkAgent>;

// A link names no workspace: main answers for the workspace it admitted.
export const ShareLinkAgentsInput = z.object({ shareId: Id, grantId: Id, cursor: Cursor.optional() }).strict();
export type ShareLinkAgentsInput = z.infer<typeof ShareLinkAgentsInput>;

// The relay answers 50 connections a page.
export const ListRelayShareLinkAgentsResult = z
  .object({
    agents: z.array(RelayShareLinkAgent).max(50),
    nextCursor: Cursor.nullable(),
  })
  .strict();
export type ListRelayShareLinkAgentsResult = z.infer<typeof ListRelayShareLinkAgentsResult>;

export const ShareLinkAgentDisconnectInput = z.object({ shareId: Id, grantId: Id, connectionId: Id }).strict();
export type ShareLinkAgentDisconnectInput = z.infer<typeof ShareLinkAgentDisconnectInput>;

export const DisconnectRelayShareLinkAgentResult = z.object({ connectionId: Id }).strict();
export type DisconnectRelayShareLinkAgentResult = z.infer<typeof DisconnectRelayShareLinkAgentResult>;
