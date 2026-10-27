import { z } from "zod";
import { AgentLaunch, launchCommand } from "../agents/agentToolCatalog";
import type { PreferredName } from "@dohc/workspace-contracts/chat-identity";
import {
  MAX_PREFERRED_NAME_LENGTH,
  hasPreferredNameControlCharacters,
} from "@dohc/workspace-contracts/chat-identity-values";
import { AGENT_HUE_ASSIGNMENT_ORDER, AGENT_HUES, IDENTITY_HUES, type AgentHue, type IdentityHue } from "../renderer/tokens";
import { VIEW_IDS } from "../renderer/workbench/workbenchState";
import { IgnoredSettings } from "./settingsFile";
import { handleForName, normalizeHandle, scanMentionTokens, type MentionCandidate } from "@dohc/workspace-contracts/chat-mentions";

const PreferredNameForIpc = z
  .string()
  .trim()
  .min(1, "Enter the name your agent should use.")
  .max(
    MAX_PREFERRED_NAME_LENGTH,
    `Names must contain ${MAX_PREFERRED_NAME_LENGTH} characters or fewer.`,
  )
  .refine((value) => !hasPreferredNameControlCharacters(value), {
    message: "Names cannot contain control characters.",
  }) satisfies z.ZodType<PreferredName>;

const THEME_MODES = ["system", "light", "dark"] as const;
export type ThemeMode = (typeof THEME_MODES)[number];

