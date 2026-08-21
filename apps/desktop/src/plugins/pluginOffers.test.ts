import { randomUUID } from "node:crypto";
import {
  lstat,
  mkdir,
  mkdtemp,
  readdir,
  readFile,
  rm,
  symlink,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  BUILTIN_DRIVER_PLUGIN_DIRECTORY_NAMES,
  BUILTIN_DRIVER_PLUGIN_DISPLAY_NAMES,
} from "../ipc/channels";
import { discoverInstalledPlugins } from "./pluginDiscovery";
import {
  OfferedPluginAddError,
  addOfferedPlugin,
  findDisplacedByAdd,
  listOfferedPlugins,
  removeAddedOfferedPlugin,
} from "./pluginOffers";

// Two narrow, exact-path traps so a test can put another actor's write
// exactly where a real race would land it — mid-publish and mid-restore —
// without timing-dependent interleaving. Each trap fires once, then clears
// itself; every other call passes straight through to the real
// implementation, so the whole rest of this suite runs on real fs behavior.
const raceState = vi.hoisted(() => ({
  mkdirTrap: null as null | { path: string; run: () => Promise<void> },
  lstatTrap: null as null | { path: string; afterCall: number; run: () => Promise<void> },
  lstatCallCounts: new Map<string, number>(),
}));

vi.mock("node:fs/promises", async () => {
  const actual = await vi.importActual<typeof import("node:fs/promises")>("node:fs/promises");
  return {
    ...actual,
    mkdir: async (
      path: Parameters<typeof actual.mkdir>[0],
      options?: Parameters<typeof actual.mkdir>[1],
    ) => {
      const trap = raceState.mkdirTrap;
      if (trap && path === trap.path) {
        raceState.mkdirTrap = null;
        await trap.run();
      }
      return actual.mkdir(path, options);
    },
    lstat: async (
      path: Parameters<typeof actual.lstat>[0],
      options?: Parameters<typeof actual.lstat>[1],
    ) => {
      const trap = raceState.lstatTrap;
      if (trap && path === trap.path) {
        const count = (raceState.lstatCallCounts.get(trap.path) ?? 0) + 1;
        raceState.lstatCallCounts.set(trap.path, count);
        if (count === trap.afterCall) {
          raceState.lstatTrap = null;
          await trap.run();
        }
      }
      return actual.lstat(path, options);
    },
  };
});

const roots: string[] = [];
const NO_EXISTING_PLUGIN_IDS = new Set<string>();

async function createFixture(): Promise<{
  root: string;
  builtinPluginsRoot: string;
  workspaceRoot: string;
}> {
  const root = await mkdtemp(join(tmpdir(), "dohc-plugin-offers-"));
  roots.push(root);
  const builtinPluginsRoot = join(root, "builtin-plugins");
  // A real workspace root always exists before any plugin operation runs —
  // dohc only opens an already-materialized folder — so the fixture matches
  // that rather than leaving addOfferedPlugin's realpath() call to hit an
  // ENOENT this function was never meant to paper over.
  const workspaceRoot = join(root, "workspace");
  await mkdir(workspaceRoot, { recursive: true });

  for (const directoryName of BUILTIN_DRIVER_PLUGIN_DIRECTORY_NAMES) {
    const pluginRoot = join(builtinPluginsRoot, directoryName);
    await mkdir(join(pluginRoot, "src"), { recursive: true });
    await writeFile(
      join(pluginRoot, "dohc-plugin.json"),
      `${JSON.stringify({
        version: 1,
        name: directoryName,
        displayName: `${directoryName} driver`,
        description: `Runs ${directoryName}`,
        publisher: "dohc",
        entry: "src/main.ts",
      }, null, 2)}\n`,
    );
    await writeFile(join(pluginRoot, "src", "main.ts"), "export default {};\n");
  }

  return { root, builtinPluginsRoot, workspaceRoot };
}

