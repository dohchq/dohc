import { mkdir, mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { MAX_PLUGIN_ICON_BYTES, verifyPluginIcon } from "./pluginIcon";

let root: string;
let pluginRoot: string;

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), "dohc-plugin-icon-"));
  pluginRoot = join(root, "plugins", "example");
  await mkdir(pluginRoot, { recursive: true });
});

afterEach(async () => {
  await rm(root, { recursive: true, force: true });
});

describe("verifyPluginIcon", () => {
  it("advertises an icon that is a real file inside the plugin root", async () => {
    await mkdir(join(pluginRoot, "assets"));
    await writeFile(join(pluginRoot, "assets", "icon.png"), "png bytes");

    expect(await verifyPluginIcon(pluginRoot, "assets/icon.png")).toEqual({
      icon: "assets/icon.png",
      diagnostic: null,
    });
  });

  it("accepts an icon under a '..'-prefixed directory NAME inside the root", async () => {
    // MUTATION (..-segment): a bare "..-prefix" isInside refuses this real contained name.
    await mkdir(join(pluginRoot, "..cache"));
    await writeFile(join(pluginRoot, "..cache", "icon.png"), "png bytes");

    expect(await verifyPluginIcon(pluginRoot, "..cache/icon.png")).toEqual({
      icon: "..cache/icon.png",
      diagnostic: null,
    });
  });

  it("refuses an icon that is not there, and names the path", async () => {
    const result = await verifyPluginIcon(pluginRoot, "icon.png");

    expect(result.icon).toBeNull();
    expect(result.diagnostic).toContain(join(pluginRoot, "icon.png"));
    expect(result.diagnostic).toContain("could not be read");
  });

  it("refuses an icon over the cap, naming the limit, the unit, and what it found", async () => {
    const oversize = MAX_PLUGIN_ICON_BYTES + 1;
    await writeFile(join(pluginRoot, "icon.png"), Buffer.alloc(oversize));

    const result = await verifyPluginIcon(pluginRoot, "icon.png");

    expect(result.icon).toBeNull();
    expect(result.diagnostic).toContain("must be 512 KiB");
    expect(result.diagnostic).toContain(`${MAX_PLUGIN_ICON_BYTES} bytes`);
    expect(result.diagnostic).toContain(`found ${oversize} bytes`);
  });

  it("accepts an icon exactly at the cap", async () => {
    await writeFile(
      join(pluginRoot, "icon.png"),
      Buffer.alloc(MAX_PLUGIN_ICON_BYTES),
    );

    expect((await verifyPluginIcon(pluginRoot, "icon.png")).icon)
      .toBe("icon.png");
  });

  it("refuses a directory wearing an icon's name", async () => {
    await mkdir(join(pluginRoot, "icon.png"));

    const result = await verifyPluginIcon(pluginRoot, "icon.png");

    expect(result.icon).toBeNull();
    expect(result.diagnostic).toContain("is not a readable file");
  });

  it("refuses a symlinked icon even when it points inside the root", async () => {
    await writeFile(join(pluginRoot, "real.png"), "png bytes");
    try {
      await symlink(join(pluginRoot, "real.png"), join(pluginRoot, "icon.png"));
    } catch {
      // Windows without developer mode refuses to create the link at all,
      // which is the same outcome this test is about.
      return;
    }

    const result = await verifyPluginIcon(pluginRoot, "icon.png");

    expect(result.icon).toBeNull();
    expect(result.diagnostic).toContain("is not a readable file");
  });

  it("refuses an icon that resolves outside the plugin root", async () => {
    // The schema already refuses ".." in the declared path, so the escape
    // that can still reach here is a link inside the root pointing out of it.
    const outside = join(root, "outside.png");
    await writeFile(outside, "png bytes");
    await mkdir(join(pluginRoot, "assets"));
    try {
      await symlink(join(root, "outside.png"), join(pluginRoot, "assets", "link.png"));
    } catch {
      return;
    }

    const result = await verifyPluginIcon(pluginRoot, "assets/link.png");

    expect(result.icon).toBeNull();
    expect(result.diagnostic).toContain("is not a readable file");
  });

  it("refuses an icon reached through a directory link out of the root", async () => {
    // Nothing on the icon's own path is a link: `assets` is, and lstat
    // follows it. Only comparing real path to real path catches this one.
    // A junction rather than a symlink, so Windows runs the check too
    // instead of skipping it for want of developer mode.
    const outside = join(root, "outside");
    await mkdir(outside);
    await writeFile(join(outside, "icon.png"), "png bytes");
    await symlink(outside, join(pluginRoot, "assets"), "junction");

    const result = await verifyPluginIcon(pluginRoot, "assets/icon.png");

    expect(result.icon).toBeNull();
    expect(result.diagnostic).toContain(join(outside, "icon.png"));
    expect(result.diagnostic).toContain("outside the plugin root");
  });

  it("refuses a path that escapes the root before it touches the disk", async () => {
    const result = await verifyPluginIcon(pluginRoot, "../../escape.png");

    expect(result.icon).toBeNull();
    expect(result.diagnostic).toContain("outside the plugin root");
  });
});
