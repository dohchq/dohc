import { z } from "zod";
import { ChangeAuthor, ChangeAuthorStatus, changeAuthorStatus } from "./changeAuthor";

export const WorkspaceSyncPause = z.object({
  atMs: z.number().int().nonnegative(), author: ChangeAuthor,
}).strict();
export type WorkspaceSyncPause = z.infer<typeof WorkspaceSyncPause>;

export const WorkspaceSyncPauseStatus = WorkspaceSyncPause.extend({ author: ChangeAuthorStatus });
export type WorkspaceSyncPauseStatus = z.infer<typeof WorkspaceSyncPauseStatus>;

export function workspaceSyncPauseStatus(
  pause: WorkspaceSyncPause,
  localPersonId: string | null,
): WorkspaceSyncPauseStatus {
  return { atMs: pause.atMs, author: changeAuthorStatus(pause.author, localPersonId) };
}
