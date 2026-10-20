import { z } from "zod";
const id = z.string().min(1).max(500);
const path = z.string().min(1).max(4096);
export const ChatFileMentionsInput = z.object({
  subject: z.union([z.object({ path }).strict(), z.object({ objectId: id }).strict()]).optional(),
  cursor: z.string().max(32768).optional(),
}).strict();
export const ChatFileMentionEntry = z.object({
  attachment: z.object({
    attachmentId: id, threadId: id, messageId: id, targetKind: z.literal("file"),
    objectId: id, pathHint: path, headingText: z.string().max(300).optional(),
    headingAnchor: z.string().max(400).optional(), headingOccurrence: z.number().int().nonnegative().optional(),
    createdAtMs: z.number().int(),
  }).strict(),
  message: z.object({
    id, authorDisplayName: z.string().max(200), preview: z.string().max(960), createdAtMs: z.number().int(),
  }).strict(),
  thread: z.object({
    id, title: z.string().max(600), createdAtMs: z.number().int(), updatedAtMs: z.number().int(),
  }).strict(),
  channelId: id.optional(), channelWireId: id.optional(), channelName: z.string().max(200).optional(),
  channelSlug: z.string().min(1).refine(value => new TextEncoder().encode(value).byteLength <= 200).optional(), channelKind: z.enum(["channel","dm","agent"]).optional(),
}).strict();
export const ChatFileMentionsPage = z.object({
  versionId: id, subject: z.object({ objectId: id, path }).strict().nullable(),
  entries: z.array(ChatFileMentionEntry), unchecked: z.array(path),
  complete: z.boolean(), indexBuilding: z.boolean(), mountsCovered: z.boolean(),
  sharedChannelRowsUncovered: z.number().int().nonnegative(),
  nextCursor: z.string().max(32768).nullable(),
}).strict().superRefine((page, ctx) => {
  if (page.entries.length + page.unchecked.length > 100)
    ctx.addIssue({ code: "custom", message: "Mention page exceeds 100 records." });
  if (new TextEncoder().encode(JSON.stringify(page)).byteLength > 64 * 1024)
    ctx.addIssue({ code: "custom", message: "Mention page exceeds 64 KiB." });
}).nullable();
export type ChatFileMentionsInput = z.infer<typeof ChatFileMentionsInput>;
export type ChatFileMentionEntry = z.infer<typeof ChatFileMentionEntry>;
export type ChatFileMentionsPage = z.infer<typeof ChatFileMentionsPage>;
export type ChatFileMentionsEngineInput = ChatFileMentionsInput & {
  workspaceId: string; scope: string; sharedChannelRowsUncovered: number;
};
