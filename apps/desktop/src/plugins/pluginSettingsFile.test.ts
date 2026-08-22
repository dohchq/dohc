import { mkdir, mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { PluginSettingsResult } from "../ipc/bridgeContract";
import {
  MAX_SETTING_VALUE_CHARS,
  type PluginSettingDeclaration,
} from "./pluginManifestSchema";
import {
  MAX_PLUGIN_SETTINGS_FILE_BYTES,
  PLUGIN_SETTINGS_FILE,
  readPluginSettingsFile,
  resolvePluginSettings,
  savePluginSettings,
} from "./pluginSettingsFile";

const roots: string[] = [];

const DECLARED: PluginSettingDeclaration[] = [
  { key: "greeting", type: "string", label: "Greeting", default: "Hello" },
  { key: "shout", type: "boolean", label: "Shout", default: false },
  { key: "repeat", type: "number", label: "Repeat", default: 1 },
  {
    key: "tone",
    type: "select",
    label: "Tone",
    default: "plain",
    options: ["plain", "warm"],
  },
];

let workspaceRoot: string;

beforeEach(async () => {
  workspaceRoot = await mkdtemp(join(tmpdir(), "dohc-plugin-settings-"));
  roots.push(workspaceRoot);
});

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) =>
    rm(root, { recursive: true, force: true })
  ));
});

async function writeSettingsFile(root: string, body: string): Promise<string> {
  const dir = join(root, ".dohc");
  await mkdir(dir, { recursive: true });
  const path = join(dir, PLUGIN_SETTINGS_FILE);
  await writeFile(path, body);
  return path;
}

describe("resolvePluginSettings", () => {
  it("answers with every declared key, defaults where nothing is stored", () => {
    expect(resolvePluginSettings(DECLARED, undefined)).toEqual({
      greeting: "Hello",
      shout: false,
      repeat: 1,
      tone: "plain",
    });
  });

  it("takes a stored value that fits its declaration", () => {
    expect(
      resolvePluginSettings(DECLARED, {
        greeting: "Hei",
        shout: true,
        repeat: 3,
        tone: "warm",
      }),
    ).toEqual({ greeting: "Hei", shout: true, repeat: 3, tone: "warm" });
  });

  it.each([
    ["a string where a boolean was declared", { shout: "yes" }, "shout", false],
    ["a string where a number was declared", { repeat: "3" }, "repeat", 1],
    ["a number where a string was declared", { greeting: 7 }, "greeting", "Hello"],
    ["a select answer that is not an option", { tone: "loud" }, "tone", "plain"],
  ])(
    "falls back to the default for %s",
    (_case, stored, key, expected) => {
      expect(resolvePluginSettings(DECLARED, stored)[key]).toBe(expected);
    },
  );

  it("falls back to the default for a string past the value cap", () => {
    // A hand-edited or synced file can hold any string. The IPC contract
    // cannot: it caps a value at MAX_SETTING_VALUE_CHARS, and a resolved
    // payload that carries an over-long value fails on its way to the
    // renderer — the reader gets a validation error where their settings
    // should be, and no control in the app can put it right.
    const values = resolvePluginSettings(DECLARED, {
      greeting: "x".repeat(5_000),
    });

    expect(values.greeting).toBe("Hello");
    expect(PluginSettingsResult.parse({ ok: true, values })).toEqual({
      ok: true,
      values,
    });
  });

  it("keeps a stored string exactly at the value cap", () => {
    const atCap = "x".repeat(MAX_SETTING_VALUE_CHARS);

    expect(resolvePluginSettings(DECLARED, { greeting: atCap }).greeting)
      .toBe(atCap);
  });

  it("drops a key the manifest does not declare", () => {
    const values = resolvePluginSettings(DECLARED, {
      greeting: "Hei",
      leftover: "from an older manifest",
    });

    expect(values).not.toHaveProperty("leftover");
    expect(Object.keys(values).sort()).toEqual([
      "greeting",
      "repeat",
      "shout",
      "tone",
    ]);
  });

  it("declares nothing, answers with nothing", () => {
    expect(resolvePluginSettings([], { greeting: "Hei" })).toEqual({});
  });
});

