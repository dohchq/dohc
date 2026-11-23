import { z } from "zod";

export const RetrievalKind = z.enum(["page", "collection", "record", "chat"]);
export type RetrievalKind = z.infer<typeof RetrievalKind>;

const RetrievalCollectionKind = z.enum(["document", "transactional"]);

const RetrievalEdgeKind = z.enum([
  "wikilink",
  "markdown",
  "relation",
  "chat-linked-file",
  "chat-mention",
  "collection-member",
]);

const RetrievalEdgeDirection = z.enum(["out", "in"]);

export const WorkspaceSearchInput = z
  .object({
    query: z.string().trim().min(1).max(512),
    surfaces: z.array(RetrievalKind).min(1).max(4).optional(),
    pathPrefix: z.string().min(1).max(1024).optional(),
    collectionPath: z.string().min(1).max(1024).optional(),
    includeNeighbors: z.boolean().optional(),
    limit: z.number().int().min(1).max(50).optional(),
  })
  .strict();
export type WorkspaceSearchInput = z.infer<typeof WorkspaceSearchInput>;

const RetrievalMatchedField = z
  .object({
    name: z.string(),
    value: z.string(),
  })
  .strict();

const RetrievalRelatedEdge = z
  .object({
    kind: RetrievalKind,
    edge: RetrievalEdgeKind,
    direction: RetrievalEdgeDirection,
    field: z.string().optional(),
    title: z.string(),
    path: z.string().optional(),
    objectId: z.string().optional(),
    collectionPath: z.string().optional(),
    recordId: z.string().optional(),
    threadId: z.string().optional(),
  })
  .strict();

const RetrievalHit = z
  .object({
    id: z.string(),
    kind: RetrievalKind,
    title: z.string(),
    path: z.string().optional(),
    objectId: z.string().optional(),
    collectionKind: RetrievalCollectionKind.optional(),
    collectionPath: z.string().optional(),
    datasetPath: z.string().optional(),
    recordId: z.string().optional(),
    fields: z.array(z.string()).optional(),
    recordCount: z.number().int().nonnegative().optional(),
    matchedFields: z.array(RetrievalMatchedField).optional(),
    threadId: z.string().optional(),
    messageId: z.string().optional(),
    author: z.string().optional(),
    createdAtMs: z.number().int().optional(),
    channelName: z.string().optional(),
    channelWireId: z.string().optional(),
    linkedFilePath: z.string().optional(),
    snippet: z.string(),
    matchedTerms: z.array(z.string()),
    related: z.array(RetrievalRelatedEdge),
  })
  .strict();

const RetrievalNeighborVia = z
  .object({
    fromId: z.string(),
    fromTitle: z.string(),
    edge: RetrievalEdgeKind,
    direction: RetrievalEdgeDirection,
    field: z.string().optional(),
  })
  .strict();

const RetrievalNeighbor = z
  .object({
    id: z.string(),
    kind: RetrievalKind,
    title: z.string(),
    path: z.string().optional(),
    objectId: z.string().optional(),
    collectionPath: z.string().optional(),
    recordId: z.string().optional(),
    threadId: z.string().optional(),
    snippet: z.string().optional(),
    via: z.array(RetrievalNeighborVia),
  })
  .strict();

export const WorkspaceSearchResult = z
  .object({
    versionId: z.string(),
    results: z.array(RetrievalHit),
    neighbors: z.array(RetrievalNeighbor),
    complete: z.boolean(),
    indexBuilding: z.boolean(),
    policyDegraded: z.boolean(),
    mountsCovered: z.boolean(),
    sharedChannelRowsUncovered: z.number().int().nonnegative(),
    truncated: z.boolean(),
  })
  .strict();
export type WorkspaceSearchResult = z.infer<typeof WorkspaceSearchResult>;
