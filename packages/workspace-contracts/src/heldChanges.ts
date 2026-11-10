import { z } from "zod";

const path = z.string().min(1).max(4096);

// A save the engine holds because writing it would rewrite Markdown dohc can't
// show. `file` is the file's text on disk, or null when there is no file;
// `held` is what saving the waiting change would write. A change past the
// engine's response cap reports only `tooLarge`. `unavailable` says why the
// engine can't reproduce the save's text, so it shows none.
export const HeldChangeUnavailable = z.enum(["waitingForSync", "fileUnreadable", "unsupported"]);
export type HeldChangeUnavailable = z.infer<typeof HeldChangeUnavailable>;
export const HeldChange = z.union([
  z.object({ path, file: z.string().nullable(), held: z.string() }).strict(),
  z.object({ path, tooLarge: z.literal(true) }).strict(),
  z.object({ path, unavailable: HeldChangeUnavailable }).strict(),
]);
export type HeldChange = z.infer<typeof HeldChange>;
