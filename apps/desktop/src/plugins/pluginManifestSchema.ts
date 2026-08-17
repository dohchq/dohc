import { z } from "zod";
import { DEFAULT_DRIVER_ID_MAX_LENGTH } from "@dohc/workspace-contracts/workspace-settings-values";

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

// One line of shelf copy, the length a list row can show and a reader can
// scan. Marketplace short descriptions run to about 200 characters; 280
// clears that with room and still fits one truncated row.
export const MAX_PLUGIN_DESCRIPTION_CHARS = 280;

// The same bound every other display name in this manifest carries.
export const MAX_PLUGIN_PUBLISHER_CHARS = 120;

// What the plugin calls this build, for a reader comparing what they have
// against what the author published. Display only: dohc never parses it,
// compares it, or requires semver, because dohc's own version-of-record is
// the approved content hash and a declared string cannot be trusted to order
// anything. 40 characters holds a semver core with a prerelease and build tag
// ("10.20.30-rc.1+build.20260817", 28) and every date-stamped scheme measured
// beside it, none of which reached 30.
export const MAX_PLUGIN_VERSION_CHARS = 40;

// A licence name, an SPDX id, or a short SPDX expression. The same bound every
// other display name in this manifest carries; the longest SPDX id in the
// current list is under 60 characters, so an expression joining two of them
// still fits.
export const MAX_PLUGIN_LICENSE_CHARS = 120;

// Exactly OpenExternalUrlPayload's own bound (bridgeContract.ts). A manifest
// URL exists to be opened, and the audited open path refuses a longer one — a
// looser cap here would accept a link that every click rejects.
export const MAX_PLUGIN_URL_CHARS = 2048;

/**
 * The one https test dohc applies to a plugin's declared links, asked by the
 * manifest schema, by the IPC contract that carries those links to the
 * renderer, and by the details rail that decides whether a licence is a link.
 *
 * https only. These URLs travel to the OS browser from a full-trust plugin's
 * own manifest, and http: would send the reader somewhere a network can
 * rewrite. isSafeExternalUrl also permits http: and mailto:, deliberately not
 * narrowed here — this is the tighter rule a manifest can afford.
 */
export function isHttpsUrl(value: string): boolean {
  try {
    return new URL(value).protocol === "https:";
  } catch {
    return false;
  }
}

const PluginHttpsUrl = z.string()
  .max(
    MAX_PLUGIN_URL_CHARS,
    `must be ${MAX_PLUGIN_URL_CHARS} characters or fewer`,
  )
  .refine(isHttpsUrl, "must be an https:// URL");

// The renderer serves the icon over dohc-file://, which types a file by its
// extension. These two are the raster and vector answers, and both are in
// that server's media-type table; anything else would serve as a download.
const PLUGIN_ICON_EXTENSIONS = ["png", "svg"] as const;

const PluginIconPath = PluginPath.refine(
  (path) =>
    PLUGIN_ICON_EXTENSIONS.some((extension) =>
      path.toLowerCase().endsWith(`.${extension}`)
    ),
  `icon: must be a .${PLUGIN_ICON_EXTENSIONS.join(" or .")} file`,
);

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
// An instanced web app opens one tab per runtime instance instead of one tab
// for the whole manifest id: a sites plugin previews each site in its own tab,
// over its own loopback origin. dohc holds no opinion about what an instance
// is — the plugin names it with an instance key, gets that key back in
// startWebApp, and serves whatever origin that instance needs. The flag is
// what tells dohc which of the two shapes an id uses, so an open that carries
// no key (the plugin page's Open button) and an open that carries one are each
// refused for the wrong id instead of quietly serving the wrong app.
const PluginWebApp = z.object({
  id: z.string().min(1).max(120).refine(
    (value) => !value.includes("\0"),
    "web app id must not contain NUL bytes",
  ),
  title: z.string().min(1).max(120),
  instanced: z.boolean().default(false),
}).strict();

// An agent driver this plugin contributes: one harness dohc can talk to,
// registered beside the built-in drivers and shown in the same probe list.
// Core ships three drivers for two harnesses, and a harness plugin declares
// one — plus, at most, a variant or two of that same harness (an adapter
// transport beside a native one). Eight leaves that measured shape room and
// still reads as a list. The workspace-wide registration cap, not this one,
// is what keeps the merged driver list inside the bound its IPC contract
// carries (pluginAgentDrivers.ts).
export const MAX_PLUGIN_DRIVERS = 8;