describe("readPluginSettingsFile", () => {
  it("reads a workspace nobody has changed a setting in as empty", async () => {
    expect(await readPluginSettingsFile(workspaceRoot)).toEqual({});
  });

  it.each([
    ["a file that is not JSON", "{not json"],
    ["a top-level array", "[]"],
    ["a top-level string", '"nope"'],
  ])("reads %s as empty rather than failing", async (_case, body) => {
    await writeSettingsFile(workspaceRoot, body);

    expect(await readPluginSettingsFile(workspaceRoot)).toEqual({});
  });

  it("reads a file past the size cap as empty, without parsing it", async () => {
    const path = await writeSettingsFile(
      workspaceRoot,
      JSON.stringify({
        "t3-code": {
          greeting: "Hei",
          filler: "x".repeat(MAX_PLUGIN_SETTINGS_FILE_BYTES),
        },
      }),
    );

    expect((await stat(path)).size).toBeGreaterThan(
      MAX_PLUGIN_SETTINGS_FILE_BYTES,
    );
    expect(await readPluginSettingsFile(workspaceRoot)).toEqual({});
  });

  it("keeps the plugins it can read and drops values that are not settings", async () => {
    await writeSettingsFile(
      workspaceRoot,
      JSON.stringify({
        "t3-code": { greeting: "Hei", nested: { no: true }, list: [1] },
        "broken-plugin": "not an object",
      }),
    );

    expect(await readPluginSettingsFile(workspaceRoot)).toEqual({
      "t3-code": { greeting: "Hei" },
    });
  });
});

