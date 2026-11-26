import { z } from "zod";

const path = z.string().min(1).max(4096);
const LinkSubject = z.union([
  z.object({ path }).strict(),
  z.object({ objectId: z.string().min(1).max(500) }).strict(),
]);
const LinkLiteral = z
  .object({
    kind: z.enum(["wikilink", "markdown"]),
    literal: z.string().max(2048),
  })
  .strict();
export const LinksInInput = z
  .object({
    subject: LinkSubject,
    cursor: z.string().max(32768).optional(),
  })
  .strict();
export const LinksResolveInput = z
  .object({
    source: path,
    literals: z.array(LinkLiteral).max(128),
  })
  .strict();
const LinkEntry = z
  .object({
    source: path,
    title: z.string().max(640),
    ordinal: z.number().int().nonnegative(),
    span: z.tuple([z.number().int().nonnegative(), z.number().int().nonnegative()]),
    line: z.number().int().positive(),
    highlightStart: z.number().int().nonnegative(),
    highlightEnd: z.number().int().nonnegative(),
    snippet: z.string().max(960),
  })
  .strict();
export const LinksInResult = z
  .object({
    versionId: z.string(),
    subject: z.object({ path, objectId: z.string() }).strict(),
    entries: z.array(LinkEntry).max(100),
    unchecked: z.array(path).max(100),
    complete: z.boolean(),
    indexBuilding: z.boolean(),
    mountsCovered: z.boolean(),
    nextCursor: z.string().max(32768).nullable(),
  })
  .strict()
  .nullable();
export const LinksResolveResult = z
  .object({
    versionId: z.string(),
    results: z
      .array(
        z
          .union([
            z.object({ path, fragment: z.string().nullable() }).strict(),
            z.object({ path: z.null(), create: path, fragment: z.string().nullable() }).strict(),
          ])
          .nullable(),
      )
      .max(128),
    mountsCovered: z.boolean(),
  })
  .strict();
export type LinksInInput = z.infer<typeof LinksInInput>;
export type LinksResolveInput = z.infer<typeof LinksResolveInput>;
export type LinksInResult = z.infer<typeof LinksInResult>;
export type LinksResolveResult = z.infer<typeof LinksResolveResult>;

export const LinksEdgesInput = z.object({ cursor: z.string().max(32768).optional() }).strict();
export const LinksEdgesResult = z
  .object({
    versionId: z.string(),
    files: z.array(
      z.object({ objectId: z.string().min(1).max(500), path, title: z.string().max(640) }).strict(),
    ),
    entries: z.array(
      z
        .object({
          source: path,
          target: path,
          kind: z.enum(["wikilink", "markdown"]),
          ordinal: z.number().int().nonnegative(),
        })
        .strict(),
    ),
    unchecked: z.array(path),
    complete: z.boolean(),
    indexBuilding: z.boolean(),
    mountsCovered: z.boolean(),
    nextCursor: z.string().max(32768).nullable(),
  })
  .strict()
  .superRefine((page, ctx) => {
    if (page.files.length + page.entries.length + page.unchecked.length > 100)
      ctx.addIssue({ code: "custom", message: "Link page exceeds 100 records." });
    if (new TextEncoder().encode(JSON.stringify(page)).byteLength > 64 * 1024)
      ctx.addIssue({ code: "custom", message: "Link page exceeds 64 KiB." });
  });
export type LinksEdgesInput = z.infer<typeof LinksEdgesInput>;
export type LinksEdgesResult = z.infer<typeof LinksEdgesResult>;

export const LINKS_CONNECTIONS_MAX_BYTES = 64 * 1024;
const id = z.string().min(1).max(4200);
const node = <Kind extends string, Shape extends z.ZodRawShape>(kind: Kind, shape: Shape) =>
  z.object({ id, kind: z.literal(kind), title: z.string().max(640), ...shape }).strict();
const ConnectionNode = z.discriminatedUnion("kind", [
  node("document-collection", { path, recordCount: z.number().int().nonnegative() }),
  node("dataset", {
    path,
    datasetId: z.string().max(64).nullable(),
    firstTableId: z.string().max(64).nullable(),
  }),
  node("app", { path, entryPath: path.nullable() }),
  node("automation", { path, automationId: id, enabled: z.boolean() }),
  node("group", { channelId: z.string().min(1).max(500) }),
]);
const ConnectionEdge = z
  .object({
    source: id,
    target: id,
    kind: z.enum([
      "relation",
      "app-uses-data",
      "automation-trigger",
      "automation-action",
      "automation-runs-file",
    ]),
    approval: z.enum(["approved", "requested"]).optional(),
  })
  .strict();
export const LinksConnectionsInput = z.object({}).strict();
export const LinksConnectionsResult = z
  .object({
    scope: z.enum(["workspace", "share-omitted"]),
    nodes: z.array(ConnectionNode),
    edges: z.array(ConnectionEdge),
    records: z.array(z.object({ collection: id, paths: z.array(path) }).strict()),
    complete: z.boolean(),
    mountsCovered: z.boolean(),
  })
  .strict()
  .superRefine((result, ctx) => {
    if (new TextEncoder().encode(JSON.stringify(result)).byteLength > LINKS_CONNECTIONS_MAX_BYTES)
      ctx.addIssue({ code: "custom", message: "Connections exceed 64 KiB." });
  });
export type LinksConnectionsInput = z.infer<typeof LinksConnectionsInput>;
export type LinksConnectionsResult = z.infer<typeof LinksConnectionsResult>;
export type LinksConnectionNode = LinksConnectionsResult["nodes"][number];
export type LinksConnectionEdge = LinksConnectionsResult["edges"][number];
export const SHARE_OMITTED_CONNECTIONS: LinksConnectionsResult = {
  scope: "share-omitted",
  nodes: [],
  edges: [],
  records: [],
  complete: true,
  mountsCovered: false,
};
