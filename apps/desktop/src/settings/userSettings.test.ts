import { readFile, symlink, unlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  AgentsSettings,
  DEFAULT_PRIVACY_SETTINGS,
  DEFAULT_SIDEBAR_SETTINGS,
  DEFAULT_USER_SETTINGS,
  DesktopUserSettings, AgentColors,
  clampZoomLevel,
  firstAgent,
  firstAgentCommand,
  firstAgentWithLaunch,
  agentHandle,
  agentIdsNamedIn,
  agentMentionCandidates,
  agentNameTaken,
  agentProblem,
  automationAgent,
  listAgents,
  newAgentHue,
  newAgentId,
  newAgentName,
  ownAgentNamed,
  withFirstAgent,
  effectiveThemeMode,
  zoomPercent,
} from "./userSettings";
import {
  ensureUserSettingsFile,
  MAX_USER_SETTINGS_FILE_BYTES,
  readCachedUserSettingsFile,
  readUserSettingsFile,
  reloadUserSettingsFile,
  replaceUserSettingsFile,
  orderUserSettingsAgents,
  USER_SETTINGS_FILE,
  writeUserSettingsFile,
} from "./userSettingsStore";

import { AGENT_ID_TAKEN_ERROR } from "../ipc/errorWords";
import { AGENT_HUE_ASSIGNMENT_ORDER, AGENT_HUES } from "../renderer/tokens";
import { settingsWithAgent, testAgent } from "../testing/agentSettings";
import { createTestScratch } from "../workspaces/testTemp";
// WSL can expose the Windows temp directory under /mnt, which is slower and
// more permission-sensitive for symlink tests; use the Linux temp dir there.
const tempBase = tmpdir().startsWith("/mnt/") ? "/tmp" : tmpdir();

