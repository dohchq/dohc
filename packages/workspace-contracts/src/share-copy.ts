import { z } from "zod";

const Id = z.string().min(1).max(128);
export const ShareCopyInput = z.object({ shareId: Id, grantId: Id }).strict();
export type ShareCopyInput = z.infer<typeof ShareCopyInput>;
const Coordinates = { workspaceId: z.string().min(1).max(256), shareId: Id, grantId: Id };
export const RelayShareCopyResult = z.discriminatedUnion("status", [
  z.object({ ...Coordinates, status: z.literal("active"), browserInvitationUrl: z.string().url().max(4096).optional() }).strip(),
  z.object({ ...Coordinates, status: z.literal("ended") }).strict(),
]);
export type RelayShareCopyResult = z.infer<typeof RelayShareCopyResult>;
export const ShareCopyResult = z.discriminatedUnion("status", [
  z.object({ status: z.literal("active"), shareCode: z.string().min(1).max(4096), browserInvitationUrl: z.string().url().max(4096).optional() }).strict(),
  z.object({ status: z.literal("ended") }).strict(),
]);
export type ShareCopyResult = z.infer<typeof ShareCopyResult>;
