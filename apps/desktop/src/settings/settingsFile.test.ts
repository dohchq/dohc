import { describe, expect, it } from "vitest";
import { z } from "zod";
import { overlaySettings, readSettingsLeniently, settingKinds } from "./settingsFile";

const Settings = z.object({
  look: z.object({ theme: z.enum(["light", "dark"]), size: z.number().int() }).strict(),
  name: z.string().min(1).optional(),
  profile: z.object({ tool: z.string(), path: z.string() }).strict().optional(),
}).strict();
type Settings = z.infer<typeof Settings>;
const defaults: Settings = { look: { theme: "light", size: 13 } };

function read(raw: Record<string, unknown>) {
  return readSettingsLeniently({
    raw,
    defaults,
    kind: settingKinds(Settings, defaults),
    parse: (candidate) => {
      const parsed = Settings.safeParse(candidate);
      return parsed.success ? parsed.data : null;
    },
  });
}

describe("settings file rule", () => {
  it("keeps every usable key and names the rest", () => {
    expect(read({
      look: { theme: "dark", size: "big", glow: true },
      name: "",
      profile: { tool: "claude", path: "/bin/claude" },
    })).toEqual({
      settings: {
        look: { theme: "dark", size: 13 },
        profile: { tool: "claude", path: "/bin/claude" },
      },
      ignored: [
        { key: "look.size", reason: "invalid" },
        { key: "look.glow", reason: "unknown" },
        { key: "name", reason: "invalid" },
      ],
    });
  });

  it("uses or ignores an object without defaults as one value", () => {
    expect(read({ profile: { tool: "claude" } })).toEqual({
      settings: defaults,
      ignored: [{ key: "profile", reason: "invalid" }],
    });
  });

  it("reads a file that sets only some keys without naming the rest", () => {
    expect(read({ look: { size: 15 } })).toEqual({
      settings: { look: { theme: "light", size: 15 } },
      ignored: [],
    });
  });

  it("writes only what changed onto the file as the person left it", () => {
    const raw = { look: { size: "big" }, glow: true };
    const current: Settings = { look: { theme: "light", size: 13 }, name: "Ada" };
    expect(overlaySettings(raw, current, {
      look: { theme: "dark", size: 13 },
      profile: { tool: "claude", path: "/bin/claude" },
    })).toEqual({
      look: { size: "big", theme: "dark" },
      glow: true,
      profile: { tool: "claude", path: "/bin/claude" },
    });
    // A group the file holds as something else is replaced only when a
    // setting inside it changes.
    expect(overlaySettings({ look: 7 }, defaults, { look: { theme: "dark", size: 13 } }))
      .toEqual({ look: { theme: "dark" } });
    expect(overlaySettings({ look: 7 }, defaults, defaults)).toEqual({ look: 7 });
  });
});