describe("desktop user settings model", () => {
  it("rejects missing, foreign, or future shapes", () => {
    expect(DesktopUserSettings.safeParse(null).success).toBe(false);
    expect(DesktopUserSettings.safeParse({ version: 3 }).success).toBe(false);
    expect(
      DesktopUserSettings.safeParse({ version: 2, token: "secret" }).success,
    ).toBe(false);
  });

  it("rejects removed sections instead of keeping a dual schema", () => {
    for (const removed of [
      { general: { launchBehavior: "recent" } },
      { notifications: { updates: true, agentRuns: true } },
    ]) {
      const obsolete = {
        ...DEFAULT_USER_SETTINGS,
        appearance: { ...DEFAULT_USER_SETTINGS.appearance, themeMode: "dark" as const },
        ...removed,
      };
      expect(DesktopUserSettings.safeParse(obsolete).success).toBe(false);
    }
  });

  it("adds an empty agents list to settings written before agents", () => {
    const legacySettings = {
      version: DEFAULT_USER_SETTINGS.version,
      appearance: { ...DEFAULT_USER_SETTINGS.appearance, themeMode: "dark" as const },
      editor: DEFAULT_USER_SETTINGS.editor,
    };

    expect(DesktopUserSettings.parse(legacySettings)).toEqual({
      ...legacySettings,
      profile: {},
      agents: {},
      sidebar: DEFAULT_SIDEBAR_SETTINGS,
      privacy: DEFAULT_PRIVACY_SETTINGS,
    });
  });

  it("reads report switches a person turned off, each on its own", () => {
    const parsed = DesktopUserSettings.parse({
      ...DEFAULT_USER_SETTINGS,
      privacy: { usageReports: false, errorReports: true },
    });
    expect(parsed.privacy).toEqual({ usageReports: false, errorReports: true });
    expect(DEFAULT_USER_SETTINGS.privacy).toEqual({ usageReports: true, errorReports: true });
  });

  it("adds the default zoom level to settings written before zoom support", () => {
    const legacySettings = {
      version: DEFAULT_USER_SETTINGS.version,
      profile: {},
      appearance: {
        themeMode: "dark" as const,
      },
      editor: DEFAULT_USER_SETTINGS.editor,
    };

    // The stored appearance choices survive; only the new field fills in.
    expect(DesktopUserSettings.parse(legacySettings).appearance).toEqual({
      ...DEFAULT_USER_SETTINGS.appearance,
      themeMode: "dark",
    });

    for (const zoomLevel of [-6, 6, 0.5, Number.NaN]) {
      expect(
        DesktopUserSettings.safeParse({
          ...DEFAULT_USER_SETTINGS,
          appearance: { ...DEFAULT_USER_SETTINGS.appearance, zoomLevel },
        }).success,
        String(zoomLevel),
      ).toBe(false);
    }
  });

  it("clamps zoom levels and maps them to 20%-per-step percentages", () => {
    expect(clampZoomLevel(99)).toBe(5);
    expect(clampZoomLevel(-99)).toBe(-5);
    expect(clampZoomLevel(Number.NaN)).toBe(0);
    expect(zoomPercent(0)).toBe(100);
    expect(zoomPercent(1)).toBe(120);
    expect(zoomPercent(-1)).toBe(83);
  });

  it("validates preferred names", () => {

    const named = DesktopUserSettings.parse({
      ...DEFAULT_USER_SETTINGS,
      profile: { preferredName: "  Sam Rivera  " },
    });
    expect(named.profile.preferredName).toBe("Sam Rivera");
    expect(
      DesktopUserSettings.safeParse({
        ...DEFAULT_USER_SETTINGS,
        profile: { preferredName: "Sam\u0000Admin" },
      }).success,
    ).toBe(false);

    const tooLong = DesktopUserSettings.safeParse({
      ...DEFAULT_USER_SETTINGS,
      profile: { preferredName: "x".repeat(81) },
    });
    expect(tooLong.success).toBe(false);
    if (!tooLong.success) {
      expect(tooLong.error.issues[0]?.message).toBe(
        "Names must contain 80 characters or fewer.",
      );
    }
  });

  it("validates each agent's name, id and timeout, and keeps names apart", () => {
    const agent = testAgent();
    expect(AgentsSettings.parse({ default: { ...agent, name: "  Nova  " } }).default!.name).toBe("Nova");
    for (const name of ["", "x".repeat(81), "Bad\u0000name"]) {
      expect(AgentsSettings.safeParse({ default: { ...agent, name } }).success, name).toBe(false);
    }
    for (const timeoutMinutes of [0, 1441, 1.5]) {
      expect(AgentsSettings.safeParse({ default: { ...agent, timeoutMinutes } }).success).toBe(false);
    }
    for (const id of ["Nova", "1st", "-a", "a_b", "a".repeat(65), "codex-", "code--review"]) {
      expect(AgentsSettings.safeParse({ [id]: agent }).success, id).toBe(false);
    }
    expect(AgentsSettings.safeParse({ default: { ...agent, launch: { command: " 	 " } } }).success).toBe(false);
    const { launch: _launch, ...noLaunch } = agent;
    expect(AgentsSettings.safeParse({ default: noLaunch }).success).toBe(false);
    expect(AgentsSettings.safeParse({ default: { ...noLaunch, enabled: false } }).success).toBe(true);
    expect(AgentsSettings.safeParse({ default: agent, "agent-b": { ...agent, name: " agent " } }).success).toBe(false);
    expect(AgentsSettings.safeParse({ "agent-b": { ...agent, nameBeforeMigration: "Nova" } }).success).toBe(false);
    // Names that differ only in case or spaces look the same in a chat.
    for (const [first, second] of [["Nova Bee", "nova  bee"], ["Claude Code", "ClaudeCode"]]) {
      expect(AgentsSettings.safeParse({ default: { ...agent, name: first }, "agent-b": { ...agent, name: second } }).success, second).toBe(false);
    }
    // The default agent's old messages carry its old name, so nobody else takes it.
    for (const name of ["Nova", "No va"]) {
      expect(AgentsSettings.safeParse({
        default: { ...agent, name: "Atlas", nameBeforeMigration: "Nova" },
        "agent-b": { ...agent, name },
      }).success, name).toBe(false);
    }
    expect(AgentsSettings.safeParse({ default: { ...agent, name: "Nova", nameBeforeMigration: "Nova" } }).success).toBe(true);
  });

  it("names each agent dohc can start that a message names, by its name without spaces, outside code", () => {
    const { launch: _launch, ...unset } = testAgent({ name: "Scout", enabled: false });
    const settings = { agents: {
      default: testAgent({ name: "Nova" }),
      "claude-code": testAgent({ name: "Claude Code" }),
      codex: testAgent({ name: "Codex", enabled: false }),
      scout: unset,
    } };
    expect(agentIdsNamedIn(settings, "@nova and @claudecode, then @CODEX")).toEqual(["default", "claude-code", "codex"]);
    // An agent with no way to start, a name inside code, and @agent name nobody.
    expect(agentIdsNamedIn(settings, "@Scout `@Nova` @agent")).toEqual([]);
    expect(agentIdsNamedIn(settings, "Claude Code, please")).toEqual([]);
  });

  it("gives each agent the handle a message reads back in full, so a name with punctuation wakes its own agent", () => {
    expect(["Codex (Work)", "Nova.", "R2-D2-", "-Scout_", "Café Bot", "🦊"].map(agentHandle))
      .toEqual(["CodexWork", "Nova", "R2-D2", "Scout", "CaféBot", ""]);
    const settings = { agents: {
      codex: testAgent({ name: "Codex" }),
      "codex-work": testAgent({ name: "Codex (Work)" }),
      droid: testAgent({ name: "R2-D2-" }),
      fox: testAgent({ name: "🦊" }),
      bear: testAgent({ name: "🐻" }),
    } };
    expect(AgentsSettings.safeParse(settings.agents).success).toBe(true);
    expect(agentIdsNamedIn(settings, "@CodexWork, look")).toEqual(["codex-work"]);
    expect(agentIdsNamedIn(settings, "@codex.")).toEqual(["codex"]);
    expect(agentIdsNamedIn(settings, "@R2-D2- and @🦊")).toEqual(["droid"]);
    // Only an agent with a handle is offered after @.
    expect(agentMentionCandidates(listAgents(settings)).map(({ id, handle }) => [id, handle])).toEqual([
      ["agent:codex", "Codex"], ["agent:codex-work", "CodexWork"], ["agent:droid", "R2-D2"],
    ]);
    // Names a message reads as one handle are one name.
    for (const [first, second] of [["Nova", "Nova."], ["Codex Work", "Codex (Work)"]]) {
      expect(AgentsSettings.safeParse({ a: testAgent({ name: first }), b: testAgent({ name: second }) }).success, second).toBe(false);
    }
  });

  it("gives a new agent the first hue nobody uses, spread out from the ones before", () => {
    expect([...AGENT_HUE_ASSIGNMENT_ORDER].sort()).toEqual([...AGENT_HUES].sort());
    const agents: AgentsSettings = {};
    const hues = [];
    for (let n = 0; n < 9; n += 1) {
      const hue = newAgentHue(agents, "blue");
      hues.push(hue);
      agents[`agent-${n}`] = testAgent({ name: `Agent ${n}`, hue });
    }
    // Your own blue is skipped; once every hue is in use, they come round again.
    expect(hues).toEqual(["olive", "rose", "teal", "plum", "rust", "amber", "indigo", "olive", "blue"]);
  });

  it("says what is wrong with an agent entry in one sentence about its first problem", () => {
    const { name: _name, ...nameless } = testAgent();
    const { launch: _launch, ...unlaunched } = testAgent();
    const cases: Array<[string, unknown, string]> = [
      ["agent-b", nameless, "`name` is missing."],
      ["agent-b", testAgent({ name: 7 as unknown as string }), "`name` must be text."],
      ["agent-b", testAgent({ name: "  " }), "`name` is empty."],
      ["agent-b", testAgent({ name: "n".repeat(81) }), "`name` must be 80 characters or fewer."],
      ["agent-b", testAgent({ name: "Nova" }), "`name` can't contain control characters."],
      ["agent-b", { ...testAgent(), hue: "green" }, `\`hue\` must be one of: ${AGENT_HUES.join(", ")}.`],
      ["agent-b", { ...testAgent(), enabled: "yes" }, "`enabled` must be true or false."],
      ["agent-b", { ...testAgent(), changesFiles: 1 }, "`changesFiles` must be true or false."],
      ["agent-b", { ...unlaunched, enabled: true }, "Choose how dohc starts this agent before turning it on."],
      ["agent-b", testAgent({ timeoutMinutes: 0 }), "`timeoutMinutes` must be a whole number from 1 to 1440."],
      ["agent-b", { ...testAgent(), launch: { tool: "cursor" } }, "dohc can't read `launch`."],
      ["agent-b", { ...testAgent(), color: "teal" }, "dohc doesn't use `color`."],
      ["agent-b", ["Nova"], "This entry must be an object, like the other agents."],
      ["agent-b", null, "This entry must be an object, like the other agents."],
      ["agent-b", testAgent({ nameBeforeMigration: "Nova" }), "Only the `default` agent can have `nameBeforeMigration`."],
      ["default", testAgent({ nameBeforeMigration: 7 as unknown as string }), "dohc can't read this entry."],
      ["Agent B", testAgent(), "An agent's id is up to 64 lowercase letters, digits and single dashes, starting with a letter and not ending with a dash."],
      ["agent-b", testAgent(), "Another agent has this name."],
    ];
    for (const [id, entry, sentence] of cases) expect(agentProblem(id, entry), sentence).toBe(sentence);
  });

  it("knows when another agent has a name a chat cannot tell apart", () => {
    const agents = { default: testAgent({ name: "Claude Code", nameBeforeMigration: "Nova" }), codex: testAgent({ name: "Codex" }) };
    expect(agentNameTaken(agents, "codex", "claudecode")).toBe(true);
    expect(agentNameTaken(agents, "codex", "Nova")).toBe(true);
    expect(agentNameTaken(agents, "codex", "Codex")).toBe(false);
    expect(agentNameTaken(agents, "default", "Claude Code")).toBe(false);
  });

  it("has automations wake the first agent dohc can start, even one that is off", () => {
    const { launch: _launch, ...mcpOnly } = testAgent({ name: "Terminal" });
    const agents = { terminal: mcpOnly, off: testAgent({ name: "Off", enabled: false }), on: testAgent({ name: "On" }) };
    expect(automationAgent({ agents })?.id).toBe("off");
    expect(automationAgent({ agents: { terminal: mcpOnly } })).toBeNull();
  });

  it("gives the first agent the default id, and each next one an id and a name no agent has", () => {
    expect(newAgentId([], "codex")).toBe("default");
    // An id the file holds for an entry dohc could not use is taken too.
    expect(newAgentId(["default", "codex", "codex-2"], "codex")).toBe("codex-3");
    const agents = { default: testAgent({ name: "Codex" }), other: testAgent({ name: "codex 2" }) };
    expect(newAgentName(agents, "Codex")).toBe("Codex 3");
    expect(newAgentName(agents, "Claude Code")).toBe("Claude Code");
  });

  it("finds your agent by its name, or by the name its messages had before agents had ids", () => {
    const settings = {
      agents: {
        default: testAgent({ name: "Atlas", nameBeforeMigration: "Nova" }),
        "agent-b": testAgent({ name: "Bee" }),
      },
    };
    expect(ownAgentNamed(settings, "Nova")?.id).toBe("default");
    expect(ownAgentNamed(settings, "Atlas")?.id).toBe("default");
    expect(ownAgentNamed(settings, "Bee")?.id).toBe("agent-b");
    expect(ownAgentNamed(settings, "nova")).toBeNull();
    expect(ownAgentNamed(settings, "Cursor")).toBeNull();
  });

  it("starts only an agent dohc has a launch for", () => {
    expect(firstAgentWithLaunch({ agents: { default: testAgent() } })?.id).toBe("default");
    const { launch: _launch, ...named } = testAgent({ name: "Nova" });
    expect(firstAgentWithLaunch({ agents: { default: named } })).toBeNull();
    expect(firstAgentCommand({ agents: { default: named } })).toBe("");
  });

  it("adds the default agent when there is none, and changes the first agent once there is one", () => {
    const add = (settings: DesktopUserSettings) => withFirstAgent(settings, (current) => current ?? testAgent({ name: "Nova" }));
    // Two saves made from the same settings add one agent.
    expect(add(DEFAULT_USER_SETTINGS)).toEqual(add(DEFAULT_USER_SETTINGS));
    const added = add(DEFAULT_USER_SETTINGS);
    expect(Object.keys(added.agents)).toEqual(["default"]);
    const later = { ...added, agents: { "agent-b": testAgent({ name: "Bee" }), ...added.agents } };
    expect(firstAgent(withFirstAgent(later, (current) => ({ ...current!, name: "Atlas" })))).toMatchObject({ id: "agent-b", name: "Atlas" });
  });

  it("resolves system theme from the OS preference", () => {
    expect(effectiveThemeMode("system", true)).toBe("dark");
    expect(effectiveThemeMode("system", false)).toBe("light");
    expect(effectiveThemeMode("light", true)).toBe("light");
    expect(effectiveThemeMode("dark", false)).toBe("dark");
  });
});

