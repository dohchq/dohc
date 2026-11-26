import { z } from "zod";

const PublicationId = z.string().regex(/^[0-9a-f]{64}$/, "Use an app id from the app list.");
const Sha256 = z.string().regex(/^[0-9a-f]{64}$/);
/** The name a Member app keeps in the workspace. Sharing it again under the same name updates it. */
export const MemberAppSlug = z
  .string()
  .regex(/^[a-z0-9-]{1,64}$/, "Use 1 to 64 lowercase letters, digits, or hyphens.");
const AppFolder = z.string().min(1).max(255);

/** A workspace app a member can open: an official app the Owner published, or a Member app. */
export const WorkspaceAppRow = z
  .object({
    kind: z.enum(["workspace", "member"]),
    publicationId: PublicationId,
    name: z.string().min(1).max(1024),
    authorName: z.string().max(1024).nullable(),
    createdAtMs: z.number().int().nonnegative(),
    reachable: z.boolean(),
    /** For a Member app, whether this person allowed it: never, this version, or an earlier one. */
    consent: z.enum(["none", "current", "changed"]).nullable(),
    canWithdraw: z.boolean(),
    /** Where the app opens in a browser, when the server has a viewer. */
    url: z.string().url().nullable(),
  })
  .strict();
export type WorkspaceAppRow = z.infer<typeof WorkspaceAppRow>;

export const MemberAppsListInput = z
  .object({
    cursor: z
      .string()
      .regex(/^(w[0-9a-f]{64}|m([0-9a-f]{64})?)$/)
      .optional(),
  })
  .strict();
export const MemberAppsListResult = z
  .object({
    apps: z.array(WorkspaceAppRow).max(25),
    /** A page can be empty and still have a next page. */
    nextCursor: z.string().nullable(),
    /** On the first page: whether members may share apps. */
    membersCanShare: z.boolean().optional(),
  })
  .strict();
export type MemberAppsListResult = z.infer<typeof MemberAppsListResult>;

export const MemberAppInspectInput = z.object({ publicationId: PublicationId }).strict();
export const MemberAppInspectResult = z
  .object({
    name: z.string().min(1).max(1024),
    authorName: z.string().max(1024).nullable(),
    consent: z.enum(["none", "current", "changed"]),
    collections: z
      .array(
        z
          .object({
            name: z.string().max(1024),
            access: z.string().max(32),
            operations: z
              .array(z.object({ name: z.string().max(1024), readOnly: z.boolean() }).strict())
              .max(256),
          })
          .strict(),
      )
      .max(64),
    source: z
      .array(
        z
          .object({
            path: z.string().min(1).max(1024),
            sha256: Sha256,
            byteLength: z.number().int().nonnegative(),
          })
          .strict(),
      )
      .max(512),
  })
  .strict();
export type MemberAppInspectResult = z.infer<typeof MemberAppInspectResult>;

export const MemberAppShareInput = z
  .object({ personalApp: AppFolder, slug: MemberAppSlug.optional() })
  .strict();
export const MemberAppShareResult = z
  .object({ publicationId: PublicationId, slug: MemberAppSlug })
  .strict();
export type MemberAppShareResult = z.infer<typeof MemberAppShareResult>;

export const MemberAppForkInput = z
  .object({ publicationId: PublicationId, personalApp: AppFolder })
  .strict();
export const MemberAppForkResult = z.object({ personalApp: AppFolder }).strict();

export const MemberAppWithdrawInput = z.object({ publicationId: PublicationId }).strict();
export const MemberAppWithdrawResult = z.object({ publicationId: PublicationId }).strict();

export const MemberAppSharingInput = z.object({ membersCanShare: z.boolean() }).strict();
export const MemberAppSharingResult = z.object({ membersCanShare: z.boolean() }).strict();

const failed = z.object({ ok: z.literal(false), reason: z.string().min(1) }).strict();
const done = { ok: z.literal(true) };
export const MemberAppShareSocketResult = z.union([
  MemberAppShareResult.extend(done).strict(),
  failed,
]);
export const MemberAppForkSocketResult = z.union([
  MemberAppForkResult.extend(done).strict(),
  failed,
]);
export const MemberAppWithdrawSocketResult = z.union([
  MemberAppWithdrawResult.extend(done).strict(),
  failed,
]);
export const MemberAppSharingSocketResult = z.union([
  MemberAppSharingResult.extend(done).strict(),
  failed,
]);