afterEach(async () => {
  raceState.mkdirTrap = null;
  raceState.lstatTrap = null;
  raceState.lstatCallCounts.clear();
  await Promise.all(
    roots.splice(0).map((root) =>
      rm(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 }),
    ),
  );
});

describe("listOfferedPlugins", () => {
  it("offers both built-in drivers when neither exists in the workspace", async () => {
    const fixture = await createFixture();

    const offers = await listOfferedPlugins(
      fixture.builtinPluginsRoot,
      fixture.workspaceRoot,
      NO_EXISTING_PLUGIN_IDS,
    );

    expect(offers.map((offer) => offer.directoryName)).toEqual([
      "codex",
      "claude-code",
    ]);
    expect(offers[0]).toMatchObject({
      displayName: "codex driver",
      description: "Runs codex",
      publisher: "dohc",
    });
  });

  it("does not offer a driver whose workspace directory exists in any state", async () => {
    const fixture = await createFixture();
    await mkdir(join(fixture.workspaceRoot, "plugins", "codex"), {
      recursive: true,
    });

    await expect(
      listOfferedPlugins(
        fixture.builtinPluginsRoot,
        fixture.workspaceRoot,
        NO_EXISTING_PLUGIN_IDS,
      ),
    ).resolves.toEqual([
      expect.objectContaining({ directoryName: "claude-code" }),
    ]);
  });

  it("returns no offers when both workspace directories exist", async () => {
    const fixture = await createFixture();
    await Promise.all(
      BUILTIN_DRIVER_PLUGIN_DIRECTORY_NAMES.map((directoryName) =>
        mkdir(join(fixture.workspaceRoot, "plugins", directoryName), {
          recursive: true,
        }),
      ),
    );

    await expect(
      listOfferedPlugins(
        fixture.builtinPluginsRoot,
        fixture.workspaceRoot,
        NO_EXISTING_PLUGIN_IDS,
      ),
    ).resolves.toEqual([]);
  });

  // Identity is the manifest id, not the directory: a driver copied and then
  // renamed by hand (or an agent) still claims the id "codex", and offering
  // "codex" again would only degrade to discovery's existing duplicate-id
  // handling on install, never a clean one.
  it("suppresses an offer whose manifest id already exists under a different directory", async () => {
    const fixture = await createFixture();
    const renamedRoot = join(fixture.workspaceRoot, "plugins", "my-codex");
    await mkdir(join(renamedRoot, "src"), { recursive: true });
    await writeFile(
      join(renamedRoot, "dohc-plugin.json"),
      `${JSON.stringify({ version: 1, name: "codex", entry: "src/main.ts" }, null, 2)}\n`,
    );
    await writeFile(join(renamedRoot, "src", "main.ts"), "export default {};\n");

    const discovered = await discoverInstalledPlugins(fixture.workspaceRoot, new Map());
    const existingPluginIds = new Set(discovered.map((plugin) => plugin.id));

    await expect(
      listOfferedPlugins(fixture.builtinPluginsRoot, fixture.workspaceRoot, existingPluginIds),
    ).resolves.toEqual([
      expect.objectContaining({ directoryName: "claude-code" }),
    ]);
  });

  // A built-in ships with dohc itself — its manifest is never optional the
  // way a hand-authored plugin's is. Silently omitting a broken one read as
  // "nothing to offer," indistinguishable from a workspace that already has
  // both drivers; a broken packaged install must fail loudly instead.
  it("propagates a broken built-in manifest as a real failure, not a silent omission", async () => {
    const fixture = await createFixture();
    await writeFile(
      join(fixture.builtinPluginsRoot, "codex", "dohc-plugin.json"),
      "not valid json",
    );

    await expect(
      listOfferedPlugins(
        fixture.builtinPluginsRoot,
        fixture.workspaceRoot,
        NO_EXISTING_PLUGIN_IDS,
      ),
    ).rejects.toThrow(/codex/);
  });
});

