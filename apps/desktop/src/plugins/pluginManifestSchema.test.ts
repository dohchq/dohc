import { describe, expect, it } from "vitest";
import { OpenExternalUrlPayload } from "../ipc/bridgeContract";
import { MAX_PLUGIN_MANIFEST_FILE_BYTES } from "./pluginManifest";
import { DEFAULT_DRIVER_ID_MAX_LENGTH } from "@dohc/workspace-contracts/workspace-settings-values";
import {
  DohcPluginManifest,
  MAX_PLUGIN_DRIVERS,
  MAX_PLUGIN_DESCRIPTION_CHARS,
  MAX_PLUGIN_LICENSE_CHARS,
  MAX_PLUGIN_PUBLISHER_CHARS,
  MAX_PLUGIN_SETTINGS,
  MAX_PLUGIN_URL_CHARS,
  MAX_PLUGIN_VERSION_CHARS,
  MAX_SETTING_OPTIONS,
  MAX_SETTING_VALUE_CHARS,
} from "./pluginManifestSchema";

const minimalManifest = {
  version: 1,
  name: "@dohc/example-plugin",
  entry: "dist/index.js",
} as const;

describe("DohcPluginManifest", () => {
  it("parses a valid minimal manifest", () => {
    expect(DohcPluginManifest.parse(minimalManifest)).toEqual(minimalManifest);
  });

  it("parses panels and commands and normalizes their paths", () => {
    expect(DohcPluginManifest.parse({
      ...minimalManifest,
      entry: "dist\\index.js",
      panels: [
        { id: "main", title: "Main", entry: "panel/./index.html" },
        { id: "tools", title: "Tools", entry: "panel\\tools\\index.html" },
      ],
      commands: [{ id: "open", title: "Open plugin" }],
    })).toEqual({
      ...minimalManifest,
      panels: [
        { id: "main", title: "Main", entry: "panel/index.html" },
        { id: "tools", title: "Tools", entry: "panel/tools/index.html" },
      ],
      commands: [{ id: "open", title: "Open plugin" }],
    });
  });

  it.each([
    ["missing", { name: "example", entry: "index.js" }],
    ["future", { ...minimalManifest, version: 2 }],
    ["string", { ...minimalManifest, version: "1" }],
  ])("rejects a %s version", (_case, manifest) => {
    expect(DohcPluginManifest.safeParse(manifest).success).toBe(false);
  });

  it.each([
    ["POSIX absolute path", "/index.js"],
    ["Windows drive path", "C:\\index.js"],
    ["parent segment", "dist/../index.js"],
    ["empty path", ""],
  ])("rejects an entry with a %s", (_case, entry) => {
    expect(DohcPluginManifest.safeParse({ ...minimalManifest, entry }).success).toBe(false);
  });

  it("rejects an entry over 1024 characters", () => {
    const result = DohcPluginManifest.safeParse({
      ...minimalManifest,
      entry: "a".repeat(1025),
    });

    if (result.success) throw new Error("expected the entry limit to reject the manifest");
    expect(result.error.issues).toContainEqual(expect.objectContaining({
      message: "must be 1024 characters or fewer",
    }));
  });

  it("rejects unknown top-level fields", () => {
    expect(DohcPluginManifest.safeParse({
      ...minimalManifest,
      unsupported: true,
    }).success).toBe(false);
  });

  it.each([
    ["panel", {
      panels: [{ id: "main", title: "Main", entry: "panel.html", unsupported: true }],
    }],
    ["command", {
      commands: [{ id: "open", title: "Open", unsupported: true }],
    }],
  ])("rejects unknown fields in a %s", (_case, fields) => {
    expect(DohcPluginManifest.safeParse({ ...minimalManifest, ...fields }).success).toBe(false);
  });

  it.each([
    ["uppercase", "Example"],
    ["spaces", "example plugin"],
  ])("rejects a name with %s", (_case, name) => {
    expect(DohcPluginManifest.safeParse({ ...minimalManifest, name }).success).toBe(false);
  });

  it("accepts a 214-character name and reports the limit for 215 characters", () => {
    expect(DohcPluginManifest.safeParse({
      ...minimalManifest,
      name: "a".repeat(214),
    }).success).toBe(true);

    const result = DohcPluginManifest.safeParse({
      ...minimalManifest,
      name: "a".repeat(215),
    });
    if (result.success) throw new Error("expected the name limit to reject the manifest");
    expect(result.error.issues.map((issue) => issue.message).join("; ")).toContain("214");
  });

  it("rejects duplicate panel ids", () => {
    expect(DohcPluginManifest.safeParse({
      ...minimalManifest,
      panels: [
        { id: "main", title: "Main", entry: "main.html" },
        { id: "main", title: "Other", entry: "other.html" },
      ],
    }).success).toBe(false);
  });

  it("rejects a panel id containing the authority-key delimiter", () => {
    expect(DohcPluginManifest.safeParse({
      ...minimalManifest,
      panels: [
        { id: "main\0alias", title: "Main", entry: "main.html" },
      ],
    }).success).toBe(false);
  });

  it("rejects more than 100 panels", () => {
    const result = DohcPluginManifest.safeParse({
      ...minimalManifest,
      panels: Array.from({ length: 101 }, (_, index) => ({
        id: `p${index}`,
        title: `P${index}`,
        entry: `p${index}.html`,
      })),
    });

    if (result.success) throw new Error("expected the panel limit to reject the manifest");
    expect(result.error.issues).toContainEqual(expect.objectContaining({
      message: "panels: at most 100 entries allowed",
    }));
  });

  it("rejects duplicate command ids", () => {
    expect(DohcPluginManifest.safeParse({
      ...minimalManifest,
      commands: [
        { id: "open", title: "Open" },
        { id: "open", title: "Open another" },
      ],
    }).success).toBe(false);
  });

  it("accepts a web app contribution and parses it", () => {
    const result = DohcPluginManifest.safeParse({
      ...minimalManifest,
      webApps: [{ id: "app", title: "T3 Code" }],
    });
    if (!result.success) throw new Error(result.error.message);
    // A web app opens one tab unless it says otherwise, so a manifest that
    // never heard of instances parses into the shape it always meant.
    expect(result.data.webApps).toEqual([
      { id: "app", title: "T3 Code", instanced: false },
    ]);
  });

  it("accepts a web app that opens one tab per instance", () => {
    const result = DohcPluginManifest.safeParse({
      ...minimalManifest,
      webApps: [{ id: "preview", title: "Preview", instanced: true }],
    });
    if (!result.success) throw new Error(result.error.message);
    expect(result.data.webApps).toEqual([
      { id: "preview", title: "Preview", instanced: true },
    ]);
  });

  it("rejects a non-boolean instanced flag", () => {
    const result = DohcPluginManifest.safeParse({
      ...minimalManifest,
      webApps: [{ id: "preview", title: "Preview", instanced: "yes" }],
    });
    if (result.success) throw new Error("expected a non-boolean instanced to reject");
  });

  it("rejects duplicate web app ids", () => {
    const result = DohcPluginManifest.safeParse({
      ...minimalManifest,
      webApps: [
        { id: "app", title: "One" },
        { id: "app", title: "Two" },
      ],
    });
    if (result.success) throw new Error("expected duplicate web app ids to reject");
    expect(result.error.issues).toContainEqual(expect.objectContaining({
      message: 'web app id "app" must be unique within webApps',
    }));
  });

  it("rejects more than 100 web apps", () => {
    const result = DohcPluginManifest.safeParse({
      ...minimalManifest,
      webApps: Array.from({ length: 101 }, (_, index) => ({
        id: `a${index}`,
        title: `A${index}`,
      })),
    });
    if (result.success) throw new Error("expected the web app limit to reject the manifest");
    expect(result.error.issues).toContainEqual(expect.objectContaining({
      message: "webApps: at most 100 entries allowed",
    }));
  });

  it("accepts a driver contribution and parses it", () => {
    const result = DohcPluginManifest.safeParse({
      ...minimalManifest,
      drivers: [{ id: "claude-code", displayName: "Claude Code" }],
    });
    if (!result.success) throw new Error(result.error.message);
    expect(result.data.drivers).toEqual([
      { id: "claude-code", displayName: "Claude Code" },
    ]);
  });

  it("rejects duplicate driver ids", () => {
    const result = DohcPluginManifest.safeParse({
      ...minimalManifest,
      drivers: [
        { id: "claude-code", displayName: "One" },
        { id: "claude-code", displayName: "Two" },
      ],
    });
    if (result.success) throw new Error("expected duplicate driver ids to reject");
    expect(result.error.issues).toContainEqual(expect.objectContaining({
      message: 'driver id "claude-code" must be unique within drivers',
    }));
  });

  it(`rejects more than ${MAX_PLUGIN_DRIVERS} drivers, naming the cap`, () => {
    const result = DohcPluginManifest.safeParse({
      ...minimalManifest,
      drivers: Array.from({ length: MAX_PLUGIN_DRIVERS + 1 }, (_, index) => ({
        id: `d${index}`,
        displayName: `D${index}`,
      })),
    });
    if (result.success) throw new Error("expected the driver limit to reject the manifest");
    expect(result.error.issues).toContainEqual(expect.objectContaining({
      message: `drivers: at most ${MAX_PLUGIN_DRIVERS} entries allowed`,
    }));
    // The cap admits exactly what it names.
    expect(DohcPluginManifest.safeParse({
      ...minimalManifest,
      drivers: Array.from({ length: MAX_PLUGIN_DRIVERS }, (_, index) => ({
        id: `d${index}`,
        displayName: `D${index}`,
      })),
    }).success).toBe(true);
  });

  it("bounds a driver id by what workspace settings can store", () => {
    const fits = "d".repeat(DEFAULT_DRIVER_ID_MAX_LENGTH);
    expect(DohcPluginManifest.safeParse({
      ...minimalManifest,
      drivers: [{ id: fits, displayName: "Long" }],
    }).success).toBe(true);
    const result = DohcPluginManifest.safeParse({
      ...minimalManifest,
      drivers: [{ id: `${fits}d`, displayName: "Too long" }],
    });
    if (result.success) throw new Error("expected an over-long driver id to reject");
    expect(result.error.issues).toContainEqual(expect.objectContaining({
      message: `must be ${DEFAULT_DRIVER_ID_MAX_LENGTH} characters or fewer`,
    }));
  });

  it("rejects a driver id a settings file could not hold plainly", () => {
    for (const id of ["", ".leading", "has space", "has/slash", "nul\0byte"]) {
      expect(DohcPluginManifest.safeParse({
        ...minimalManifest,
        drivers: [{ id, displayName: "Bad" }],
      }).success).toBe(false);
    }
  });

  it("rejects a driver with unknown keys or a missing display name", () => {
    expect(DohcPluginManifest.safeParse({
      ...minimalManifest,
      drivers: [{ id: "claude-code", displayName: "Claude Code", entry: "driver.js" }],
    }).success).toBe(false);
    expect(DohcPluginManifest.safeParse({
      ...minimalManifest,
      drivers: [{ id: "claude-code" }],
    }).success).toBe(false);
  });

  it("rejects a web app with unknown keys or an entry path", () => {
    expect(DohcPluginManifest.safeParse({
      ...minimalManifest,
      webApps: [{ id: "app", title: "T3 Code", entry: "index.html" }],
    }).success).toBe(false);
  });

  it("rejects more than 200 commands", () => {
    const result = DohcPluginManifest.safeParse({
      ...minimalManifest,
      commands: Array.from({ length: 201 }, (_, index) => ({
        id: `c${index}`,
        title: `C${index}`,
      })),
    });

    if (result.success) throw new Error("expected the command limit to reject the manifest");
    expect(result.error.issues).toContainEqual(expect.objectContaining({
      message: "commands: at most 200 entries allowed",
    }));
  });

  describe("metadata", () => {
    it("parses a description, publisher, and icon", () => {
      expect(DohcPluginManifest.parse({
        ...minimalManifest,
        description: "Runs a coding agent on this workspace.",
        publisher: "dohc",
        icon: "assets\\./icon.png",
      })).toEqual({
        ...minimalManifest,
        description: "Runs a coding agent on this workspace.",
        publisher: "dohc",
        // Normalized by the same path rule every other plugin path uses.
        icon: "assets/icon.png",
      });
    });

    it("names the limit when a description is too long", () => {
      const result = DohcPluginManifest.safeParse({
        ...minimalManifest,
        description: "a".repeat(MAX_PLUGIN_DESCRIPTION_CHARS + 1),
      });

      if (result.success) throw new Error("expected the description limit to reject the manifest");
      expect(result.error.issues).toContainEqual(expect.objectContaining({
        message: `description: must be ${MAX_PLUGIN_DESCRIPTION_CHARS} characters or fewer`,
      }));
      expect(DohcPluginManifest.safeParse({
        ...minimalManifest,
        description: "a".repeat(MAX_PLUGIN_DESCRIPTION_CHARS),
      }).success).toBe(true);
    });

    it("parses a version, repository, issues, and license", () => {
      expect(DohcPluginManifest.parse({
        ...minimalManifest,
        pluginVersion: "0.0.33",
        repository: "https://github.com/pingdotgg/t3code",
        issues: "https://github.com/pingdotgg/t3code/issues",
        license: "MIT",
      })).toEqual({
        ...minimalManifest,
        pluginVersion: "0.0.33",
        repository: "https://github.com/pingdotgg/t3code",
        issues: "https://github.com/pingdotgg/t3code/issues",
        license: "MIT",
      });
    });

    // Display only. dohc's version-of-record is the approved content hash, so
    // a manifest may call its build whatever the author calls it.
    it.each([
      ["semver", "1.2.3"],
      ["a prerelease and build tag", "10.20.30-rc.1+build.20260817"],
      ["a date", "2026.08.17"],
      ["a word", "nightly"],
    ])("accepts %s as a version", (_case, pluginVersion) => {
      expect(
        DohcPluginManifest.safeParse({ ...minimalManifest, pluginVersion })
          .success,
      ).toBe(true);
    });

    // The caps themselves, stated as numbers. Every other limit test here
    // reads its constant, which proves the wording and the boundary but
    // cannot notice the constant moving — widen the constant and the test
    // widens with it. These record the decision, so a change to a limit that
    // rejects real work has to be a deliberate edit.
    it("holds the measured metadata caps", () => {
      // 40 clears every version scheme measured: semver with a prerelease and
      // build tag reached 28 characters, and no dated scheme reached 30.
      expect(MAX_PLUGIN_VERSION_CHARS).toBe(40);
      // The bound every other display name in this manifest carries.
      expect(MAX_PLUGIN_LICENSE_CHARS).toBe(120);
    });

    // A manifest URL exists to be opened, and the audited open path caps the
    // URL it accepts. If these two ever disagree, a manifest is accepting a
    // link that every click refuses.
    it("caps a URL exactly where the external-open path caps it", () => {
      const atCap = `https://example.com/${"a".repeat(MAX_PLUGIN_URL_CHARS - 20)}`;
      expect(atCap.length).toBe(MAX_PLUGIN_URL_CHARS);
      const overCap = `${atCap}a`;

      expect(OpenExternalUrlPayload.safeParse({ url: atCap }).success).toBe(true);
      expect(
        DohcPluginManifest.safeParse({ ...minimalManifest, repository: atCap })
          .success,
      ).toBe(true);

      expect(OpenExternalUrlPayload.safeParse({ url: overCap }).success)
        .toBe(false);
      expect(
        DohcPluginManifest.safeParse({ ...minimalManifest, repository: overCap })
          .success,
      ).toBe(false);
    });

    it("names the limit when a version is too long", () => {
      const result = DohcPluginManifest.safeParse({
        ...minimalManifest,
        pluginVersion: "a".repeat(MAX_PLUGIN_VERSION_CHARS + 1),
      });

      if (result.success) throw new Error("expected the version limit to reject the manifest");
      expect(result.error.issues).toContainEqual(expect.objectContaining({
        message: `pluginVersion: must be ${MAX_PLUGIN_VERSION_CHARS} characters or fewer`,
      }));
      expect(DohcPluginManifest.safeParse({
        ...minimalManifest,
        pluginVersion: "a".repeat(MAX_PLUGIN_VERSION_CHARS),
      }).success).toBe(true);
    });

    it("names the limit when a license is too long", () => {
      const result = DohcPluginManifest.safeParse({
        ...minimalManifest,
        license: "a".repeat(MAX_PLUGIN_LICENSE_CHARS + 1),
      });

      if (result.success) throw new Error("expected the license limit to reject the manifest");
      expect(result.error.issues).toContainEqual(expect.objectContaining({
        message: `license: must be ${MAX_PLUGIN_LICENSE_CHARS} characters or fewer`,
      }));
      expect(DohcPluginManifest.safeParse({
        ...minimalManifest,
        license: "a".repeat(MAX_PLUGIN_LICENSE_CHARS),
      }).success).toBe(true);
    });

    // These URLs are handed to the OS browser. http: would send the reader
    // somewhere a network can rewrite, and the rest are not web addresses at
    // all — one of them executes.
    it.each([
      ["repository", "http://github.com/dohc/plugin"],
      ["repository", "javascript:alert(1)"],
      ["repository", "file:///etc/passwd"],
      ["repository", "github.com/dohc/plugin"],
      ["issues", "http://github.com/dohc/plugin/issues"],
      ["issues", "not a url"],
    ] as const)("refuses a %s that is not an https URL: %s", (field, value) => {
      const result = DohcPluginManifest.safeParse({
        ...minimalManifest,
        [field]: value,
      });

      if (result.success) throw new Error(`expected ${field} "${value}" to be refused`);
      expect(result.error.issues).toContainEqual(expect.objectContaining({
        message: "must be an https:// URL",
      }));
    });

    // The manifest must never accept a URL the audited open path then
    // refuses: OpenExternalUrlPayload caps the same 2048 characters.
    it("names the limit when a repository URL is too long", () => {
      const tooLong = `https://example.com/${"a".repeat(MAX_PLUGIN_URL_CHARS)}`;
      const result = DohcPluginManifest.safeParse({
        ...minimalManifest,
        repository: tooLong,
      });

      if (result.success) throw new Error("expected the URL limit to reject the manifest");
      expect(result.error.issues).toContainEqual(expect.objectContaining({
        message: `must be ${MAX_PLUGIN_URL_CHARS} characters or fewer`,
      }));
      expect(DohcPluginManifest.safeParse({
        ...minimalManifest,
        repository: `https://example.com/${"a".repeat(MAX_PLUGIN_URL_CHARS - 20)}`,
      }).success).toBe(true);
    });

    it("names the limit when a publisher is too long", () => {
      const result = DohcPluginManifest.safeParse({
        ...minimalManifest,
        publisher: "a".repeat(MAX_PLUGIN_PUBLISHER_CHARS + 1),
      });

      if (result.success) throw new Error("expected the publisher limit to reject the manifest");
      expect(result.error.issues).toContainEqual(expect.objectContaining({
        message: `publisher: must be ${MAX_PLUGIN_PUBLISHER_CHARS} characters or fewer`,
      }));
    });

    it.each([
      ["POSIX absolute path", "/icon.png"],
      ["Windows drive path", "C:\\icon.png"],
      ["parent segment", "../icon.png"],
      ["nested escape", "assets/../../icon.png"],
      ["empty path", ""],
    ])("refuses an icon with a %s", (_case, icon) => {
      const result = DohcPluginManifest.safeParse({ ...minimalManifest, icon });

      if (result.success) throw new Error("expected the icon path rule to reject the manifest");
      expect(result.error.issues).toContainEqual(expect.objectContaining({
        message:
          "must be a non-empty plugin-root-relative path without NUL bytes, " +
          "absolute prefixes, or '..' segments",
      }));
    });

    it.each([
      ["a format dohc cannot serve", "icon.ico"],
      ["no extension at all", "icon"],
      ["an executable wearing an image name", "icon.png.exe"],
    ])("refuses an icon that is %s", (_case, icon) => {
      const result = DohcPluginManifest.safeParse({ ...minimalManifest, icon });

      if (result.success) throw new Error("expected the icon format rule to reject the manifest");
      expect(result.error.issues).toContainEqual(expect.objectContaining({
        message: "icon: must be a .png or .svg file",
      }));
    });

    it.each(["icon.png", "icon.svg", "assets/Logo.SVG"])(
      "accepts %s",
      (icon) => {
        expect(DohcPluginManifest.safeParse({ ...minimalManifest, icon }).success)
          .toBe(true);
      },
    );

    it("rejects an empty description or publisher rather than storing a blank line", () => {
      expect(DohcPluginManifest.safeParse({ ...minimalManifest, description: "" }).success)
        .toBe(false);
      expect(DohcPluginManifest.safeParse({ ...minimalManifest, publisher: "" }).success)
        .toBe(false);
    });
  });

  it("keeps a real plugin's manifest, metadata at every bound, far inside the reader's byte cap", () => {
    // What a shipping manifest actually looks like — t3-code's shape — with
    // every metadata string at its maximum. This is the size that has to fit,
    // and it has to fit with obvious room.
    const realistic = {
      version: 1,
      name: "t3-code",
      displayName: "a".repeat(120),
      description: "a".repeat(MAX_PLUGIN_DESCRIPTION_CHARS),
      publisher: "a".repeat(MAX_PLUGIN_PUBLISHER_CHARS),
      icon: "icon.svg",
      entry: "src/main.ts",
      webApps: [{ id: "app", title: "T3 Code" }],
      allowSkippedScripts: Array.from({ length: 12 }, (_, index) => `pkg-${index}`),
    };

    expect(DohcPluginManifest.safeParse(realistic).success).toBe(true);
    expect(Buffer.byteLength(JSON.stringify(realistic), "utf8"))
      .toBeLessThan(MAX_PLUGIN_MANIFEST_FILE_BYTES / 100);
  });

  it("leaves the reader's byte gate, not this schema, to refuse a manifest at every bound", () => {
    // The schema's per-field bounds multiply past the file cap: 100 panels
    // carrying 1,024-character entry paths alone spend half of it. That is
    // not a defect — readPluginManifestFile checks the file's size before it
    // parses anything, so a manifest this large is refused by size with the
    // cap named. Measured here so the note above the schema states the real
    // relationship instead of an arithmetic sum that drifts every time a
    // field is added. Do NOT "fix" this by raising the reader's cap.
    const fill = (length: number) => "a".repeat(length);
    const largest = {
      version: 1,
      name: fill(214),
      displayName: fill(120),
      description: fill(MAX_PLUGIN_DESCRIPTION_CHARS),
      publisher: fill(MAX_PLUGIN_PUBLISHER_CHARS),
      icon: `${fill(1020)}.png`,
      entry: fill(1024),
      panels: Array.from({ length: 100 }, (_, index) => ({
        id: `${index}`.padEnd(120, "a"),
        title: fill(120),
        entry: fill(1024),
      })),
      commands: Array.from({ length: 200 }, (_, index) => ({
        id: `${index}`.padEnd(120, "a"),
        title: fill(120),
      })),
      webApps: Array.from({ length: 100 }, (_, index) => ({
        id: `${index}`.padEnd(120, "a"),
        title: fill(120),
      })),
      allowSkippedScripts: Array.from({ length: 300 }, (_, index) =>
        `${index}`.padEnd(214, "a")),
    };

    expect(DohcPluginManifest.safeParse(largest).success).toBe(true);
    expect(Buffer.byteLength(JSON.stringify(largest), "utf8"))
      .toBeGreaterThan(MAX_PLUGIN_MANIFEST_FILE_BYTES);
  });

  it("costs the reader almost nothing to declare metadata", () => {
    // The three metadata fields are bounded so that adding all of them to a
    // manifest cannot meaningfully move it toward the file cap.
    const withoutMetadata = { ...minimalManifest };
    const withMetadata = {
      ...minimalManifest,
      description: "a".repeat(MAX_PLUGIN_DESCRIPTION_CHARS),
      publisher: "a".repeat(MAX_PLUGIN_PUBLISHER_CHARS),
      icon: `${"a".repeat(1020)}.png`,
    };

    const cost = Buffer.byteLength(JSON.stringify(withMetadata), "utf8") -
      Buffer.byteLength(JSON.stringify(withoutMetadata), "utf8");
    expect(cost).toBeLessThan(MAX_PLUGIN_MANIFEST_FILE_BYTES / 100);
  });

  describe("settings", () => {
    const stringSetting = {
      key: "greeting",
      type: "string",
      label: "Greeting",
      description: "What the note says.",
      default: "Hello",
    } as const;

    it("parses one setting of each declared type", () => {
      const settings = [
        stringSetting,
        { key: "shout", type: "boolean", label: "Shout", default: false },
        { key: "repeat", type: "number", label: "Repeat", default: 2 },
        {
          key: "tone",
          type: "select",
          label: "Tone",
          default: "plain",
          options: ["plain", "warm"],
        },
      ];

      expect(DohcPluginManifest.parse({ ...minimalManifest, settings }))
        .toEqual({ ...minimalManifest, settings });
    });

    it("refuses a default that is the wrong type for its setting", () => {
      for (
        const setting of [
          { key: "a", type: "string", label: "A", default: true },
          { key: "a", type: "boolean", label: "A", default: "yes" },
          { key: "a", type: "number", label: "A", default: "3" },
        ]
      ) {
        expect(
          DohcPluginManifest.safeParse({ ...minimalManifest, settings: [setting] })
            .success,
        ).toBe(false);
      }
    });

    it("refuses a number default that JSON cannot hold", () => {
      expect(DohcPluginManifest.safeParse({
        ...minimalManifest,
        settings: [
          { key: "a", type: "number", label: "A", default: Number.NaN },
        ],
      }).success).toBe(false);
      expect(DohcPluginManifest.safeParse({
        ...minimalManifest,
        settings: [
          { key: "a", type: "number", label: "A", default: Number.POSITIVE_INFINITY },
        ],
      }).success).toBe(false);
    });

    it("refuses a select whose default is not one of its options", () => {
      const result = DohcPluginManifest.safeParse({
        ...minimalManifest,
        settings: [{
          key: "tone",
          type: "select",
          label: "Tone",
          default: "loud",
          options: ["plain", "warm"],
        }],
      });

      if (result.success) throw new Error("expected the select default to be rejected");
      expect(result.error.issues).toContainEqual(expect.objectContaining({
        message: 'select default "loud" must be one of its options',
      }));
    });

    it("refuses duplicate options and a select with none", () => {
      expect(DohcPluginManifest.safeParse({
        ...minimalManifest,
        settings: [{
          key: "tone",
          type: "select",
          label: "Tone",
          default: "plain",
          options: ["plain", "plain"],
        }],
      }).success).toBe(false);
      expect(DohcPluginManifest.safeParse({
        ...minimalManifest,
        settings: [{
          key: "tone",
          type: "select",
          label: "Tone",
          default: "plain",
          options: [],
        }],
      }).success).toBe(false);
    });

    it("refuses options a select cannot show, naming the limit", () => {
      const result = DohcPluginManifest.safeParse({
        ...minimalManifest,
        settings: [{
          key: "tone",
          type: "select",
          label: "Tone",
          default: "o0",
          options: Array.from(
            { length: MAX_SETTING_OPTIONS + 1 },
            (_, index) => `o${index}`,
          ),
        }],
      });

      if (result.success) throw new Error("expected the option limit to reject the manifest");
      expect(result.error.issues).toContainEqual(expect.objectContaining({
        message: `options: at most ${MAX_SETTING_OPTIONS} entries allowed`,
      }));
    });

    it("refuses more settings than a panel can hold, naming the limit", () => {
      const result = DohcPluginManifest.safeParse({
        ...minimalManifest,
        settings: Array.from(
          { length: MAX_PLUGIN_SETTINGS + 1 },
          (_, index) => ({
            key: `k${index}`,
            type: "string" as const,
            label: `L${index}`,
            default: "",
          }),
        ),
      });

      if (result.success) throw new Error("expected the settings limit to reject the manifest");
      expect(result.error.issues).toContainEqual(expect.objectContaining({
        message: `settings: at most ${MAX_PLUGIN_SETTINGS} entries allowed`,
      }));
    });

    it("refuses two settings sharing a key", () => {
      const result = DohcPluginManifest.safeParse({
        ...minimalManifest,
        settings: [stringSetting, { ...stringSetting, label: "Again" }],
      });

      if (result.success) throw new Error("expected the duplicate key to be rejected");
      expect(result.error.issues).toContainEqual(expect.objectContaining({
        message: 'setting key "greeting" must be unique within settings',
      }));
    });

    it.each([
      ["a space", "my key"],
      ["a leading dash", "-key"],
      ["a slash", "a/b"],
      ["nothing at all", ""],
    ])("refuses a key with %s", (_case, key) => {
      expect(DohcPluginManifest.safeParse({
        ...minimalManifest,
        settings: [{ ...stringSetting, key }],
      }).success).toBe(false);
    });

    it("refuses a string default longer than a setting may hold", () => {
      const result = DohcPluginManifest.safeParse({
        ...minimalManifest,
        settings: [{
          ...stringSetting,
          default: "a".repeat(MAX_SETTING_VALUE_CHARS + 1),
        }],
      });

      if (result.success) throw new Error("expected the value limit to reject the manifest");
      expect(result.error.issues).toContainEqual(expect.objectContaining({
        message: `must be ${MAX_SETTING_VALUE_CHARS} characters or fewer`,
      }));
    });

    it("refuses an unknown key on a setting", () => {
      expect(DohcPluginManifest.safeParse({
        ...minimalManifest,
        settings: [{ ...stringSetting, options: ["a"] }],
      }).success).toBe(false);
    });

    it("declares no settings at all and still parses", () => {
      const parsed = DohcPluginManifest.parse(minimalManifest);
      expect(parsed.settings).toBeUndefined();
    });
  });
});
