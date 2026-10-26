import { DEFAULT_USER_SETTINGS, type AgentSettings, type DesktopUserSettings } from "../settings/userSettings";

/** An agent for tests: on, olive, started by a command. */
export function testAgent(fields: Partial<AgentSettings> = {}): AgentSettings {
  return { name: "Agent", hue: "olive", launch: { command: "node agent.mjs" }, changesFiles: true, enabled: true, timeoutMinutes: 30, ...fields };
}

/** `settings` whose only agent is `testAgent(fields)`. */
export function settingsWithAgent(fields: Partial<AgentSettings> = {}, settings: DesktopUserSettings = DEFAULT_USER_SETTINGS): DesktopUserSettings {
  return { ...settings, agents: { default: testAgent(fields) } };
}