describe("desktop user settings store", () => {
  it("round-trips pretty JSON through the user settings file", async () => {
    const root = await createTestScratch("dohc-user-settings-");
    const settings = {
      ...DEFAULT_USER_SETTINGS,
      appearance: { ...DEFAULT_USER_SETTINGS.appearance, themeMode: "dark" as const },
    };
    await replaceUserSettingsFile(root, settings);
    expect(await readUserSettingsFile(root)).toEqual({
      settings,
      source: "stored",
    });
    const raw = await readFile(join(root, USER_SETTINGS_FILE), "utf8");
    expect(raw.endsWith("\n")).toBe(true);
  });

  it("caches reads until the settings writer invalidates them", async () => {
    const root = await createTestScratch("dohc-user-settings-");
    const first = {
      ...DEFAULT_USER_SETTINGS,
      appearance: { ...DEFAULT_USER_SETTINGS.appearance, themeMode: "dark" as const },
    };
    const second = {
      ...DEFAULT_USER_SETTINGS,
      appearance: { ...DEFAULT_USER_SETTINGS.appearance, themeMode: "light" as const },
    };
    await replaceUserSettingsFile(root, first);
    expect((await readCachedUserSettingsFile(root)).settings).toEqual(first);

    await writeFile(
      join(root, USER_SETTINGS_FILE),
      `${JSON.stringify(second)}\n`,
    );
    expect((await readCachedUserSettingsFile(root)).settings).toEqual(first);

    await writeUserSettingsFile(root, second, first);
    expect((await readCachedUserSettingsFile(root)).settings).toEqual(second);
  });

  it("a missing file reads as defaults", async () => {
    expect(await readUserSettingsFile(await createTestScratch("dohc-user-settings-"))).toEqual({
      settings: DEFAULT_USER_SETTINGS,
      source: "default",
    });
  });

  it("reads a version 1 file without an agent as version 2 with no agents", async () => {
    const root = await createTestScratch("dohc-user-settings-");
    await writeFile(
      join(root, USER_SETTINGS_FILE),
      JSON.stringify({
        version: 1,
        appearance: {
          ...DEFAULT_USER_SETTINGS.appearance,
          themeMode: "dark",
        },
        editor: DEFAULT_USER_SETTINGS.editor,
      }),
    );

    expect(await readUserSettingsFile(root)).toEqual({
      settings: {
        ...DEFAULT_USER_SETTINGS,
        appearance: {
          ...DEFAULT_USER_SETTINGS.appearance,
          themeMode: "dark",
        },
      },
      source: "stored",
    });
  });

  it("corrupt, unsupported, and oversized files recover to defaults", async () => {
    const corrupt = await createTestScratch("dohc-user-settings-");
    await writeFile(join(corrupt, USER_SETTINGS_FILE), "{not json");
    expect(await readUserSettingsFile(corrupt)).toMatchObject({
      settings: DEFAULT_USER_SETTINGS,
      source: "recovered",
    });

    const future = await createTestScratch("dohc-user-settings-");
    await writeFile(join(future, USER_SETTINGS_FILE), JSON.stringify({ version: 3 }));
    expect(await readUserSettingsFile(future)).toMatchObject({
      settings: DEFAULT_USER_SETTINGS,
      source: "recovered",
    });

    const huge = await createTestScratch("dohc-user-settings-");
    await writeFile(
      join(huge, USER_SETTINGS_FILE),
      JSON.stringify({ padding: "x".repeat(MAX_USER_SETTINGS_FILE_BYTES) }),
    );
    expect(await readUserSettingsFile(huge)).toMatchObject({
      settings: DEFAULT_USER_SETTINGS,
      source: "recovered",
    });
  });

  it("reads the accent, your colors, and the editor font, and turns off only a bad one", async () => {
    const root = await createTestScratch("dohc-user-settings-");
    const path = join(root, USER_SETTINGS_FILE);
    await writeFile(path, JSON.stringify({
      appearance: { accentColor: "#3A7EE9", yourColor: "teal" },
      editor: { fontFamily: "Iowan Old Style", fontSize: 17 },
    }));
    expect((await readUserSettingsFile(root)).settings).toMatchObject({
      appearance: { accentColor: "#3A7EE9", yourColor: "teal" },
      editor: { fontFamily: "Iowan Old Style", fontSize: 17 },
    });

    // A named color, a hue dohc does not have, and a font name that could
    // close its CSS quotes: each takes its default, and the rest applies.
    await writeFile(path, JSON.stringify({
      appearance: { themeMode: "dark", accentColor: "teal", yourColor: "green" },
      editor: { fontFamily: "Inter\", serif; x: \"", fontSize: 17 },
    }));
    expect(await readUserSettingsFile(root)).toEqual({
      settings: {
        ...DEFAULT_USER_SETTINGS,
        appearance: { ...DEFAULT_USER_SETTINGS.appearance, themeMode: "dark" },
        editor: { ...DEFAULT_USER_SETTINGS.editor, fontSize: 17 },
      },
      source: "stored",
      ignored: [
        { key: "appearance.accentColor", reason: "invalid" },
        { key: "appearance.yourColor", reason: "invalid" },
        { key: "editor.fontFamily", reason: "invalid" },
      ],
    });
  });

  it("writes every look setting's default into a new settings file", async () => {
    const root = await createTestScratch("dohc-user-settings-");
    const written = JSON.parse(await readFile(await ensureUserSettingsFile(root), "utf8"));
    expect(written.appearance).toMatchObject({ accentColor: null, yourColor: null });
    expect(written.editor).toMatchObject({ fontFamily: "sans", fontSize: 15 });
  });

  it("turns off only an unknown key or a key with a value dohc cannot use", async () => {
    const root = await createTestScratch("dohc-user-settings-");
    await writeFile(
      join(root, USER_SETTINGS_FILE),
      JSON.stringify({
        appearance: { themeMode: "dark", zoomLevel: 9 },
        editor: { fontSize: 18, lineWrap: "yes" },
        wallpaper: "teal",
      }),
    );
    expect(await readUserSettingsFile(root)).toEqual({
      settings: {
        ...DEFAULT_USER_SETTINGS,
        appearance: { ...DEFAULT_USER_SETTINGS.appearance, themeMode: "dark" },
        editor: { ...DEFAULT_USER_SETTINGS.editor, fontSize: 18 },
      },
      source: "stored",
      ignored: [
        { key: "appearance.zoomLevel", reason: "invalid" },
        { key: "editor.lineWrap", reason: "invalid" },
        { key: "wallpaper", reason: "unknown" },
      ],
    });
  });

  it("saves only what changed, so keys dohc does not use stay in the file", async () => {
    const root = await createTestScratch("dohc-user-settings-");
    const path = join(root, USER_SETTINGS_FILE);
    await writeFile(path, JSON.stringify({
      appearance: { themeMode: "dark" },
      editor: { fontSize: 99 },
      wallpaper: "teal",
    }));
    const current = await readUserSettingsFile(root);
    const saved = await writeUserSettingsFile(root, {
      ...current.settings,
      appearance: { ...current.settings.appearance, zoomLevel: 2 },
    }, current.settings);
    expect(JSON.parse(await readFile(path, "utf8"))).toEqual({
      // A file without a version is version 1, so the save writes version 2.
      version: 2,
      appearance: { themeMode: "dark", zoomLevel: 2 },
      editor: { fontSize: 99 },
      wallpaper: "teal",
    });
    expect(saved).toEqual({
      settings: {
        ...current.settings,
        appearance: { ...DEFAULT_USER_SETTINGS.appearance, themeMode: "dark", zoomLevel: 2 },
      },
      source: "stored",
      ignored: [
        { key: "editor.fontSize", reason: "invalid" },
        { key: "wallpaper", reason: "unknown" },
      ],
    });
    // Changing the setting dohc could not use replaces the bad value.
    await writeUserSettingsFile(root, {
      ...saved.settings,
      editor: { ...saved.settings.editor, fontSize: 16 },
    }, saved.settings);
    expect(JSON.parse(await readFile(path, "utf8")).editor).toEqual({ fontSize: 16 });
  });

  it("keeps an edit made in the file after the caller read it", async () => {
    const root = await createTestScratch("dohc-user-settings-");
    const path = join(root, USER_SETTINGS_FILE);
    await replaceUserSettingsFile(root, DEFAULT_USER_SETTINGS);
    const seen = (await readUserSettingsFile(root)).settings;
    // The person switches to dark in the file before Settings hears of it.
    await writeFile(path, JSON.stringify({
      ...DEFAULT_USER_SETTINGS,
      appearance: { ...DEFAULT_USER_SETTINGS.appearance, themeMode: "dark" },
    }));
    const saved = await writeUserSettingsFile(root, {
      ...seen,
      appearance: { ...seen.appearance, zoomLevel: 1 },
    }, seen);
    expect(saved.settings.appearance).toEqual({
      ...DEFAULT_USER_SETTINGS.appearance,
      themeMode: "dark",
      zoomLevel: 1,
    });
  });

  it("refuses to add an agent the file got after the caller read it", async () => {
    const root = await createTestScratch("dohc-user-settings-");
    const path = join(root, USER_SETTINGS_FILE);
    await replaceUserSettingsFile(root, DEFAULT_USER_SETTINGS);
    const seen = (await readUserSettingsFile(root)).settings;
    // Another window adds Nova under the id this one is about to use.
    await writeFile(path, JSON.stringify(settingsWithAgent({ name: "Nova" })));
    const before = await readFile(path, "utf8");
    await expect(writeUserSettingsFile(root, settingsWithAgent({ name: "Atlas" }), seen)).rejects.toMatchObject({
      name: AGENT_ID_TAKEN_ERROR,
      message: "dohc didn't add Atlas because the settings file changed at the same time.",
    });
    expect(await readFile(path, "utf8")).toBe(before);
  });

  it("saves an agent's launch whole, so a save from older settings never mixes two tools", async () => {
    const root = await createTestScratch("dohc-user-settings-");
    const path = join(root, USER_SETTINGS_FILE);
    const seen = settingsWithAgent({ launch: { tool: "claude", executable: "C:\\Tools\\claude.exe" } });
    await replaceUserSettingsFile(root, seen);
    // Another window switches the agent to Codex before this one saves.
    await writeFile(path, JSON.stringify(settingsWithAgent({ launch: { tool: "codex", executable: "C:\\Tools\\codex.exe" } })));
    await writeUserSettingsFile(root, settingsWithAgent({ launch: { tool: "claude", executable: "D:\\claude.exe" } }), seen);
    expect(JSON.parse(await readFile(path, "utf8")).agents.default.launch).toEqual({ tool: "claude", executable: "D:\\claude.exe" });
  });

  it("refuses to save into an agent entry dohc cannot use, and leaves that entry as written", async () => {
    const root = await createTestScratch("dohc-user-settings-");
    const path = join(root, USER_SETTINGS_FILE);
    const refusal = `dohc did not save settings. ${path} has an agent "default" that dohc can't use. Fix or remove it in the file, then try again.`;
    const broken = { ...testAgent({ name: "Nova" }), hue: "green" };
    // More unusable entries than Settings lists, before the one in the way.
    const others = Object.fromEntries(Array.from({ length: 50 }, (_, n) => [`other-${n}`, broken]));
    const agents = { ...others, default: broken };
    await writeFile(path, JSON.stringify({ ...DEFAULT_USER_SETTINGS, agents }));
    const before = await readFile(path, "utf8");
    const seen = await readUserSettingsFile(root);
    expect(seen.agentProblems?.map(({ id }) => id)).not.toContain("default");
    const added = withFirstAgent(seen.settings, (current) => current ?? testAgent({ name: "Atlas" }));
    await expect(writeUserSettingsFile(root, added, seen.settings)).rejects.toThrow(refusal);
    // A save queued behind the refused one starts from the agent it added.
    const toggled = withFirstAgent(added, (current) => ({ ...current!, enabled: !current!.enabled }));
    await expect(writeUserSettingsFile(root, toggled, added)).rejects.toThrow(refusal);
    expect(await readFile(path, "utf8")).toBe(before);
    // Other settings still save around it.
    await writeUserSettingsFile(root, { ...seen.settings, editor: { ...seen.settings.editor, fontSize: 16 } }, seen.settings);
    expect(JSON.parse(await readFile(path, "utf8")).agents).toEqual(agents);

    // An agent Settings read before the person broke it in the file.
    await writeFile(path, JSON.stringify({ ...DEFAULT_USER_SETTINGS, agents: { default: testAgent({ name: "Nova" }) } }));
    const read = await readUserSettingsFile(root);
    await writeFile(path, JSON.stringify({ ...DEFAULT_USER_SETTINGS, agents: { default: broken } }));
    const renamed = withFirstAgent(read.settings, (current) => ({ ...current!, name: "Atlas" }));
    await expect(writeUserSettingsFile(root, renamed, read.settings)).rejects.toThrow(refusal);
    expect(JSON.parse(await readFile(path, "utf8")).agents).toEqual({ default: broken });
  });

  it("refuses to add an agent over agents dohc cannot use, and saves other settings around them", async () => {
    const root = await createTestScratch("dohc-user-settings-");
    const path = join(root, USER_SETTINGS_FILE);
    for (const agents of [[testAgent({ name: "Nova" })], null]) {
      await writeFile(path, JSON.stringify({ ...DEFAULT_USER_SETTINGS, agents }));
      const before = await readFile(path, "utf8");
      const seen = await readUserSettingsFile(root);
      const added = withFirstAgent(seen.settings, (current) => current ?? testAgent({ name: "Atlas" }));
      await expect(writeUserSettingsFile(root, added, seen.settings)).rejects.toThrow(
        `dohc did not save settings. ${path} has an "agents" value dohc can't use. Fix or remove it in the file, then try again.`,
      );
      expect(await readFile(path, "utf8")).toBe(before);
      await writeUserSettingsFile(root, { ...seen.settings, editor: { ...seen.settings.editor, fontSize: 16 } }, seen.settings);
      expect(JSON.parse(await readFile(path, "utf8")).agents).toEqual(agents);
    }
  });

  it("refuses to save over a file dohc cannot use, and reset replaces it", async () => {
    const root = await createTestScratch("dohc-user-settings-");
    const path = join(root, USER_SETTINGS_FILE);
    await writeFile(path, "{ \"appearance\": ");
    await expect(writeUserSettingsFile(root, DEFAULT_USER_SETTINGS, DEFAULT_USER_SETTINGS)).rejects.toThrow(
      `dohc did not save settings. dohc could not use ${path}: it is not valid JSON. Fix the file, or select Reset user in Advanced to replace it.`,
    );
    expect(await readFile(path, "utf8")).toBe("{ \"appearance\": ");
    await replaceUserSettingsFile(root, DEFAULT_USER_SETTINGS);
    expect(await readUserSettingsFile(root)).toEqual({
      settings: DEFAULT_USER_SETTINGS,
      source: "stored",
    });
  });

  it("reloads a changed file, ignores dohc's own save, and keeps the last settings while the file does not parse", async () => {
    const root = await createTestScratch("dohc-user-settings-");
    const path = join(root, USER_SETTINGS_FILE);
    const dark = {
      ...DEFAULT_USER_SETTINGS,
      appearance: { ...DEFAULT_USER_SETTINGS.appearance, themeMode: "dark" as const },
    };
    await writeUserSettingsFile(root, dark, DEFAULT_USER_SETTINGS);
    expect(await reloadUserSettingsFile(root)).toBeNull();

    await writeFile(path, JSON.stringify({ appearance: { themeMode: "light" } }));
    expect(await reloadUserSettingsFile(root)).toEqual({
      settings: {
        ...DEFAULT_USER_SETTINGS,
        appearance: { ...DEFAULT_USER_SETTINGS.appearance, themeMode: "light" },
      },
      source: "stored",
    });
    expect(await reloadUserSettingsFile(root)).toBeNull();

    // Half an edit: the light theme stays, and the warning names the file.
    await writeFile(path, "{ \"appearance\": { \"themeMode\": \"da");
    const broken = await reloadUserSettingsFile(root);
    expect(broken).toMatchObject({
      settings: { appearance: { themeMode: "light" } },
      source: "recovered",
      warning: expect.stringContaining(path),
    });
    expect(await readCachedUserSettingsFile(root)).toEqual(broken);

    await writeFile(path, JSON.stringify(dark));
    expect(await reloadUserSettingsFile(root)).toEqual({ settings: dark, source: "stored" });
  });

  it("creates the settings file with the defaults only when there is none", async () => {
    const root = await createTestScratch("dohc-user-settings-");
    const path = await ensureUserSettingsFile(root);
    expect(path).toBe(join(root, USER_SETTINGS_FILE));
    expect(JSON.parse(await readFile(path, "utf8"))).toEqual(DEFAULT_USER_SETTINGS);
    expect(await reloadUserSettingsFile(root)).toBeNull();
    await writeFile(path, "{}");
    await ensureUserSettingsFile(root);
    expect(await readFile(path, "utf8")).toBe("{}");
  });

  it("keeps sidebar order, hidden views, and pins, and turns off only a list it cannot use", async () => {
    const root = await createTestScratch("dohc-user-settings-");
    const path = join(root, USER_SETTINGS_FILE);
    const pinned: DesktopUserSettings = {
      ...DEFAULT_USER_SETTINGS,
      sidebar: { order: ["sites", "explorer"], hidden: ["graph"], pinnedApps: { "ws-a": ["apps/trip"] } },
    };
    await writeUserSettingsFile(root, pinned, DEFAULT_USER_SETTINGS);
    expect((await readUserSettingsFile(root)).settings.sidebar).toEqual(pinned.sidebar);
    const unpinned = { ...pinned, sidebar: { ...pinned.sidebar, pinnedApps: {} } };
    await writeUserSettingsFile(root, unpinned, pinned);
    expect((await readUserSettingsFile(root)).settings.sidebar.pinnedApps).toEqual({});

    // One workspace's bad pin list turns off only that workspace's pins.
    await writeFile(path, JSON.stringify({
      sidebar: { pinnedApps: { "ws-a": ["report"], "ws-b": [""], "Not A Workspace": ["x"] } },
    }));
    expect(await readUserSettingsFile(root)).toMatchObject({
      settings: { sidebar: { pinnedApps: { "ws-a": ["report"] } } },
      ignored: [
        { key: "sidebar.pinnedApps.ws-b", reason: "invalid" },
        { key: "sidebar.pinnedApps.Not A Workspace", reason: "invalid" },
      ],
    });

    // A view this build does not have turns off the order, not the pins.
    await writeFile(path, JSON.stringify({
      sidebar: { order: ["files", "search"], hidden: [], pinnedApps: { "ws-a": ["report"] } },
    }));
    expect(await readUserSettingsFile(root)).toMatchObject({
      settings: { sidebar: { order: [], hidden: [], pinnedApps: { "ws-a": ["report"] } } },
      ignored: [{ key: "sidebar.order", reason: "invalid" }],
    });
  });

  it("keeps Chats in the sidebar order and hidden list", async () => {
    const root = await createTestScratch("dohc-user-settings-");
    const withChats: DesktopUserSettings = {
      ...DEFAULT_USER_SETTINGS,
      sidebar: { order: ["chats", "explorer", "search", "graph", "sites", "history"], hidden: ["chats"], pinnedApps: {} },
    };
    await writeUserSettingsFile(root, withChats, DEFAULT_USER_SETTINGS);
    const read = await readUserSettingsFile(root);
    expect(read.settings.sidebar).toEqual(withChats.sidebar);
    expect(read.ignored ?? []).toEqual([]);
  });

  it("refuses to read a symlinked user settings file", async () => {
    const root = await createTestScratch("dohc-user-settings-");
    const outside = await createTestScratch("dohc-user-settings-");
    await replaceUserSettingsFile(root, DEFAULT_USER_SETTINGS);
    const outsideSettings = join(outside, USER_SETTINGS_FILE);
    await writeFile(
      outsideSettings,
      JSON.stringify({
        ...DEFAULT_USER_SETTINGS,
        appearance: { ...DEFAULT_USER_SETTINGS.appearance, themeMode: "dark" },
      }),
    );
    await unlink(join(root, USER_SETTINGS_FILE));
    await symlink(outsideSettings, join(root, USER_SETTINGS_FILE));

    expect(await readUserSettingsFile(root)).toMatchObject({
      settings: DEFAULT_USER_SETTINGS,
      source: "recovered",
    });
  });
});


