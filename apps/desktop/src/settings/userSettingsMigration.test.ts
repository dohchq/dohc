import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { DEFAULT_USER_SETTINGS } from "./userSettings";
import { migrateVersion1 } from "./userSettingsMigration";
import { readUserSettingsFile, USER_SETTINGS_FILE, writeUserSettingsFile } from "./userSettingsStore";
import { testAgent } from "../testing/agentSettings";
import { createTestScratch } from "../workspaces/testTemp";

const claude = { tool: "claude" as const, executable: "C:\\Tools\\claude.exe" };

describe("version 1 settings", () => {
  it("makes the one agent the default agent, with the color it shows today", () => {
    expect(migrateVersion1({
      version: 1,
      profile: { preferredName: "Sam", agentName: "Nova" },
      appearance: { themeMode: "dark", yourColor: "teal", yourAgentColor: "plum" },
      runner: { enabled: true, command: "\"C:\\Tools\\claude.exe\" -p", profile: claude, timeoutMinutes: 45 },
      wallpaper: "teal",
    })).toEqual({
      version: 2,
      profile: { preferredName: "Sam" },
      appearance: { themeMode: "dark", yourColor: "teal" },
      agents: {
        default: {
          name: "Nova", hue: "plum", launch: claude, changesFiles: true, enabled: true,
          timeoutMinutes: 45, nameBeforeMigration: "Nova",
        },
      },
      wallpaper: "teal",
    });
  });

  it("keeps a typed command, and names an unnamed agent the way its messages were", () => {
    expect(migrateVersion1({ version: 1, runner: { enabled: true, command: "  node agent.mjs  ", timeoutMinutes: 30 } }).agents).toEqual({
      // Version 1 did not dispatch without a name, so the agent stays off.
      default: testAgent({ enabled: false, nameBeforeMigration: "Agent" }),
    });
  });

  it("uses each value it can and the default for the rest", () => {
    const agent = (runner: Record<string, unknown>, appearance: Record<string, unknown> = {}) =>
      (migrateVersion1({ version: 1, profile: { agentName: "Nova" }, appearance, runner }).agents as Record<string, unknown>).default;
    expect(agent({ enabled: "yes", command: "agent run", timeoutMinutes: 0 }, { yourAgentColor: "green" })).toMatchObject({
      hue: "olive", enabled: false, timeoutMinutes: 30, launch: { command: "agent run" },
    });
    // A profile dohc cannot use falls back to the typed command.
    expect(agent({ enabled: true, command: "agent run", profile: { tool: "cursor", executable: "x" } }, { yourAgentColor: "olive" })).toMatchObject({
      hue: "olive", enabled: true, launch: { command: "agent run" },
    });
    expect(agent({ enabled: true, command: "x", profile: claude })).toMatchObject({ launch: claude });
  });

  it("keeps the name or color an agent posted with from outside dohc, with nothing for dohc to start", () => {
    const agent = { changesFiles: true, enabled: false, timeoutMinutes: 30 };
    expect(migrateVersion1({ version: 1, profile: { agentName: "Nova" }, runner: { enabled: true, command: " \t " } }).agents).toEqual({
      default: { ...agent, name: "Nova", hue: "olive", nameBeforeMigration: "Nova" },
    });
    expect(migrateVersion1({ version: 1, appearance: { yourAgentColor: "plum" } }).agents).toEqual({
      default: { ...agent, name: "Agent", hue: "plum", nameBeforeMigration: "Agent" },
    });
  });

  it("makes no agent when version 1 had none", () => {
    for (const raw of [
      { version: 1 },
      { version: 1, appearance: { yourAgentColor: null } },
      { version: 1, appearance: { yourAgentColor: "green" }, runner: { enabled: false, command: " \t ", timeoutMinutes: 30 } },
      { version: 1, runner: "agent run" },
    ]) {
      const migrated = migrateVersion1(raw);
      expect(migrated).not.toHaveProperty("agents");
      expect(migrated).not.toHaveProperty("runner");
      expect(migrated.version).toBe(2);
    }
  });

  it("reads the file 145.1 writes for an agent added with Claude Code", async () => {
    // What 145.1 saved after Add an agent, a color for each of you, a 45 minute
    // limit and your name, with the tool's folder changed.
    const root = await createTestScratch("dohc-settings-145-1-");
    await writeFile(join(root, USER_SETTINGS_FILE), JSON.stringify({
      version: 1,
      profile: { agentName: "Nova", preferredName: "Sam" },
      appearance: { themeMode: "system", zoomLevel: 0, accentColor: null, yourColor: "teal", yourAgentColor: "plum" },
      editor: { fontFamily: "sans", fontSize: 15, lineWrap: true, spellcheck: true },
      runner: { command: "", enabled: true, timeoutMinutes: 45, profile: { tool: "claude", executable: "C:\\Tools\\claude.CMD" } },
      sidebar: { order: [], hidden: [], pinnedApps: {} },
      privacy: { usageReports: true, errorReports: true },
    }, null, 2));
    const read = await readUserSettingsFile(root);
    expect(read.ignored ?? []).toEqual([]);
    expect(read.agentProblems ?? []).toEqual([]);
    expect(read.settings.profile).toEqual({ preferredName: "Sam" });
    expect(read.settings.appearance.yourColor).toBe("teal");
    expect(read.settings.agents).toEqual({
      default: {
        name: "Nova", hue: "plum", launch: { tool: "claude", executable: "C:\\Tools\\claude.CMD" },
        changesFiles: true, enabled: true, timeoutMinutes: 45, nameBeforeMigration: "Nova",
      },
    });
  });

  it("reads a version 1 file as version 2 and writes version 2 on the first save", async () => {
    const root = await createTestScratch("dohc-settings-migration-");
    const path = join(root, USER_SETTINGS_FILE);
    const version1 = JSON.stringify({
      version: 1,
      profile: { agentName: "Nova" },
      appearance: { themeMode: "dark", yourAgentColor: "rose" },
      runner: { enabled: true, command: "agent run", timeoutMinutes: 30 },
      wallpaper: "teal",
    });
    await writeFile(path, version1);
    const read = await readUserSettingsFile(root);
    expect(read.settings.agents).toEqual({
      default: testAgent({ name: "Nova", hue: "rose", launch: { command: "agent run" }, nameBeforeMigration: "Nova" }),
    });
    expect(read.ignored).toEqual([{ key: "wallpaper", reason: "unknown" }]);
    // Reading leaves the file alone.
    expect(await readFile(path, "utf8")).toBe(version1);

    await writeUserSettingsFile(root, { ...read.settings, editor: { ...read.settings.editor, fontSize: 16 } }, read.settings);
    expect(JSON.parse(await readFile(path, "utf8"))).toEqual({
      version: 2,
      profile: {},
      appearance: { themeMode: "dark" },
      agents: { default: { name: "Nova", hue: "rose", launch: { command: "agent run" }, enabled: true, changesFiles: true, timeoutMinutes: 30, nameBeforeMigration: "Nova" } },
      editor: { fontSize: 16 },
      wallpaper: "teal",
    });
  });
});

