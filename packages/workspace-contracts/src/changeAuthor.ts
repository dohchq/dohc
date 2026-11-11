import { z } from "zod";

const Person = z.object({ kind: z.literal("person"), personId: z.string().min(1) }).strict();
// agentName is the name a connected agent gave itself, a label only.
const Agent = z.object({ kind: z.literal("agent"), agentId: z.string().min(1), agentName: z.string().min(1).max(64).optional(), onBehalfOf: z.string().min(1), depth: z.number().int().nonnegative() }).strict();

// Who asked for a change on this computer. Local provenance grants no workspace or relay authority.
export const ChangeAuthor = z.discriminatedUnion("kind", [Person, Agent]);
export type ChangeAuthor = z.infer<typeof ChangeAuthor>;

// Compare the stored local person id with this computer at read time.
export const ChangeAuthorStatus = z.discriminatedUnion("kind", [Person.extend({ self: z.boolean() }), Agent]);
export type ChangeAuthorStatus = z.infer<typeof ChangeAuthorStatus>;

/**
 * The author with a name the engine can store, or none. An agent names itself,
 * so a name too long or not well-formed text is left out rather than failing
 * the change it labels.
 */
export function storableChangeAuthor(author: ChangeAuthor): ChangeAuthor {
  if (author.kind === "person" || author.agentName === undefined) return author;
  const { agentName, ...rest } = author;
  return agentName.length > 0 && agentName.length <= 64 && agentName.isWellFormed() ? author : rest;
}

export function changeAuthorStatus(author: ChangeAuthor, localPersonId: string | null): ChangeAuthorStatus {
  return author.kind === "agent" ? author : { ...author, self: author.personId === localPersonId };
}