describe("private agent colour storage", () => {
  it("bounds the map and each UTF-8 key", () => {
    expect(AgentColors.safeParse(Object.fromEntries(Array.from({ length: 256 }, (_, n) => [String(n), "blue"]))).success).toBe(true);
    expect(AgentColors.safeParse(Object.fromEntries(Array.from({ length: 257 }, (_, n) => [String(n), "blue"]))).success).toBe(false);
    expect(AgentColors.safeParse({ ["é".repeat(1024)]: "blue" }).success).toBe(true);
    expect(AgentColors.safeParse({ ["é".repeat(1025)]: "blue" }).success).toBe(false);
    expect(AgentColors.safeParse({ agent: "olive" }).success).toBe(false);
  });
  it("ignores one bad entry alone and drops stored olive for a person", async () => {
    const dir = await createTestScratch("agent-colors-lenient-");
    await writeFile(join(dir, USER_SETTINGS_FILE), JSON.stringify({ ...DEFAULT_USER_SETTINGS,
      appearance: { ...DEFAULT_USER_SETTINGS.appearance, yourColor: "olive", agentColors: { good: "rose", bad: "olive", ["x".repeat(2049)]: "blue" } } }));
    const result = await readUserSettingsFile(dir);
    expect(result.settings.appearance.yourColor).toBeNull();
    expect(result.settings.appearance.agentColors).toEqual({ good: "rose" });
    expect(result.ignored).toEqual([{ key: "appearance.yourColor", reason: "invalid" }]);
  });
});


