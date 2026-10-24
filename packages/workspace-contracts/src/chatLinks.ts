import { z } from "zod";
import { ACTOR_HUES } from "./actorPresentation";

const id = z.string().min(1).max(500);
const path = z.string().min(1).max(4096);
export const ChatLinksInput = z.object({
  channelWireId: id,
  cursor: z.string().max(32768).optional(),
}).strict();

const coordinates = { threadId: id, messageId: id, mentionedAtMs: z.number().int() };
const file = z.object({ objectId: id, path, folder: z.string().max(4096) }).strict();
const envelope = {
  versionId: id,
  subject: z.object({ channelWireId: id }).strict(),
  unchecked: z.array(path),
  complete: z.boolean(),
  indexBuilding: z.boolean(),
  mountsCovered: z.boolean(),
  sharedChannelRowsUncovered: z.number().int().nonnegative(),
  nextCursor: z.string().max(32768).nullable(),
};
const author = z.object({
  kind: z.enum(["human", "agent", "automation", "link"]),
  displayName: z.string(),
  ownerDisplayName: z.string().optional(),
  presentation: z.object({
    group: z.string(), hue: z.enum(ACTOR_HUES).nullable(), self: z.boolean(),
  }).strict(),
}).strict();
const entry = z.object({
  ...coordinates,
  file: file.extend({ receivedSource: id.optional() }).strict(),
  author,
}).strict();

function bounded(page: { entries: unknown[]; unchecked: string[] }, ctx: z.RefinementCtx) {
  if (page.entries.length + page.unchecked.length > 100) {
    ctx.addIssue({ code: "custom", message: "Chat Links page exceeds 100 records." });
  }
  if (new TextEncoder().encode(JSON.stringify(page)).byteLength > 64 * 1024) {
    ctx.addIssue({ code: "custom", message: "Chat Links page exceeds 64 KiB." });
  }
}
export const ChatLinksPage = z.object({
  ...envelope, entries: z.array(entry),
}).strict().superRefine(bounded).nullable();

// Engine-only authorship facts never cross the public doors.
export const ChatLinksEnginePage = z.object({
  ...envelope,
  entries: z.array(z.object({
    ...coordinates, file, attachmentId: id,
    author: z.discriminatedUnion("authorKind", [
      z.object({
        authorKind: z.enum(["human", "agent", "automation"]),
        authorDisplayName: z.string(),
        authorOwnerDisplayName: z.string().optional(),
        authorUserId: z.string().optional(),
        authorActorKey: z.string().optional(),
      }).strict(),
      // A link holder names a link and no account.
      z.object({
        authorKind: z.literal("link"),
        authorDisplayName: z.string(),
        linkGrantId: id,
        linkPrincipalId: id,
      }).strict(),
    ]),
  }).strict()),
}).strict().superRefine(bounded).nullable();

export type ChatLinksInput = z.infer<typeof ChatLinksInput>;
export type ChatLinksPage = z.infer<typeof ChatLinksPage>;
export type ChatLinksEnginePage = z.infer<typeof ChatLinksEnginePage>;
export type ChatLinksEngineInput = ChatLinksInput & {
  workspaceId: string; scope: string; sharedChannelRowsUncovered: number;
};
