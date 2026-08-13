import { z } from "zod";

const NPM_PACKAGE_NAME = /^(?:@[a-z0-9~-][a-z0-9._~-]*\/)?[a-z0-9~-][a-z0-9._~-]*$/;

function normalizePluginPath(path: string): string | null {
  if (
    path.includes("\0") ||
    path.startsWith("/") ||
    path.startsWith("\\") ||
    /^[A-Za-z]:/.test(path)
  ) {
    return null;
  }
  const segments = path
    .replaceAll("\\", "/")
    .split("/")
    .filter((segment) => segment !== "" && segment !== ".");
  if (segments.some((segment) => segment === "..")) return null;
  const normalized = segments.join("/");
  return normalized === "" ? null : normalized;
}

const PluginPath = z.string()
  .max(1024, "must be 1024 characters or fewer")
  .transform((path, ctx) => {
    const normalized = normalizePluginPath(path);
    if (normalized !== null) return normalized;
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      message:
        "must be a non-empty plugin-root-relative path without NUL bytes, absolute prefixes, or '..' segments",
    });
    return z.NEVER;
  });

const PluginPanel = z.object({
  id: z.string().min(1).max(120).refine(
    (value) => !value.includes("\0"),
    "panel id must not contain NUL bytes",
  ),
  title: z.string().min(1).max(120),
  entry: PluginPath,
}).strict();

const PluginCommand = z.object({
  id: z.string().min(1).max(120),
  title: z.string().min(1).max(120),
}).strict();

export const DohcPluginManifest = z.object({
  version: z.literal(1),
  name: z.string()
    .min(1)
    .max(214)
    .regex(
      NPM_PACKAGE_NAME,
      "must use lowercase npm package name syntax, with optional @scope/ prefix",
    ),
  displayName: z.string().min(1).max(120).optional(),
  entry: PluginPath,
  // For ordinary UTF-8 content, compact JSON at these bounds is 77 + 214 +
  // 120 + 1,024 + (100 × 1,295 + 99) + (200 × 260 + 199) = 183,233 bytes,
  // 78,911 below the reader's 262,144-byte cap. A string built almost
  // entirely from characters JSON must escape (e.g. `"`, `\`) can inflate
  // past that on paper; the reader's byte-size gate — not this schema — is
  // what safely rejects an oversize file before parsing either way.
  panels: z.array(PluginPanel)
    .max(100, "panels: at most 100 entries allowed")
    .optional(),
  commands: z.array(PluginCommand)
    .max(200, "commands: at most 200 entries allowed")
    .optional(),
}).strict().superRefine((manifest, ctx) => {
  const panelIds = new Set<string>();
  manifest.panels?.forEach((panel, index) => {
    if (panelIds.has(panel.id)) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["panels", index, "id"],
        message: `panel id "${panel.id}" must be unique within panels`,
      });
    }
    panelIds.add(panel.id);
  });

  const commandIds = new Set<string>();
  manifest.commands?.forEach((command, index) => {
    if (commandIds.has(command.id)) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["commands", index, "id"],
        message: `command id "${command.id}" must be unique within commands`,
      });
    }
    commandIds.add(command.id);
  });
});
export type DohcPluginManifest = z.infer<typeof DohcPluginManifest>;