it("keeps a presentation reader current across writes, reloads and reset", async () => {
  const { agentColorsForPresentation, updateUserSettingsFile } = await import("./userSettingsStore");
  const dir = await createTestScratch("agent-colors-reader-");
  const colors = await agentColorsForPresentation(dir);
  expect(colors()).toBeUndefined();
  await updateUserSettingsFile(dir, current => ({ ...current, appearance: { ...current.appearance, agentColors: { agent: "rose" } } }));
  expect(colors()).toEqual({ agent: "rose" });
  await writeFile(join(dir, USER_SETTINGS_FILE), JSON.stringify({ ...DEFAULT_USER_SETTINGS,
    appearance: { ...DEFAULT_USER_SETTINGS.appearance, agentColors: { agent: "blue" } } }));
  await reloadUserSettingsFile(dir);
  expect(colors()).toEqual({ agent: "blue" });
  await replaceUserSettingsFile(dir, DEFAULT_USER_SETTINGS);
  expect(colors()).toBeUndefined();
});


it("refuses a bounded colour map that would make the settings file unreadable on restart", async () => {
  const { updateUserSettingsFile } = await import("./userSettingsStore");
  const dir = await createTestScratch("agent-colors-size-");
  const path = await ensureUserSettingsFile(dir);
  const before = await readFile(path, "utf8");
  const agentColors = Object.fromEntries(Array.from({ length: 256 }, (_, index) => [String(index) + "x".repeat(1100), "blue"]));
  await expect(updateUserSettingsFile(dir, current => ({ ...current,
    appearance: { ...current.appearance, agentColors: AgentColors.parse(agentColors) } }))).rejects.toThrow("256 KB");
  expect(await readFile(path, "utf8")).toBe(before);
});

