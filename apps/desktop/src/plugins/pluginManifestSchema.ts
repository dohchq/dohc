import { z } from "zod";

export const NPM_PACKAGE_NAME = /^(?:@[a-z0-9~-][a-z0-9._~-]*\/)?[a-z0-9~-][a-z0-9._~-]*$/;

// Run 2's largest representative lockfile contained 209 package entries.
// The array form leaves measured headroom for 300 named overrides. Authors
// with a larger reviewed set can use `true` instead of a rejection-prone list.
const MAX_SKIPPED_SCRIPT_OVERRIDES = 300;

const NpmPackageName = z.string()
  .max(214)
  .regex(
    NPM_PACKAGE_NAME,
    "must use lowercase npm package name syntax, with optional @scope/ prefix",
  );

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

// A wrapper plugin's embedded web app: served by a plugin-brokered server at
// a loopback origin and shown in a hardened main-process WebContentsView with
// its own per-workspace-per-plugin storage partition — never a renderer
// webview tag, never a plain iframe. The URL comes from the running plugin
// (PluginHandler.startWebApp), not the manifest, because it exists only once
// the plugin's server is ready.
const PluginWebApp = z.object({
  id: z.string().min(1).max(120).refine(
    (value) => !value.includes("\0"),
    "web app id must not contain NUL bytes",
  ),
  title: z.string().min(1).max(120),
}).strict();

export const DohcPluginManifest = z.object({
  version: z.literal(1),
  name: NpmPackageName,
  displayName: z.string().min(1).max(120).optional(),
  entry: PluginPath,
  // For ordinary UTF-8 content, compact JSON at these bounds is 77 + 214 +
  // 120 + 1,024 + (100 × 1,295 + 99) + (200 × 260 + 199) + (100 × 260 + 99)
  // = 209,332 bytes, 52,812 below the reader's 262,144-byte cap. The
  // optional skipped-script
  // override adds at most 300 package names. A string built almost
  // entirely from characters JSON must escape (e.g. `"`, `\`) can inflate
  // past that on paper; the reader's byte-size gate — not this schema — is
  // what safely rejects an oversize file before parsing either way.
  panels: z.array(PluginPanel)
    .max(100, "panels: at most 100 entries allowed")
    .optional(),
  commands: z.array(PluginCommand)
    .max(200, "commands: at most 200 entries allowed")
    .optional(),
  webApps: z.array(PluginWebApp)
    .max(100, "webApps: at most 100 entries allowed")
    .optional(),
  allowSkippedScripts: z.union([
    z.literal(true),
    z.array(NpmPackageName).max(
      MAX_SKIPPED_SCRIPT_OVERRIDES,
      `allowSkippedScripts: at most ${MAX_SKIPPED_SCRIPT_OVERRIDES} package names allowed`,
    ),
  ]).optional(),
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

  const webAppIds = new Set<string>();
  manifest.webApps?.forEach((webApp, index) => {
    if (webAppIds.has(webApp.id)) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["webApps", index, "id"],
        message: `web app id "${webApp.id}" must be unique within webApps`,
      });
    }
    webAppIds.add(webApp.id);
  });
});
export type DohcPluginManifest = z.infer<typeof DohcPluginManifest>;