// A driver id names its driver in the driver registry, in the Settings probe
// list, and in `agents.defaultDriverId` — a workspace-settings string whose
// own bound is this one. The charset is the settings key's, because an id a
// person may type into a settings file should not need quoting.
const PluginDriverId = z.string()
  .min(1)
  .max(
    DEFAULT_DRIVER_ID_MAX_LENGTH,
    `must be ${DEFAULT_DRIVER_ID_MAX_LENGTH} characters or fewer`,
  )
  .regex(
    /^[A-Za-z0-9][A-Za-z0-9._-]*$/,
    "must start with a letter or digit and use only letters, digits, '.', '_', or '-'",
  );

// What a driver is called on screen. The same bound every other display name
// in this manifest carries, named because the IPC contract that carries this
// name to the renderer has to use the same one — a driver dohc lists must be
// a driver dohc can describe.
export const MAX_PLUGIN_DRIVER_NAME_CHARS = 120;

const PluginDriver = z.object({
  id: PluginDriverId,
  displayName: z.string().min(1).max(
    MAX_PLUGIN_DRIVER_NAME_CHARS,
    `must be ${MAX_PLUGIN_DRIVER_NAME_CHARS} characters or fewer`,
  ),
}).strict();

// A plugin's own settings, declared flat so dohc can render them without the
// plugin running. Twenty entries is a settings panel, not a preferences
// database; a plugin that needs more has outgrown a flat list and wants a
// panel of its own. Eight options is a select a reader can scan.
export const MAX_PLUGIN_SETTINGS = 20;
export const MAX_SETTING_OPTIONS = 8;
export const MAX_SETTING_VALUE_CHARS = 200;
const MAX_SETTING_OPTION_CHARS = 60;

const SettingKey = z.string()
  .min(1)
  .max(120, "must be 120 characters or fewer")
  .regex(
    /^[A-Za-z0-9][A-Za-z0-9._-]*$/,
    "must start with a letter or digit and use only letters, digits, '.', '_', or '-'",
  );

const SettingLabel = z.string().min(1).max(120, "must be 120 characters or fewer");
const SettingDescription = z.string()
  .min(1)
  .max(
    MAX_PLUGIN_DESCRIPTION_CHARS,
    `description: must be ${MAX_PLUGIN_DESCRIPTION_CHARS} characters or fewer`,
  )
  .optional();
const SettingText = z.string().max(
  MAX_SETTING_VALUE_CHARS,
  `must be ${MAX_SETTING_VALUE_CHARS} characters or fewer`,
);

// A discriminated union rather than one loose object: the type decides what a
// default may be, and a select is the only type that carries options. Nothing
// here has to check that a boolean setting did not ship a string default.
const PluginSetting = z.discriminatedUnion("type", [
  z.object({
    key: SettingKey,
    type: z.literal("string"),
    label: SettingLabel,
    description: SettingDescription,
    default: SettingText,
  }).strict(),
  z.object({
    key: SettingKey,
    type: z.literal("boolean"),
    label: SettingLabel,
    description: SettingDescription,
    default: z.boolean(),
  }).strict(),
  z.object({
    key: SettingKey,
    type: z.literal("number"),
    label: SettingLabel,
    description: SettingDescription,
    // Finite: NaN and Infinity do not survive JSON, so a manifest that
    // declared one would store a default the file cannot hold.
    default: z.number().finite("must be a finite number"),
  }).strict(),
  z.object({
    key: SettingKey,
    type: z.literal("select"),
    label: SettingLabel,
    description: SettingDescription,
    default: z.string().min(1).max(
      MAX_SETTING_OPTION_CHARS,
      `must be ${MAX_SETTING_OPTION_CHARS} characters or fewer`,
    ),
    options: z.array(
      z.string().min(1).max(
        MAX_SETTING_OPTION_CHARS,
        `must be ${MAX_SETTING_OPTION_CHARS} characters or fewer`,
      ),
    )
      .min(1, "options: at least 1 entry required")
      .max(
        MAX_SETTING_OPTIONS,
        `options: at most ${MAX_SETTING_OPTIONS} entries allowed`,
      ),
  }).strict().superRefine((setting, ctx) => {
    if (!setting.options.includes(setting.default)) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["default"],
        message: `select default "${setting.default}" must be one of its options`,
      });
    }
    if (new Set(setting.options).size !== setting.options.length) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["options"],
        message: "options must be unique",
      });
    }
  }),
]);