it("keeps public ignored-key notices after many invalid private colours", async () => {
  const dir = await createTestScratch("agent-colors-notices-");
  await writeFile(join(dir, USER_SETTINGS_FILE), JSON.stringify({ ...DEFAULT_USER_SETTINGS,
    appearance: { ...DEFAULT_USER_SETTINGS.appearance,
      agentColors: Object.fromEntries(Array.from({ length: 60 }, (_, n) => [String(n), "olive"])) },
    unknownSetting: true }));
  expect((await readUserSettingsFile(dir)).ignored).toEqual([{ key: "unknownSetting", reason: "unknown" }]);
});

it("moves agents to the front of the file and keeps every other entry, a broken one too, in its place", async () => {
  const dir = await createTestScratch("dohc-user-settings-order-");
  const path = join(dir, USER_SETTINGS_FILE);
  await writeFile(path, JSON.stringify({
    ...DEFAULT_USER_SETTINGS,
    agents: { default: testAgent({ name: "Claude Code" }), broken: { name: 7 }, codex: testAgent({ name: "Codex" }), extra: testAgent({ name: "Extra" }) },
    unknownSetting: true,
  }));
  const fileAgents = async () => Object.keys(JSON.parse(await readFile(path, "utf8")).agents);
  const moved = await orderUserSettingsAgents(dir, ["codex", "missing"]);
  expect(Object.keys(moved.settings.agents)).toEqual(["codex", "default", "extra"]);
  expect(await fileAgents()).toEqual(["codex", "default", "broken", "extra"]);
  const raw = JSON.parse(await readFile(path, "utf8"));
  expect(raw.agents.broken).toEqual({ name: 7 });
  expect(raw.unknownSetting).toBe(true);
  // Undo passes the order the file had.
  await orderUserSettingsAgents(dir, ["default", "broken", "codex", "extra"]);
  expect(await fileAgents()).toEqual(["default", "broken", "codex", "extra"]);
});

it("takes an agent out of the file when a save leaves it out", async () => {
  const dir = await createTestScratch("dohc-user-settings-remove-");
  const base = { ...DEFAULT_USER_SETTINGS, agents: { default: testAgent({ name: "Claude Code" }), codex: testAgent({ name: "Codex" }) } };
  await writeFile(join(dir, USER_SETTINGS_FILE), JSON.stringify(base));
  const { codex: _codex, ...agents } = base.agents;
  await writeUserSettingsFile(dir, { ...base, agents }, base);
  expect(Object.keys(JSON.parse(await readFile(join(dir, USER_SETTINGS_FILE), "utf8")).agents)).toEqual(["default"]);
});