// A color a person types into the file, such as "#3a7ee9". dohc adjusts it
// per theme so text on it stays readable (renderer/accentColor.ts).
const HexColor = z.string().regex(/^#[0-9a-fA-F]{6}$/);

// The editor's type: one of dohc's three bundled stacks, or the name of a
// font installed on this computer. The name becomes a quoted CSS family, so
// it holds only letters, digits, spaces, dots, dashes, and underscores.
export const EDITOR_FONTS = ["sans", "serif", "mono"] as const;
const InstalledFontName = z.string().max(100)
  .regex(/^[\p{L}\p{N}](?:[\p{L}\p{N} ._-]*[\p{L}\p{N}])?$/u);

// Window zoom, stored as a Chromium zoom level like VS Code's
// window.zoomLevel: each step scales the window by 20% (factor 1.2^level).
export const MIN_ZOOM_LEVEL = -5;
export const MAX_ZOOM_LEVEL = 5;
export const DEFAULT_ZOOM_LEVEL = 0;

export function clampZoomLevel(level: number): number {
  if (!Number.isFinite(level)) return DEFAULT_ZOOM_LEVEL;
  return Math.min(MAX_ZOOM_LEVEL, Math.max(MIN_ZOOM_LEVEL, Math.round(level)));
}

export function zoomPercent(level: number): number {
  return Math.round(100 * Math.pow(1.2, level));
}

export const MIN_EDITOR_FONT_SIZE = 11;
export const MAX_EDITOR_FONT_SIZE = 24;

export const ZOOM_STEPS = ["in", "out", "reset"] as const;
export type ZoomStep = (typeof ZOOM_STEPS)[number];

// The first agent's id. The version 1 migration gives it to the one agent that
// version kept, and Settings to the first agent a person adds, so saving it
// twice before the first save returns still makes one agent.
export const DEFAULT_AGENT_ID = "default";
// Agents are kept by id, so a mistake in one entry turns off only that agent.
// An id starts with a letter, so the agents keep the order the file lists them in.
// Its dashes are single and inside it, so its chat's slug keeps the id as it is.
export const AgentId = z.string().regex(/^(?=.{1,64}$)[a-z](?:-?[a-z0-9])*$/, "An agent's id is up to 64 lowercase letters, digits and single dashes, starting with a letter and not ending with a dash.")
  .refine((id) => id !== "dohc-mcp", "dohc-mcp stands for agents that give no name. Give this agent another id.");

export const AgentSettings = z.object({
  name: PreferredNameForIpc,
  hue: z.enum(AGENT_HUES),
  // How dohc starts the agent. Without one dohc never starts it, and its name
  // and hue still mark what it posts from outside dohc.
  launch: AgentLaunch.optional(),
  changesFiles: z.boolean().default(true),
  // Pause and Resume. dohc starts only an enabled agent.
  enabled: z.boolean(),
  timeoutMinutes: z.number().int().min(1).max(1440).default(30),
  // The name this agent's messages carried before agents had ids. Only the
  // migration writes it, so those messages stay this agent's after a rename.
  nameBeforeMigration: PreferredNameForIpc.optional(),
}).strict().refine((agent) => agent.launch !== undefined || !agent.enabled, {
  message: "Choose how dohc starts this agent before turning it on.",
  path: ["enabled"],
});
export type AgentSettings = z.infer<typeof AgentSettings>;
export type Agent = AgentSettings & { id: string };

// Names with one handle name the same agent in a chat. A name with no handle
// names no agent, so it only has to differ from the other names.
const nameKey = (name: string) => normalizeHandle(agentHandle(name) || name);
// Each agent's name, and the name the default agent's messages had before
// agents had ids, so an old message names one agent.
function agentNameKeys(agents: Record<string, AgentSettings>): string[] {
  return Object.values(agents).flatMap(({ name, nameBeforeMigration }) =>
    [...new Set([name, nameBeforeMigration ?? name].map(nameKey))]);
}
export const AgentsSettings = z.record(AgentId, AgentSettings)
  .refine((agents) => new Set(agentNameKeys(agents)).size === agentNameKeys(agents).length, {
    message: "Give each agent its own name.",
  })
  .refine((agents) => Object.entries(agents).every(([id, agent]) => id === DEFAULT_AGENT_ID || agent.nameBeforeMigration === undefined), {
    message: "Only the default agent keeps a name from before agents had ids.",
  });
export type AgentsSettings = z.infer<typeof AgentsSettings>;

export function listAgents(settings: Pick<DesktopUserSettings, "agents">): Agent[] {
  return Object.entries(settings.agents).map(([id, agent]) => ({ id, ...agent }));
}

// Until a chat names its agent, the first agent answers it.
export function firstAgent(settings: Pick<DesktopUserSettings, "agents">): Agent | null {
  return listAgents(settings)[0] ?? null;
}

export type AgentWithLaunch = Agent & { launch: AgentLaunch };
/** The agents dohc starts: each one that is on and has a way to start. */
export function runnableAgents(settings: Pick<DesktopUserSettings, "agents">): AgentWithLaunch[] {
  return listAgents(settings).flatMap((agent) =>
    agent.enabled && agent.launch ? [{ ...agent, launch: agent.launch }] : []);
}

/** The first agent when dohc can start it, else null. */
export function firstAgentWithLaunch(settings: Pick<DesktopUserSettings, "agents">): AgentWithLaunch | null {
  const agent = firstAgent(settings);
  return agent?.launch ? { ...agent, launch: agent.launch } : null;
}

/**
 * Your agent that posted as `name`, for a message your own person wrote.
 * The default agent also keeps the name its messages had before agents had
 * ids. Another person's message never reaches here: whose it is comes first.
 */
export function ownAgentNamed(settings: Pick<DesktopUserSettings, "agents">, name: string): Agent | null {
  const agents = listAgents(settings);
  return agents.find((agent) => agent.name === name)
    ?? agents.find((agent) => agent.id === DEFAULT_AGENT_ID && agent.nameBeforeMigration === name)
    ?? null;
}

// A message names one of your agents with @ and its name's handle: the name
// without spaces or the punctuation a handle cannot hold. "" names no agent.
export function agentHandle(name: string): string {
  return handleForName(name);
}

// The @ roster's id for one of your agents.
export function agentMentionId(agentId: string): string {
  return `agent:${agentId}`;
}

// The @ roster's entries for your agents that are on and have a handle.
export function agentMentionCandidates(agents: readonly Pick<Agent, "id" | "name" | "enabled">[]): MentionCandidate[] {
  return agents.flatMap((agent) => {
    const handle = agentHandle(agent.name);
    return agent.enabled && handle
      ? [{ id: agentMentionId(agent.id), kind: "agent" as const, handle, label: agent.name, description: "your agent" }]
      : [];
  });
}

/**
 * The agents dohc can start that a message names, in any case, outside
 * code. A message wakes each one it names, so only your own messages read
 * your agents' names.
 */
export function agentIdsNamedIn(settings: Pick<DesktopUserSettings, "agents">, body: string): string[] {
  const named = new Set(scanMentionTokens(body, { ignoreCode: true }).map(({ handle }) => normalizeHandle(handle)));
  return listAgents(settings)
    .filter((agent) => {
      const handle = agentHandle(agent.name);
      return agent.launch && handle && named.has(normalizeHandle(handle));
    })
    .map(({ id }) => id);
}

/** The command that starts the first agent, or "" when there is none. */
export function firstAgentCommand(settings: Pick<DesktopUserSettings, "agents">): string {
  const launch = firstAgent(settings)?.launch;
  return launch ? launchCommand(launch) : "";
}

/** The settings with one agent changed. */
export function withAgent(
  settings: DesktopUserSettings,
  id: string,
  change: (agent: AgentSettings) => AgentSettings,
): DesktopUserSettings {
  const agent = settings.agents[id];
  return agent ? { ...settings, agents: { ...settings.agents, [id]: change(agent) } } : settings;
}

/** The settings with the first agent changed, or a first agent added when there is none. */
export function withFirstAgent(
  settings: DesktopUserSettings,
  change: (current: AgentSettings | null) => AgentSettings,
): DesktopUserSettings {
  const id = Object.keys(settings.agents)[0];
  return { ...settings, agents: { ...settings.agents, [id ?? DEFAULT_AGENT_ID]: change(id === undefined ? null : settings.agents[id]!) } };
}

/** What a new agent starts with: the first free hue, and off until the person turns it on. */
export function newAgentDefaults(
  settings: Pick<DesktopUserSettings, "agents">,
  yourHue: IdentityHue | null,
): Omit<AgentSettings, "name" | "launch"> {
  return { hue: newAgentHue(settings.agents, yourHue), changesFiles: true, enabled: false, timeoutMinutes: 30 };
}

/** The hue your agents and you use least, first in the assignment order, so a new agent takes the first free one. */
export function newAgentHue(agents: AgentsSettings, yourHue: IdentityHue | null): AgentHue {
  const uses = (hue: AgentHue) => Object.values(agents).filter((agent) => agent.hue === hue).length + (hue === yourHue ? 1 : 0);
  return AGENT_HUE_ASSIGNMENT_ORDER.reduce((least, hue) => (uses(hue) < uses(least) ? hue : least));
}

// An agent entry dohc could not use, so Settings can still show it.
export const AgentProblem = z.object({
  id: z.string().max(200),
  name: z.string().max(200).optional(),
  problem: z.string().min(1).max(500),
}).strict();
export type AgentProblem = z.infer<typeof AgentProblem>;

// Pins are kept per workspace, by workspace id, because an app is a folder in
// one workspace. They live in this file, not the workspace, because a pin is
// one person's choice on one computer: a collaborator never sees it.
export const MAX_PINNED_APPS = 20;
const MAX_PINNED_WORKSPACES = 200;
const PinnedAppsWorkspaceId = z.string().max(200).regex(/^[a-z0-9][a-z0-9-]*$/);

export const SidebarSettings = z.object({
  // dohc's own views in the order the sidebar shows them. A view the list
  // leaves out follows in dohc's order, so a new view still appears.
  order: z.array(z.enum(VIEW_IDS)).max(VIEW_IDS.length),
  hidden: z.array(z.enum(VIEW_IDS)).max(VIEW_IDS.length),
  // Each workspace's pinned apps, by the app's folder in that workspace.
  pinnedApps: z
    .record(PinnedAppsWorkspaceId, z.array(z.string().min(1).max(4096)).max(MAX_PINNED_APPS))
    .refine((pins) => Object.keys(pins).length <= MAX_PINNED_WORKSPACES, {
      message: `Pin apps in ${MAX_PINNED_WORKSPACES} workspaces or fewer.`,
    }),
}).strict();
export type SidebarSettings = z.infer<typeof SidebarSettings>;

export const DEFAULT_SIDEBAR_SETTINGS: SidebarSettings = {
  order: [],
  hidden: [],
  pinnedApps: {},
};

// Reports this computer sends to dohc's developers. A release build that
// names a report service sends them until the person turns them off; other
// builds send nothing. See telemetry/reportingConfig.ts.
export const PrivacySettings = z.object({
  usageReports: z.boolean(),
  errorReports: z.boolean(),
}).strict();
export type PrivacySettings = z.infer<typeof PrivacySettings>;

export const DEFAULT_PRIVACY_SETTINGS: PrivacySettings = {
  usageReports: true,
  errorReports: true,
};

export const DesktopUserSettings = z.object({
  version: z.literal(2),
  // Added after the original v1 settings shipped. The default makes old v1
  // files migrate in place instead of failing the strict top-level parse and
  // resetting unrelated preferences.
  profile: z.object({
    preferredName: PreferredNameForIpc.optional(),
  }).strict().default({}),
  appearance: z.object({
    themeMode: z.enum(THEME_MODES),
    // Added after appearance shipped. The default migrates stored files in
    // place instead of failing the strict parse and resetting preferences.
    zoomLevel: z.number().int().min(MIN_ZOOM_LEVEL).max(MAX_ZOOM_LEVEL)
      .default(DEFAULT_ZOOM_LEVEL),
    // null is dohc's own accent.
    accentColor: HexColor.nullable().default(null),
    // How this computer shows you in chat. It is not part of your identity:
    // every viewer picks each person's color itself, so a collaborator still
    // sees the color their computer picks for you. null is the hue dohc picks
    // from your name.
    yourColor: z.enum(IDENTITY_HUES).nullable().default(null),
  }).strict(),
  editor: z.object({
    fontFamily: z.union([z.enum(EDITOR_FONTS), InstalledFontName]).default("sans"),
    fontSize: z.number().int().min(MIN_EDITOR_FONT_SIZE).max(MAX_EDITOR_FONT_SIZE),
    lineWrap: z.boolean(),
    spellcheck: z.boolean(),
  }).strict(),
  agents: AgentsSettings.default({}),
  sidebar: SidebarSettings.default(DEFAULT_SIDEBAR_SETTINGS),
  privacy: PrivacySettings.default(DEFAULT_PRIVACY_SETTINGS),
}).strict();
export type DesktopUserSettings = z.infer<typeof DesktopUserSettings>;

export const DEFAULT_USER_SETTINGS: DesktopUserSettings = {
  version: 2,
  profile: {},
  appearance: {
    themeMode: "system",
    zoomLevel: DEFAULT_ZOOM_LEVEL,
    accentColor: null,
    yourColor: null,
  },
  editor: {
    fontFamily: "sans",
    fontSize: 15,
    lineWrap: true,
    spellcheck: true,
  },
  agents: {},
  sidebar: DEFAULT_SIDEBAR_SETTINGS,
  privacy: DEFAULT_PRIVACY_SETTINGS,
};

// Main-only settings. Actor keys never cross the renderer boundary.
export const AgentColors = z.record(z.string().refine(key => new TextEncoder().encode(key).byteLength <= 2048), z.enum(IDENTITY_HUES))
  .refine(colors => Object.keys(colors).length <= 256);
export type AgentColors = z.infer<typeof AgentColors>;
export const StoredUserSettings = DesktopUserSettings.safeExtend({
  appearance: DesktopUserSettings.shape.appearance.extend({ agentColors: AgentColors.optional() }),
});
export type StoredUserSettings = z.infer<typeof StoredUserSettings>;

export const SETTINGS_READ_SOURCES = ["stored", "default", "recovered"] as const;

export const DesktopUserSettingsResult = z.object({
  settings: DesktopUserSettings,
  source: z.enum(SETTINGS_READ_SOURCES),
  // Names the file, so it is bounded above a full path.
  warning: z.string().min(1).max(4600).optional(),
  ignored: IgnoredSettings.optional(),
  agentProblems: z.array(AgentProblem).min(1).max(50).optional(),
}).strict();
export type DesktopUserSettingsResult = z.infer<typeof DesktopUserSettingsResult>;

export const StoredUserSettingsResult = DesktopUserSettingsResult.extend({ settings: StoredUserSettings });
export type StoredUserSettingsResult = z.infer<typeof StoredUserSettingsResult>;

export function rendererUserSettingsResult(result: StoredUserSettingsResult): DesktopUserSettingsResult {
  const { agentColors: _private, ...appearance } = result.settings.appearance;
  return DesktopUserSettingsResult.parse({
    ...result, settings: { ...result.settings, appearance },
    ignored: result.ignored?.length ? result.ignored : undefined,
    agentProblems: result.agentProblems?.length ? result.agentProblems : undefined,
  });
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export function settingsDeepEqual(left: unknown, right: unknown): boolean {
  if (Object.is(left, right)) return true;
  if (Array.isArray(left) || Array.isArray(right)) {
    if (!Array.isArray(left) || !Array.isArray(right)) return false;
    if (left.length !== right.length) return false;
    return left.every((value, index) => settingsDeepEqual(value, right[index]));
  }
  if (isRecord(left) || isRecord(right)) {
    if (!isRecord(left) || !isRecord(right)) return false;
    const leftKeys = Object.keys(left);
    const rightKeys = Object.keys(right);
    if (leftKeys.length !== rightKeys.length) return false;
    return leftKeys.every((key) =>
      Object.prototype.hasOwnProperty.call(right, key) &&
      settingsDeepEqual(left[key], right[key]),
    );
  }
  return false;
}

export function effectiveThemeMode(
  mode: ThemeMode,
  prefersDark: boolean,
): "light" | "dark" {
  return mode === "system" ? (prefersDark ? "dark" : "light") : mode;
}