/** Shared with the IPC contract, which carries declarations to the renderer. */
export const PluginSettingDeclarationSchema = PluginSetting;
export type PluginSettingDeclaration = z.infer<typeof PluginSetting>;
export type PluginSettingValue = string | number | boolean;

/** The value shape a stored answer may take, for the IPC contract. */
export const PluginSettingValueSchema = z.union([
  z.string().max(MAX_SETTING_VALUE_CHARS),
  z.boolean(),
  z.number().finite(),
]);

export const DohcPluginManifest = z.object({
  version: z.literal(1),
  name: NpmPackageName,
  displayName: z.string().min(1).max(120).optional(),
  // What the plugin is, in one line, for a reader deciding whether to install
  // it. Who publishes it, and the icon that stands for it in a list.
  description: z.string()
    .min(1)
    .max(
      MAX_PLUGIN_DESCRIPTION_CHARS,
      `description: must be ${MAX_PLUGIN_DESCRIPTION_CHARS} characters or fewer`,
    )
    .optional(),
  publisher: z.string()
    .min(1)
    .max(
      MAX_PLUGIN_PUBLISHER_CHARS,
      `publisher: must be ${MAX_PLUGIN_PUBLISHER_CHARS} characters or fewer`,
    )
    .optional(),
  icon: PluginIconPath.optional(),
  // What the plugin says about itself that dohc cannot work out on its own:
  // the version it calls this build, where its source and its issues live, and
  // what it is licensed under. Every one is optional and every one is shown
  // only where it was declared — the details rail drops the row rather than
  // print an empty one, because a blank field reads as a fact dohc lost.
  pluginVersion: z.string()
    .min(1)
    .max(
      MAX_PLUGIN_VERSION_CHARS,
      `pluginVersion: must be ${MAX_PLUGIN_VERSION_CHARS} characters or fewer`,
    )
    .optional(),
  repository: PluginHttpsUrl.optional(),
  issues: PluginHttpsUrl.optional(),
  license: z.string()
    .min(1)
    .max(
      MAX_PLUGIN_LICENSE_CHARS,
      `license: must be ${MAX_PLUGIN_LICENSE_CHARS} characters or fewer`,
    )
    .optional(),
  entry: PluginPath,
  // These bounds do not add up to the reader's 256 KiB file cap, and are not
  // meant to: 100 panels at a 1,024-character entry path spend half of it on
  // their own. readPluginManifestFile checks the file's size before it parses
  // anything, so a manifest at every bound is refused by size, with the cap
  // named — the byte gate is the real limit, and each bound below only has to
  // be right for its own field. pluginManifestSchema.test.ts measures both
  // ends of that relationship, so this note cannot drift the way a hand-summed
  // byte count did.
  panels: z.array(PluginPanel)
    .max(100, "panels: at most 100 entries allowed")
    .optional(),
  commands: z.array(PluginCommand)
    .max(200, "commands: at most 200 entries allowed")
    .optional(),
  webApps: z.array(PluginWebApp)
    .max(100, "webApps: at most 100 entries allowed")
    .optional(),
  drivers: z.array(PluginDriver)
    .max(
      MAX_PLUGIN_DRIVERS,
      `drivers: at most ${MAX_PLUGIN_DRIVERS} entries allowed`,
    )
    .optional(),
  settings: z.array(PluginSetting)
    .max(
      MAX_PLUGIN_SETTINGS,
      `settings: at most ${MAX_PLUGIN_SETTINGS} entries allowed`,
    )
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

  const driverIds = new Set<string>();
  manifest.drivers?.forEach((driver, index) => {
    if (driverIds.has(driver.id)) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["drivers", index, "id"],
        message: `driver id "${driver.id}" must be unique within drivers`,
      });
    }
    driverIds.add(driver.id);
  });

  const settingKeys = new Set<string>();
  manifest.settings?.forEach((setting, index) => {
    if (settingKeys.has(setting.key)) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["settings", index, "key"],
        message: `setting key "${setting.key}" must be unique within settings`,
      });
    }
    settingKeys.add(setting.key);
  });
});
export type DohcPluginManifest = z.infer<typeof DohcPluginManifest>;
