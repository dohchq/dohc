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

const PluginPath = z.string().transform((path, ctx) => {
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
  id: z.string().min(1).max(120),
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
  panels: z.array(PluginPanel).optional(),
  commands: z.array(PluginCommand).optional(),
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
