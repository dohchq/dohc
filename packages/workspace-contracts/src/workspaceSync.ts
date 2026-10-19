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

// Compare the stored local person id with this computer at read time.
export const WorkspaceSyncPauseStatus = WorkspaceSyncPause.extend({
  author: z.discriminatedUnion("kind", [
    Person.extend({ self: z.boolean() }), Agent,
  ]),
});
export type WorkspaceSyncPauseStatus = z.infer<typeof WorkspaceSyncPauseStatus>;

export function workspaceSyncPauseStatus(
  pause: WorkspaceSyncPause,
  localPersonId: string | null,
): WorkspaceSyncPauseStatus {
  if (pause.author.kind === "agent") return { atMs: pause.atMs, author: pause.author };
  return { atMs: pause.atMs, author: { ...pause.author,
    self: pause.author.personId === localPersonId,
  } };
}