describe("addOfferedPlugin", () => {
  it("copies source files and excludes generated or private directories", async () => {
    const fixture = await createFixture();
    const sourceRoot = join(fixture.builtinPluginsRoot, "codex");
    await Promise.all([
      mkdir(join(sourceRoot, "node_modules", "dependency"), { recursive: true }),
      mkdir(join(sourceRoot, ".dohc"), { recursive: true }),
    ]);
    await Promise.all([
      writeFile(join(sourceRoot, "node_modules", "dependency", "marker"), "no"),
      writeFile(join(sourceRoot, ".dohc", "marker"), "no"),
    ]);

    const result = await addOfferedPlugin({
      builtinPluginsRoot: fixture.builtinPluginsRoot,
      workspaceRoot: fixture.workspaceRoot,
      directoryName: "codex",
      existingPluginIds: NO_EXISTING_PLUGIN_IDS,
    });

    expect(result.rootPath).toBe(join(fixture.workspaceRoot, "plugins", "codex"));
    await expect(readFile(join(result.rootPath, "src", "main.ts"), "utf8"))
      .resolves.toBe("export default {};\n");
    await expect(readFile(join(result.rootPath, "dohc-plugin.json"), "utf8"))
      .resolves.toContain('"name": "codex"');
    for (const excluded of ["node_modules", ".dohc"]) {
      await expect(lstat(join(result.rootPath, excluded))).rejects.toMatchObject({
        code: "ENOENT",
      });
    }
  });

  it("stages under .dohc, never inside plugins/, invisible to discovery", async () => {
    const fixture = await createFixture();
    // A real, already-installed plugin, so discovery is genuinely scanning
    // plugins/ in this test rather than short-circuiting on an absent
    // directory.
    const otherPluginRoot = join(fixture.workspaceRoot, "plugins", "claude-code");
    await mkdir(join(otherPluginRoot, "src"), { recursive: true });
    await writeFile(
      join(otherPluginRoot, "dohc-plugin.json"),
      `${JSON.stringify({ version: 1, name: "claude-code", entry: "src/main.ts" }, null, 2)}\n`,
    );
    await writeFile(join(otherPluginRoot, "src", "main.ts"), "export default {};\n");

    // Simulates a file sitting in the staging path mid-copy: since the
    // staging root lives under workspaceRoot/.dohc rather than
    // workspaceRoot/plugins, discovery — which only ever reads
    // workspaceRoot/plugins/* — structurally cannot see it, at any point in
    // time, not just the moment this snapshot happens to sample.
    const stagingDir = join(
      fixture.workspaceRoot,
      ".dohc",
      "plugin-offer-staging",
      `codex-${randomUUID()}`,
    );
    await mkdir(stagingDir, { recursive: true });
    await writeFile(join(stagingDir, "dohc-plugin.json"), "{}");

    const discovered = await discoverInstalledPlugins(fixture.workspaceRoot, new Map());

    expect(discovered.map((plugin) => plugin.directoryName)).toEqual(["claude-code"]);
  });

  it("refuses an existing target without changing its contents", async () => {
    const fixture = await createFixture();
    const target = join(fixture.workspaceRoot, "plugins", "codex");
    await mkdir(target, { recursive: true });
    await writeFile(join(target, "keep.txt"), "keep");

    await expect(
      addOfferedPlugin({
        builtinPluginsRoot: fixture.builtinPluginsRoot,
        workspaceRoot: fixture.workspaceRoot,
        directoryName: "codex",
        existingPluginIds: NO_EXISTING_PLUGIN_IDS,
      }),
    ).rejects.toSatisfy(
      (error: unknown) =>
        error instanceof OfferedPluginAddError &&
        error.message.includes("plugins/codex"),
    );
    await expect(readFile(join(target, "keep.txt"), "utf8")).resolves.toBe("keep");
    await expect(lstat(join(target, "src"))).rejects.toMatchObject({ code: "ENOENT" });
  });

  // Identity is the manifest id, not the directory: a plugin can be
  // discovered under a DIFFERENT directory between an offer showing and
  // this call landing (a rename, a second copy racing this one). The
  // caller re-samples existingPluginIds right before this call rather than
  // reusing whatever the offer list saw, so this must refuse the same way
  // listOfferedPlugins would already have suppressed the offer.
  it("refuses to add when the manifest id is already claimed under another directory", async () => {
    const fixture = await createFixture();

    await expect(
      addOfferedPlugin({
        builtinPluginsRoot: fixture.builtinPluginsRoot,
        workspaceRoot: fixture.workspaceRoot,
        directoryName: "codex",
        existingPluginIds: new Set(["codex"]),
      }),
    ).rejects.toBeInstanceOf(OfferedPluginAddError);

    await expect(lstat(join(fixture.workspaceRoot, "plugins", "codex"))).rejects.toMatchObject({
      code: "ENOENT",
    });
  });

  it("refuses directory names outside the built-in driver set", async () => {
    const fixture = await createFixture();

    await expect(
      addOfferedPlugin({
        builtinPluginsRoot: fixture.builtinPluginsRoot,
        workspaceRoot: fixture.workspaceRoot,
        directoryName: "sites",
        existingPluginIds: NO_EXISTING_PLUGIN_IDS,
      }),
    ).rejects.toBeInstanceOf(OfferedPluginAddError);
  });

  // A hostile or corrupted sync could plant plugins/ as a junction pointing
  // outside the workspace before this ever runs. mkdir({recursive:true})
  // would follow that transparently, so the fix has to refuse before any
  // write, not merely detect the escape after one already landed.
  it("refuses when plugins/ is a junction pointing outside the workspace", async () => {
    const fixture = await createFixture();
    const outside = await mkdtemp(join(tmpdir(), "dohc-plugin-offers-outside-"));
    roots.push(outside);
    await symlink(
      outside,
      join(fixture.workspaceRoot, "plugins"),
      process.platform === "win32" ? "junction" : "dir",
    );

    await expect(
      addOfferedPlugin({
        builtinPluginsRoot: fixture.builtinPluginsRoot,
        workspaceRoot: fixture.workspaceRoot,
        directoryName: "codex",
        existingPluginIds: NO_EXISTING_PLUGIN_IDS,
      }),
    ).rejects.toBeInstanceOf(OfferedPluginAddError);

    // Nothing landed outside the workspace through the link.
    await expect(readdir(outside)).resolves.toEqual([]);
  });

  // The early existence check at the top of addOfferedPlugin only catches a
  // target that already existed before the copy started. A concurrent
  // creator landing DURING the copy — the actual race this guards — has to
  // be caught by the publish step itself, right where it claims target.
  it("refuses without clobbering a target directory created after the copy started", async () => {
    const fixture = await createFixture();
    const target = join(fixture.workspaceRoot, "plugins", "codex");
    raceState.mkdirTrap = {
      path: target,
      run: async () => {
        await mkdir(target, { recursive: true });
        await writeFile(join(target, "concurrent.txt"), "raced");
      },
    };

    await expect(
      addOfferedPlugin({
        builtinPluginsRoot: fixture.builtinPluginsRoot,
        workspaceRoot: fixture.workspaceRoot,
        directoryName: "codex",
        existingPluginIds: NO_EXISTING_PLUGIN_IDS,
      }),
    ).rejects.toSatisfy(
      (error: unknown) =>
        error instanceof OfferedPluginAddError &&
        error.message.includes("plugins/codex"),
    );

    // The concurrently created directory survived, untouched by this call.
    await expect(readFile(join(target, "concurrent.txt"), "utf8")).resolves.toBe("raced");
    await expect(lstat(join(target, "src"))).rejects.toMatchObject({ code: "ENOENT" });
  });
});