it("reads a file without a version the way version 1 did", async () => {
  const root = await createTestScratch("dohc-settings-migration-");
  await writeFile(join(root, USER_SETTINGS_FILE), JSON.stringify({
    profile: { agentName: "Nova" },
    runner: { enabled: true, command: "agent run", timeoutMinutes: 30 },
  }));
  const read = await readUserSettingsFile(root);
  expect(read.ignored ?? []).toEqual([]);
  expect(read.settings.agents).toEqual({
    default: testAgent({ name: "Nova", launch: { command: "agent run" }, nameBeforeMigration: "Nova" }),
  });
});

it("keeps the agents a file without a version already lists", async () => {
  const root = await createTestScratch("dohc-settings-migration-");
  const path = join(root, USER_SETTINGS_FILE);
  const writer = testAgent({ name: "Writer" });
  await writeFile(path, JSON.stringify({
    profile: { agentName: "Nova" },
    runner: { enabled: true, command: "agent run", timeoutMinutes: 30 },
    agents: { writer },
  }));
  const read = await readUserSettingsFile(root);
  const agents = {
    default: testAgent({ name: "Nova", launch: { command: "agent run" }, nameBeforeMigration: "Nova" }),
    writer,
  };
  expect(read.settings.agents).toEqual(agents);
  await writeUserSettingsFile(root, { ...read.settings, editor: { ...read.settings.editor, fontSize: 16 } }, read.settings);
  expect(JSON.parse(await readFile(path, "utf8")).agents).toEqual(agents);
});

it("keeps a written agent whose name only the spaces set apart from version 1's", async () => {
  const root = await createTestScratch("dohc-settings-migration-");
  const path = join(root, USER_SETTINGS_FILE);
  const writer = testAgent({ name: "ClaudeCode" });
  await writeFile(path, JSON.stringify({ profile: { agentName: "Claude Code" }, agents: { writer } }));
  const read = await readUserSettingsFile(root);
  expect(Object.keys(read.settings.agents)).toEqual(["default"]);
  expect(read.agentProblems).toEqual([{ id: "writer", name: "ClaudeCode", problem: "Another agent has this name." }]);
  await writeUserSettingsFile(root, { ...read.settings, editor: { ...read.settings.editor, fontSize: 16 } }, read.settings);
  expect(JSON.parse(await readFile(path, "utf8")).agents.writer).toEqual(writer);
});

it("leaves version 1's agent where it is when the file's own agents have no place for it", () => {
  const version1 = { profile: { agentName: "Nova" }, runner: { enabled: true, command: "agent run" } };
  for (const agents of [{ default: testAgent({ name: "Writer" }) }, ["Writer"], null]) {
    expect(migrateVersion1({ ...version1, agents })).toEqual({ ...version1, agents, version: 2 });
  }
});

describe("an agent entry dohc cannot use", () => {
  it("turns off only that agent, and keeps its id, its name and what is wrong", async () => {
    const root = await createTestScratch("dohc-settings-agents-");
    await writeFile(join(root, USER_SETTINGS_FILE), JSON.stringify({
      ...DEFAULT_USER_SETTINGS,
      agents: {
        default: testAgent({ name: "Nova" }),
        "agent-hue": { ...testAgent({ name: "Atlas" }), hue: "green" },
        "Agent B": testAgent({ name: "Bee" }),
        "agent-same": testAgent({ name: " nova " }),
        "agent-list": ["not", "an", "agent"],
        "dohc-mcp": testAgent({ name: "Mick" }),
      },
    }));
    const read = await readUserSettingsFile(root);
    expect(Object.keys(read.settings.agents)).toEqual(["default"]);
    expect(read.agentProblems).toEqual([
      { id: "agent-hue", name: "Atlas", problem: expect.stringMatching(/^hue: /) },
      { id: "Agent B", name: "Bee", problem: "An agent's id is up to 64 lowercase letters, digits and single dashes, starting with a letter and not ending with a dash." },
      { id: "agent-same", name: "nova", problem: "Another agent has this name." },
      { id: "agent-list", problem: expect.any(String) },
      { id: "dohc-mcp", name: "Mick", problem: "dohc-mcp stands for agents that give no name. Give this agent another id." },
    ]);
  });
});
