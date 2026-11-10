import { z } from "zod";

const path = z.string().min(1).max(4096);

// A save the engine holds because writing it would rewrite Markdown dohc can't
// show. `file` is what the file holds now, or null when it holds nothing;
// `held` is what saving the waiting change would write. A change past the
// engine's response cap reports only `tooLarge`.
export const HeldChange = z.union([
  z.object({ path, file: z.string().nullable(), held: z.string() }).strict(),
  z.object({ path, tooLarge: z.literal(true) }).strict(),
]);
export type HeldChange = z.infer<typeof HeldChange>;