describe("removeAddedOfferedPlugin", () => {
  // The rollback path is itself a TOCTOU risk: by the time a caller decides
  // to undo a copy, plugins/ could have been swapped for a junction between
  // the copy landing and this call. A blind recursive delete would follow
  // it; this must refuse instead.
  it("refuses to remove through a junction that replaced plugins/ after the copy", async () => {
    const fixture = await createFixture();
    const added = await addOfferedPlugin({
      builtinPluginsRoot: fixture.builtinPluginsRoot,
      workspaceRoot: fixture.workspaceRoot,
      directoryName: "codex",
      existingPluginIds: NO_EXISTING_PLUGIN_IDS,
    });

    const outside = await mkdtemp(join(tmpdir(), "dohc-plugin-offers-outside-"));
    roots.push(outside);
    await writeFile(join(outside, "marker.txt"), "keep");
    await rm(join(fixture.workspaceRoot, "plugins"), { recursive: true, force: true });
    await symlink(
      outside,
      join(fixture.workspaceRoot, "plugins"),
      process.platform === "win32" ? "junction" : "dir",
    );

    await expect(
      removeAddedOfferedPlugin({
        workspaceRoot: fixture.workspaceRoot,
        directoryName: "codex",
        identity: added.identity,
      }),
    ).rejects.toBeInstanceOf(OfferedPluginAddError);

    // Nothing inside the redirected location was touched.
    await expect(readFile(join(outside, "marker.txt"), "utf8")).resolves.toBe("keep");
  });

  // A path comparison alone cannot tell "the same directory" from "deleted
  // and recreated under the same name" — only the filesystem's own device
  // and inode can. The identity addOfferedPlugin captured at copy time must
  // not match a directory that only shares the copy's name.
  it("refuses to remove a directory that only shares the copy's name, not its identity", async () => {
    const fixture = await createFixture();
    const added = await addOfferedPlugin({
      builtinPluginsRoot: fixture.builtinPluginsRoot,
      workspaceRoot: fixture.workspaceRoot,
      directoryName: "codex",
      existingPluginIds: NO_EXISTING_PLUGIN_IDS,
    });

    const target = join(fixture.workspaceRoot, "plugins", "codex");
    await rm(target, { recursive: true, force: true });
    await mkdir(target, { recursive: true });
    await writeFile(join(target, "keep.txt"), "keep");

    await expect(
      removeAddedOfferedPlugin({
        workspaceRoot: fixture.workspaceRoot,
        directoryName: "codex",
        identity: added.identity,
      }),
    ).rejects.toBeInstanceOf(OfferedPluginAddError);

    await expect(readFile(join(target, "keep.txt"), "utf8")).resolves.toBe("keep");
  });

  // The mechanism this pins: a check on `target` followed by a SEPARATE
  // delete call stays racy no matter how tight the gap, because Node has
  // no fd-bound recursive delete — plugins/codex itself could be swapped
  // for a junction in between. Binding the delete to a rename closes that:
  // the rename is one atomic syscall that grabs whatever entry is actually
  // there, verifies it in its own contained staging area, and only ever
  // deletes from there — never from the original, still-swappable path.
  it("refuses and restores when the target itself becomes a junction, not only when plugins/ does", async () => {
    const fixture = await createFixture();
    const added = await addOfferedPlugin({
      builtinPluginsRoot: fixture.builtinPluginsRoot,
      workspaceRoot: fixture.workspaceRoot,
      directoryName: "codex",
      existingPluginIds: NO_EXISTING_PLUGIN_IDS,
    });

    const outside = await mkdtemp(join(tmpdir(), "dohc-plugin-offers-outside-"));
    roots.push(outside);
    await writeFile(join(outside, "marker.txt"), "keep");
    const target = join(fixture.workspaceRoot, "plugins", "codex");
    await rm(target, { recursive: true, force: true });
    await symlink(
      outside,
      target,
      process.platform === "win32" ? "junction" : "dir",
    );

    await expect(
      removeAddedOfferedPlugin({
        workspaceRoot: fixture.workspaceRoot,
        directoryName: "codex",
        identity: added.identity,
      }),
    ).rejects.toBeInstanceOf(OfferedPluginAddError);

    // Nothing inside the redirected location was deleted, and the junction
    // itself — the swapped-in content — is back where it was found rather
    // than left stranded inside this module's own staging area.
    await expect(readFile(join(outside, "marker.txt"), "utf8")).resolves.toBe("keep");
    const restored = await lstat(target);
    expect(restored.isSymbolicLink()).toBe(true);
  });

  // The recheck this rollback runs right before restoring must genuinely
  // observe the CURRENT state, not the state the top-of-function check saw:
  // plugins/ is swapped for a junction here only after that first check
  // already passed, in the exact window the restore's own recheck exists to
  // close. Restoring blindly through it would write the mismatched content
  // outside the workspace instead of leaving it safely in staging.
  it("strands the mismatched copy in staging when plugins/ stops being safely contained before the restore", async () => {
    const fixture = await createFixture();
    const added = await addOfferedPlugin({
      builtinPluginsRoot: fixture.builtinPluginsRoot,
      workspaceRoot: fixture.workspaceRoot,
      directoryName: "codex",
      existingPluginIds: NO_EXISTING_PLUGIN_IDS,
    });

    const target = join(fixture.workspaceRoot, "plugins", "codex");
    await rm(target, { recursive: true, force: true });
    await mkdir(target, { recursive: true });
    await writeFile(join(target, "keep.txt"), "keep");

    const outside = await mkdtemp(join(tmpdir(), "dohc-plugin-offers-outside-"));
    roots.push(outside);
    await writeFile(join(outside, "marker.txt"), "keep");

    const pluginsPath = join(fixture.workspaceRoot, "plugins");
    raceState.lstatTrap = {
      path: pluginsPath,
      // Call 1 is this function's own top-of-function check, which must
      // still see a real directory. Call 2 is the recheck right before the
      // restore attempt — the one this round's fix adds.
      afterCall: 2,
      run: async () => {
        await rm(pluginsPath, { recursive: true, force: true });
        await symlink(
          outside,
          pluginsPath,
          process.platform === "win32" ? "junction" : "dir",
        );
      },
    };

    await expect(
      removeAddedOfferedPlugin({
        workspaceRoot: fixture.workspaceRoot,
        directoryName: "codex",
        identity: added.identity,
      }),
    ).rejects.toBeInstanceOf(OfferedPluginAddError);

    // Nothing was written through the swapped-in location.
    await expect(readFile(join(outside, "marker.txt"), "utf8")).resolves.toBe("keep");
    // The mismatched copy is stranded in this module's own staging area,
    // not lost and not written anywhere unsafe.
    const stagingParent = join(fixture.workspaceRoot, ".dohc", "plugin-offer-staging");
    const entries = await readdir(stagingParent);
    expect(entries).toHaveLength(1);
    await expect(
      readFile(join(stagingParent, entries[0], "keep.txt"), "utf8"),
    ).resolves.toBe("keep");
  });

  // The recheck above only narrows the plugins/-level race; the exact
  // target slot can still be reoccupied in the instant between the recheck
  // passing and the restore's own reservation. That must land on the same
  // "strand it, don't clobber" outcome, not a silent overwrite of whatever
  // now sits there.
  it("strands the mismatched copy in staging when the restore finds the slot reoccupied", async () => {
    const fixture = await createFixture();
    const added = await addOfferedPlugin({
      builtinPluginsRoot: fixture.builtinPluginsRoot,
      workspaceRoot: fixture.workspaceRoot,
      directoryName: "codex",
      existingPluginIds: NO_EXISTING_PLUGIN_IDS,
    });

    const target = join(fixture.workspaceRoot, "plugins", "codex");
    await rm(target, { recursive: true, force: true });
    await mkdir(target, { recursive: true });
    await writeFile(join(target, "keep.txt"), "keep");

    raceState.mkdirTrap = {
      path: target,
      run: async () => {
        await mkdir(target, { recursive: true });
        await writeFile(join(target, "raced.txt"), "raced");
      },
    };

    await expect(
      removeAddedOfferedPlugin({
        workspaceRoot: fixture.workspaceRoot,
        directoryName: "codex",
        identity: added.identity,
      }),
    ).rejects.toBeInstanceOf(OfferedPluginAddError);

    // The concurrently recreated target survived, untouched.
    await expect(readFile(join(target, "raced.txt"), "utf8")).resolves.toBe("raced");
    // The mismatched copy this call had staged is stranded, not lost.
    const stagingParent = join(fixture.workspaceRoot, ".dohc", "plugin-offer-staging");
    const entries = await readdir(stagingParent);
    expect(entries).toHaveLength(1);
    await expect(
      readFile(join(stagingParent, entries[0], "keep.txt"), "utf8"),
    ).resolves.toBe("keep");
  });

  it("removes exactly what it was told to, when the identity still matches", async () => {
    const fixture = await createFixture();
    const added = await addOfferedPlugin({
      builtinPluginsRoot: fixture.builtinPluginsRoot,
      workspaceRoot: fixture.workspaceRoot,
      directoryName: "codex",
      existingPluginIds: NO_EXISTING_PLUGIN_IDS,
    });

    await removeAddedOfferedPlugin({
      workspaceRoot: fixture.workspaceRoot,
      directoryName: "codex",
      identity: added.identity,
    });

    await expect(
      lstat(join(fixture.workspaceRoot, "plugins", "codex")),
    ).rejects.toMatchObject({ code: "ENOENT" });
  });
});