describe("savePluginSettings", () => {
  it("stores a value and answers with the plugin's complete settings", async () => {
    const values = await savePluginSettings(
      workspaceRoot,
      "hello-plugin",
      "hello-plugin",
      DECLARED,
      { greeting: "Hei" },
    );

    expect(values).toEqual({
      greeting: "Hei",
      shout: false,
      repeat: 1,
      tone: "plain",
    });
    expect(await readPluginSettingsFile(workspaceRoot)).toEqual({
      "hello-plugin": values,
    });
  });

  it("round-trips every declared type", async () => {
    await savePluginSettings(workspaceRoot, "hello-plugin", "hello-plugin", DECLARED, {
      greeting: "Hei",
      shout: true,
      repeat: 3,
      tone: "warm",
    });

    const stored = await readPluginSettingsFile(workspaceRoot);
    expect(stored["hello-plugin"]).toEqual({
      greeting: "Hei",
      shout: true,
      repeat: 3,
      tone: "warm",
    });
  });

  it("refuses a key the plugin does not declare, and names it", async () => {
    await expect(
      savePluginSettings(workspaceRoot, "hello-plugin", "hello-plugin", DECLARED, {
        unknown: "value",
      }),
    ).rejects.toThrow(
      'Plugin "hello-plugin" does not declare a setting named "unknown".',
    );
    expect(await readPluginSettingsFile(workspaceRoot)).toEqual({});
  });

  it.each([
    ["shout", "yes", "boolean"],
    ["repeat", "three", "number"],
    ["greeting", 7, `string of ${MAX_SETTING_VALUE_CHARS} characters or fewer`],
  ])(
    "refuses %s with the wrong type and names the type it wanted",
    async (key, value, typeName) => {
      await expect(
        savePluginSettings(workspaceRoot, "hello-plugin", "hello-plugin", DECLARED, {
          [key]: value,
        }),
      ).rejects.toThrow(new RegExp(`must be a ${typeName}\\.$`));
    },
  );

  it("refuses a string past the value cap, and names the cap", async () => {
    await expect(
      savePluginSettings(workspaceRoot, "hello-plugin", "hello-plugin", DECLARED, {
        greeting: "x".repeat(MAX_SETTING_VALUE_CHARS + 1),
      }),
    ).rejects.toThrow(
      `must be a string of ${MAX_SETTING_VALUE_CHARS} characters or fewer.`,
    );
    expect(await readPluginSettingsFile(workspaceRoot)).toEqual({});
  });

  it("stores a string exactly at the value cap", async () => {
    const atCap = "x".repeat(MAX_SETTING_VALUE_CHARS);

    const values = await savePluginSettings(
      workspaceRoot,
      "hello-plugin",
      "hello-plugin",
      DECLARED,
      { greeting: atCap },
    );

    expect(values.greeting).toBe(atCap);
    expect((await readPluginSettingsFile(workspaceRoot))["hello-plugin"]
      ?.greeting).toBe(atCap);
  });

  it("refuses a select answer that is not an option, and lists the options", async () => {
    await expect(
      savePluginSettings(workspaceRoot, "hello-plugin", "hello-plugin", DECLARED, {
        tone: "loud",
      }),
    ).rejects.toThrow('must be a one of "plain", "warm".');
  });

  it("leaves every other plugin's settings exactly as they were", async () => {
    await savePluginSettings(workspaceRoot, "other-plugin", "other-plugin", DECLARED, {
      greeting: "Salut",
    });
    await savePluginSettings(workspaceRoot, "hello-plugin", "hello-plugin", DECLARED, {
      greeting: "Hei",
    });

    const stored = await readPluginSettingsFile(workspaceRoot);
    expect(stored["other-plugin"]?.greeting).toBe("Salut");
    expect(stored["hello-plugin"]?.greeting).toBe("Hei");
  });

  it("keeps two workspaces' answers apart", async () => {
    const otherWorkspace = await mkdtemp(join(tmpdir(), "dohc-plugin-settings-"));
    roots.push(otherWorkspace);

    await savePluginSettings(workspaceRoot, "hello-plugin", "hello-plugin", DECLARED, {
      greeting: "Hei",
    });
    await savePluginSettings(otherWorkspace, "hello-plugin", "hello-plugin", DECLARED, {
      greeting: "Salut",
    });

    expect(
      (await readPluginSettingsFile(workspaceRoot))["hello-plugin"]?.greeting,
    ).toBe("Hei");
    expect(
      (await readPluginSettingsFile(otherWorkspace))["hello-plugin"]?.greeting,
    ).toBe("Salut");
  });

  it("keeps every concurrent save instead of letting the last one win", async () => {
    // Without the write queue both saves read the same file and the second
    // write drops the first, while both controls report the value they set.
    await Promise.all([
      savePluginSettings(workspaceRoot, "hello-plugin", "hello-plugin", DECLARED, {
        greeting: "Hei",
      }),
      savePluginSettings(workspaceRoot, "hello-plugin", "hello-plugin", DECLARED, {
        repeat: 4,
      }),
      savePluginSettings(workspaceRoot, "other-plugin", "other-plugin", DECLARED, {
        tone: "warm",
      }),
    ]);

    const stored = await readPluginSettingsFile(workspaceRoot);
    expect(stored["hello-plugin"]).toMatchObject({ greeting: "Hei", repeat: 4 });
    expect(stored["other-plugin"]?.tone).toBe("warm");
  });

  it("writes the file as readable text a person can open", async () => {
    await savePluginSettings(workspaceRoot, "hello-plugin", "hello-plugin", DECLARED, {
      greeting: "Hei",
    });

    const body = await readFile(
      join(workspaceRoot, ".dohc", PLUGIN_SETTINGS_FILE),
      "utf8",
    );
    expect(body).toContain('"hello-plugin"');
    expect(body).toContain('"greeting": "Hei"');
    expect(body.endsWith("\n")).toBe(true);
  });

  it("leaves no temporary file behind", async () => {
    await savePluginSettings(workspaceRoot, "hello-plugin", "hello-plugin", DECLARED, {
      greeting: "Hei",
    });

    const { readdir } = await import("node:fs/promises");
    const entries = await readdir(join(workspaceRoot, ".dohc"));
    expect(entries).toEqual([PLUGIN_SETTINGS_FILE]);
  });
});
