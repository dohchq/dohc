import { z } from "zod";

const Person = z.object({ kind: z.literal("person"), personId: z.string().min(1) }).strict();
const Agent = z.object({ kind: z.literal("agent"), agentId: z.string().min(1), onBehalfOf: z.string().min(1), depth: z.number().int().nonnegative() }).strict();

// Local pause provenance grants no workspace or relay authority.
export const WorkspaceSyncPauseAuthor = z.discriminatedUnion("kind", [Person, Agent]);
export type WorkspaceSyncPauseAuthor = z.infer<typeof WorkspaceSyncPauseAuthor>;
export const WorkspaceSyncPause = z.object({
  atMs: z.number().int().nonnegative(), author: WorkspaceSyncPauseAuthor,
}).strict();
export type WorkspaceSyncPause = z.infer<typeof WorkspaceSyncPause>;

// Resolve the person at read time. The registry stores no frozen profile name.
export const WorkspaceSyncPauseStatus = WorkspaceSyncPause.extend({
  author: z.discriminatedUnion("kind", [
    Person.extend({ self: z.boolean(), displayName: z.string().min(1).optional() }), Agent,
  ]),
});
export type WorkspaceSyncPauseStatus = z.infer<typeof WorkspaceSyncPauseStatus>;

export function workspaceSyncPauseStatus(
  pause: WorkspaceSyncPause,
  localPersonId: string | null,
  personName: (personId: string) => string | undefined,
): WorkspaceSyncPauseStatus {
  if (pause.author.kind === "agent") return { atMs: pause.atMs, author: pause.author };
  const displayName = personName(pause.author.personId);
  return { atMs: pause.atMs, author: { ...pause.author,
    self: pause.author.personId === localPersonId, ...(displayName ? { displayName } : {}),
  } };
}
