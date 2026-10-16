import { z } from "zod";

// The server account this computer's dohc app is connected to. The desktop
// sends both requests with its own session, and only to the server the
// preview came from.

const count = z.number().int().nonnegative();

export const ServerAccountDeletionPreview = z.object({
  email: z.string().min(1),
  // The server address this computer connects to.
  server: z.string().min(1),
  // Owned workspaces this computer has, by their local folder name.
  workspaces: z.array(z.object({ workspaceId: z.string().min(1), name: z.string().min(1) }).strict()),
  // Owned workspaces this computer does not have.
  workspacesElsewhere: count,
  storedBytes: count,
  ownedShareCount: count,
  heldGrantCount: count,
  // Valid for five minutes. delete needs it with the account password.
  previewToken: z.string().min(1).max(512),
}).strict();
export type ServerAccountDeletionPreview = z.infer<typeof ServerAccountDeletionPreview>;

export const ServerAccountDeleteRequest = z.object({
  server: z.string().min(1),
  previewToken: z.string().min(1).max(512),
  password: z.string().min(1).max(1024),
}).strict();
export type ServerAccountDeleteRequest = z.infer<typeof ServerAccountDeleteRequest>;

// `finished` is false while the server still removes data. The account is
// blocked either way. `disconnectError` is null once this computer
// disconnected from it, or says why that failed.
export const ServerAccountDeleteResult = z.discriminatedUnion("ok", [
  z.object({
    ok: z.literal(true),
    finished: z.boolean(),
    email: z.string().min(1),
    server: z.string().min(1),
    disconnectError: z.string().min(1).nullable(),
  }).strict(),
  z.object({
    ok: z.literal(false),
    code: z.enum(["preview-changed", "wrong-password", "rate-limited"]),
    reason: z.string().min(1),
  }).strict(),
]);
export type ServerAccountDeleteResult = z.infer<typeof ServerAccountDeleteResult>;

const UNITS = ["KB", "MB", "GB", "TB"] as const;

export function formatStoredBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} ${bytes === 1 ? "byte" : "bytes"}`;
  let value = bytes / 1024;
  let unit = 0;
  while (value >= 1024 && unit < UNITS.length - 1) {
    value /= 1024;
    unit += 1;
  }
  return `${value < 10 ? value.toFixed(1) : Math.round(value)} ${UNITS[unit]}`;
}
