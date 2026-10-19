import { z } from "zod";

const path = z.string().min(1).max(4096);
const LinkSubject = z.union([
  z.object({ path }).strict(),
  z.object({ objectId: z.string().min(1).max(500) }).strict(),
]);
const LinkLiteral = z.object({
  kind: z.enum(["wikilink", "markdown"]),
  literal: z.string().max(2048),
}).strict();
export const LinksInInput = z.object({
  subject: LinkSubject,
  cursor: z.string().max(32768).optional(),
}).strict();
export const LinksResolveInput = z.object({
  source: path,
  literals: z.array(LinkLiteral).max(128),
}).strict();
const LinkEntry = z.object({
  source: path,
  title: z.string().max(640),
  ordinal: z.number().int().nonnegative(),
  span: z.tuple([z.number().int().nonnegative(), z.number().int().nonnegative()]),
  line: z.number().int().positive(),
  highlightStart: z.number().int().nonnegative(),
  highlightEnd: z.number().int().nonnegative(),
  snippet: z.string().max(960),
}).strict();
export const LinksInResult = z.object({
  versionId: z.string(),
  subject: z.object({ path, objectId: z.string() }).strict(),
  entries: z.array(LinkEntry).max(100),
  unchecked: z.array(path).max(100),
  complete: z.boolean(),
  indexBuilding: z.boolean(),
  mountsCovered: z.boolean(),
  nextCursor: z.string().max(32768).nullable(),
}).strict().nullable();
export const LinksResolveResult = z.object({
  versionId: z.string(),
  results: z.array(z.union([
    z.object({ path, fragment: z.string().nullable() }).strict(),
    z.object({ path: z.null(), create: path, fragment: z.string().nullable() }).strict(),
  ]).nullable()).max(128),
  mountsCovered: z.boolean(),
}).strict();
export type LinksInInput = z.infer<typeof LinksInInput>;
export type LinksResolveInput = z.infer<typeof LinksResolveInput>;
export type LinksInResult = z.infer<typeof LinksInResult>;
export type LinksResolveResult = z.infer<typeof LinksResolveResult>;

export const LinksEdgesInput = z.object({ cursor: z.string().max(32768).optional() }).strict();
export const LinksEdgesResult = z.object({
  versionId: z.string(),
  files: z.array(z.object({ objectId: z.string().min(1).max(500), path, title: z.string().max(640) }).strict()),
  entries: z.array(z.object({ source: path, target: path, kind: z.enum(["wikilink", "markdown"]), ordinal: z.number().int().nonnegative() }).strict()),
  unchecked: z.array(path),
  complete: z.boolean(),
  indexBuilding: z.boolean(),
  mountsCovered: z.boolean(),
  nextCursor: z.string().max(32768).nullable(),
}).strict().superRefine((page, ctx) => {
  if (page.files.length + page.entries.length + page.unchecked.length > 100)
    ctx.addIssue({ code: "custom", message: "Link page exceeds 100 records." });
  if (new TextEncoder().encode(JSON.stringify(page)).byteLength > 64 * 1024)
    ctx.addIssue({ code: "custom", message: "Link page exceeds 64 KiB." });
});
export type LinksEdgesInput = z.infer<typeof LinksEdgesInput>;
export type LinksEdgesResult = z.infer<typeof LinksEdgesResult>;
