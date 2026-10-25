import { AgentLaunchProfile } from "../agents/agentToolCatalog";
import { IDENTITY_HUES } from "../renderer/tokens";
import { isSettingsObject } from "./settingsFile";
import { AgentSettings, DEFAULT_AGENT_ID } from "./userSettings";

// What a version 1 agent's messages carried when it had no name.
const VERSION_1_AGENT_NAME = "Agent";

function without(value: unknown, key: string): unknown {
  if (!isSettingsObject(value)) return value;
  const { [key]: _removed, ...rest } = value;
  return rest;
}

// Version 1 kept one agent in profile.agentName, appearance.yourAgentColor
// and runner. It becomes the `default` agent when version 1 could start it,
// or named or colored what it posts from outside dohc.
function version1Agent(raw: Record<string, unknown>): Record<string, unknown> | null {
  const runner = isSettingsObject(raw.runner) ? raw.runner : {};
  const profile = AgentLaunchProfile.safeParse(runner.profile);
  const command = typeof runner.command === "string" ? runner.command.trim() : "";
  const launch = profile.success ? profile.data : command ? { command } : null;
  const name = AgentSettings.shape.name.safeParse(isSettingsObject(raw.profile) ? raw.profile.agentName : undefined);
  const yourAgentColor = isSettingsObject(raw.appearance) ? raw.appearance.yourAgentColor : undefined;
  const hue = IDENTITY_HUES.find((hue) => hue === yourAgentColor);
  if (!launch && !name.success && !hue) return null;
  const timeoutMinutes = AgentSettings.shape.timeoutMinutes.safeParse(runner.timeoutMinutes);
  const oldName = name.success ? name.data : VERSION_1_AGENT_NAME;
  return {
    name: oldName,
    hue: hue ?? "olive",
    ...(launch ? { launch } : {}),
    changesFiles: true,
    // Version 1 dispatched only with a name to post as.
    enabled: runner.enabled === true && name.success && launch !== null,
    timeoutMinutes: timeoutMinutes.success ? timeoutMinutes.data : 30,
    nameBeforeMigration: oldName,
  };
}

/** A version 1 settings file as version 2. Every other key stays as the person wrote it. */
export function migrateVersion1(raw: Record<string, unknown>): Record<string, unknown> {
  const agent = version1Agent(raw);
  const agents = raw.agents === undefined ? {} : raw.agents;
  // Agents the person wrote in the file stay. When the version 1 agent has
  // no place among them, its keys stay too, so a save cannot lose it.
  if (agent && (!isSettingsObject(agents) || Object.hasOwn(agents, DEFAULT_AGENT_ID))) return { ...raw, version: 2 };
  const { runner: _runner, ...rest } = raw;
  return {
    ...rest,
    version: 2,
    ...("profile" in raw ? { profile: without(raw.profile, "agentName") } : {}),
    ...("appearance" in raw ? { appearance: without(raw.appearance, "yourAgentColor") } : {}),
    ...(agent ? { agents: { [DEFAULT_AGENT_ID]: agent, ...agents } } : {}),
  };
}