describe("findDisplacedByAdd", () => {
  it("finds the record that lost its shared id to this directory", () => {
    const codex = { directoryName: "codex", supersededPluginId: null };
    const loser = { directoryName: "my-codex", supersededPluginId: "codex" };

    expect(findDisplacedByAdd([codex, loser], "codex")).toBe(loser);
  });

  // The old mechanism scanned every OTHER record's diagnostics text for the
  // substring `duplicate plugin id "codex"`. That text is bounded and
  // re-worded for display, not a stable machine-checked signal — a record
  // whose diagnostics merely CONTAIN a similar-looking phrase for a reason
  // that has nothing to do with this add must never read as a collision.
  it("ignores an unrelated diagnostic that merely contains the same phrase", () => {
    const codex = { directoryName: "codex", supersededPluginId: null };
    const unrelated = {
      directoryName: "some-other-plugin",
      supersededPluginId: null,
      diagnostics: [
        // Coincidental prose (a nested-manifest path, an author's own
        // description field) that happens to spell the exact phrase the
        // old substring scan matched on — this record never actually lost
        // any collision, so supersededPluginId stays null.
        'nested manifest ignored at plugins/some-other-plugin/duplicate plugin id "codex": also declared at /elsewhere/dohc-plugin.json',
      ],
    };

    expect(findDisplacedByAdd([codex, unrelated], "codex")).toBeUndefined();
  });
});

describe("BUILTIN_DRIVER_PLUGIN_DISPLAY_NAMES", () => {
  // PluginDetailsPage's Remove dialog names the packaged plugin from this
  // constant rather than a workspace copy's own (possibly edited or broken)
  // manifest — so this constant itself must not silently drift from what
  // the packaged manifest actually declares.
  it("matches each built-in driver's own packaged displayName", async () => {
    for (const directoryName of BUILTIN_DRIVER_PLUGIN_DIRECTORY_NAMES) {
      const manifestPath = new URL(
        `../../plugins/${directoryName}/dohc-plugin.json`,
        import.meta.url,
      );
      const manifest = JSON.parse(await readFile(manifestPath, "utf8")) as {
        displayName?: string;
      };
      expect(BUILTIN_DRIVER_PLUGIN_DISPLAY_NAMES[directoryName]).toBe(
        manifest.displayName,
      );
    }
  });
});
