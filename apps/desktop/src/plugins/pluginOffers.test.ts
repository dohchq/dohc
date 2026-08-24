import { randomUUID } from "node:crypto";
import {
  lstat,
  mkdir,
  mkdtemp,
  readdir,
  readFile,
  rename,
  rm,
  symlink,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { BUILTIN_DRIVER_PLUGIN_DIRECTORY_NAMES } from "../ipc/channels";
import { discoverInstalledPlugins } from "./pluginDiscovery";
import {
  OfferedPluginAddError,
  addOfferedPlugin,
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
  // Fires right before the real rename is attempted: this models a
  // competitor claiming the slot in the window between this call staging
  // its copy and its own rename landing.
  renameRaceTrap: null as null | { path: string; run: () => Promise<void> },
  // A simulated rename failure, unrelated to any race — a locked file, a
  // full disk — keyed to the exact destination so only the intended
  // publish call is affected. `run`, when set, fires right before the
  // synthetic throw — used to replace whatever sits at the destination in
  // the same window a real race would. One-shot by default; `persist:
  // true` keeps rejecting every call for the path, for pinning what
  // happens once a bounded retry exhausts.
  renameFailureTrap: null as null | {
    path: string;
    code: string;
    run?: () => Promise<void>;
    persist?: boolean;
  },
  // Simulates a filesystem that reports no real device/inode identity for
  // one specific bigint lstat — some network shares and virtual
  // filesystems do this. Fires once; every other lstat call, bigint or
  // not, still resolves to the real stats.
  zeroIdentityTrap: null as null | { path: string },
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
      const stats = await actual.lstat(path, options);
      const zeroed = raceState.zeroIdentityTrap;
      if (
        zeroed &&
        path === zeroed.path &&
        (options as { bigint?: boolean } | undefined)?.bigint
      ) {
        raceState.zeroIdentityTrap = null;
        return Object.assign(Object.create(Object.getPrototypeOf(stats)), stats, {
          dev: 0n,
          ino: 0n,
        });
      }
      return stats;
    },
    rename: async (
      source: Parameters<typeof actual.rename>[0],
      destination: Parameters<typeof actual.rename>[1],
    ) => {
      const race = raceState.renameRaceTrap;
      if (race && destination === race.path) {
        raceState.renameRaceTrap = null;
        await race.run();
      }
      const trap = raceState.renameFailureTrap;
      if (trap && destination === trap.path) {
        if (!trap.persist) raceState.renameFailureTrap = null;
        if (trap.run) await trap.run();
        throw Object.assign(new Error(`simulated ${trap.code}`), { code: trap.code });
      }
      return actual.rename(source, destination);
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
  raceState.renameRaceTrap = null;
  raceState.renameFailureTrap = null;
  raceState.zeroIdentityTrap = null;
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

  // Suppression reads the packaged manifest's OWN declared name, not the
  // directoryName BUILTIN_DRIVER_PLUGIN_DIRECTORY_NAMES iterates by — the
  // two coincide for every real shipped built-in (pinned above), but the
  // suppression check itself must not silently depend on that coincidence.
  it("suppresses a built-in by its packaged manifest's declared name, not its directory", async () => {
    const fixture = await createFixture();
    await writeFile(
      join(fixture.builtinPluginsRoot, "codex", "dohc-plugin.json"),
      `${JSON.stringify({
        version: 1,
        name: "renamed-id",
        displayName: "codex driver",
        entry: "src/main.ts",
      }, null, 2)}\n`,
    );

    await expect(
      listOfferedPlugins(
        fixture.builtinPluginsRoot,
        fixture.workspaceRoot,
        new Set(["renamed-id"]),
      ),
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

  // listOfferedPlugins suppresses by manifest id, and
  // findDirectorySupersededBy is asked about a plugin id too — but
  // addOfferedPlugin's caller in pluginIpcHandlers.ts hands it a built-in's
  // directoryName, trusting the two to name the same thing for a shipped
  // built-in. Nothing else pins that trust; a packaged manifest whose name
  // drifted from its own directory would silently break both.
  //
  // The same pass also pins packagedBuiltinDisplayName's own invariant (the
  // handler resolves `manifest.displayName ?? manifest.name`, never a bare
  // displayName): null on that field must mean ONLY "not a built-in", never
  // "a built-in whose packaged manifest has nothing to call itself" — the
  // uninstall dialog reads that field's nullness as exactly that signal.
  it("declares a manifest name matching its own packaged directory, for every built-in driver", async () => {
    for (const directoryName of BUILTIN_DRIVER_PLUGIN_DIRECTORY_NAMES) {
      const manifestPath = new URL(
        `../../plugins/${directoryName}/dohc-plugin.json`,
        import.meta.url,
      );
      const manifest = JSON.parse(await readFile(manifestPath, "utf8")) as {
        name?: string;
        displayName?: string;
      };
      expect(manifest.name).toBe(directoryName);
      expect(manifest.displayName ?? manifest.name).toBeTruthy();
    }
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

  // On win32, rename() onto an existing FILE (unlike a directory) SUCCEEDS
  // and replaces it — verified empirically. publishStaged's own upfront
  // check has to refuse on ANY existing entry, not only a directory, or an
  // agent's own stub file sitting at plugins/codex gets silently destroyed.
  // POSIX already refuses this through mkdir()'s EEXIST regardless of what
  // occupies the name, so this pin holds on both platforms.
  it("refuses without clobbering a plain file sitting at the target", async () => {
    const fixture = await createFixture();
    await mkdir(join(fixture.workspaceRoot, "plugins"), { recursive: true });
    const target = join(fixture.workspaceRoot, "plugins", "codex");
    await writeFile(target, "a stray file, not a plugin directory");

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

    await expect(readFile(target, "utf8")).resolves.toBe(
      "a stray file, not a plugin directory",
    );
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

  // The fast-path check at the top only catches what's already there before
  // the copy starts — a concurrent creator landing DURING the copy still has
  // to be caught by the publish step itself, right where it claims target.
  // POSIX-only: this races the mkdir() claim specifically; the Windows
  // equivalent races the rename() below instead, since only POSIX claims via
  // mkdir().
  it.runIf(process.platform !== "win32")(
    "refuses without clobbering a target directory created after the copy started",
    async () => {
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
    },
  );

  // The empirical claim publishStaged's Windows path relies on: rename()
  // there refuses to land on ANY existing directory, even an empty one —
  // that alone is the no-clobber property, with no separate claim step
  // needed the way POSIX needs mkdir()'s atomic fail-on-exist.
  it.runIf(process.platform === "win32")(
    "[Windows probe] rename() onto an existing empty directory fails EPERM",
    async () => {
      const root = await mkdtemp(join(tmpdir(), "dohc-plugin-offers-probe-"));
      roots.push(root);
      const source = join(root, "source");
      const target = join(root, "target");
      await mkdir(source);
      await mkdir(target);
      await expect(rename(source, target)).rejects.toMatchObject({ code: "EPERM" });
    },
  );

  it.runIf(process.platform === "win32")(
    "[Windows] refuses without clobbering a competitor that claims the slot mid-copy",
    async () => {
      const fixture = await createFixture();
      const target = join(fixture.workspaceRoot, "plugins", "codex");
      raceState.renameRaceTrap = {
        path: target,
        run: async () => {
          await mkdir(target, { recursive: true });
          await writeFile(join(target, "raced.txt"), "raced");
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

      // The competitor's directory survived, untouched — never clobbered
      // by this call's own rename.
      await expect(readFile(join(target, "raced.txt"), "utf8")).resolves.toBe("raced");
      await expect(lstat(join(target, "src"))).rejects.toMatchObject({ code: "ENOENT" });
    },
  );

  // A transient hold (an antivirus scan, an indexer) can keep rename()
  // EPERM-ing through the whole bounded retry with nothing ever really at
  // target — EPERM alone cannot tell that apart from a genuine occupant.
  // This must name the lock, never misreport it as an existing plugin.
  it.runIf(process.platform === "win32")(
    "[Windows] names the lock, not a false 'already exists', when EPERM outlives every retry with nothing at target",
    async () => {
      const fixture = await createFixture();
      const target = join(fixture.workspaceRoot, "plugins", "codex");
      raceState.renameFailureTrap = { path: target, code: "EPERM", persist: true };

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
          error.message.includes("locked") &&
          !error.message.includes("already exists"),
      );
      await expect(lstat(target)).rejects.toMatchObject({ code: "ENOENT" });
    },
    10_000,
  );

  // POSIX-only mechanism (Windows already frees its claim unconditionally
  // before attempting the rename, so it has nothing to leak): a rename
  // failure unrelated to any race — a locked file, a full disk — used to
  // leave publishStaged's own mkdir() claim behind, still empty. Left
  // there, it reads as "occupied" forever: every later offer listing and
  // Add attempt sees a directory already at target and refuses, with
  // nothing left to clean it up. Forces the POSIX branch on this Windows
  // test host by stubbing process.platform, since the bug this pins is in
  // this module's own control flow, not in any OS-specific rename
  // semantics under test here.
  it("[POSIX] removes its own leaked claim when the publish rename fails, so a retried Add still works", async () => {
    const fixture = await createFixture();
    const target = join(fixture.workspaceRoot, "plugins", "codex");
    raceState.renameFailureTrap = { path: target, code: "EACCES" };

    // Forced only around the call under test: this dev host's real
    // filesystem still enforces real Windows rename semantics regardless
    // of what process.platform claims, so a retry that actually needs to
    // publish runs under this host's TRUE platform below, exercising the
    // already-correct branch for it — this call exists only to route
    // THIS module's own control flow through the POSIX branch under test.
    const platformDescriptor = Object.getOwnPropertyDescriptor(process, "platform")!;
    Object.defineProperty(process, "platform", { value: "linux", configurable: true });
    try {
      await expect(
        addOfferedPlugin({
          builtinPluginsRoot: fixture.builtinPluginsRoot,
          workspaceRoot: fixture.workspaceRoot,
          directoryName: "codex",
          existingPluginIds: NO_EXISTING_PLUGIN_IDS,
        }),
      ).rejects.toBeInstanceOf(OfferedPluginAddError);
    } finally {
      Object.defineProperty(process, "platform", platformDescriptor);
    }

    // The claim is gone, not stranded as a permanently "occupied" empty
    // directory.
    await expect(lstat(target)).rejects.toMatchObject({ code: "ENOENT" });

    // The offer is genuinely still available...
    const offers = await listOfferedPlugins(
      fixture.builtinPluginsRoot,
      fixture.workspaceRoot,
      NO_EXISTING_PLUGIN_IDS,
    );
    expect(offers.map((offer) => offer.directoryName)).toContain("codex");

    // ...and a retried Add succeeds, using a fresh copy this time.
    const added = await addOfferedPlugin({
      builtinPluginsRoot: fixture.builtinPluginsRoot,
      workspaceRoot: fixture.workspaceRoot,
      directoryName: "codex",
      existingPluginIds: NO_EXISTING_PLUGIN_IDS,
    });
    expect(added.rootPath).toBe(target);
    await expect(readFile(join(target, "dohc-plugin.json"), "utf8"))
      .resolves.toContain('"name": "codex"');
  });

  // Round 11 finding 2: removeOwnedEmptyClaim used to verify only "still an
  // empty, real directory right now" — true of ANY fresh empty directory
  // that happens to occupy the same path, not proof it is the one THIS
  // call's own mkdir() created. Something else replacing the claim in the
  // window between the mkdir landing and the failure-path cleanup, then
  // ALSO leaving it empty, used to pass that check and get deleted anyway.
  it("[POSIX] leaves a replaced claim alone instead of deleting it", async () => {
    const fixture = await createFixture();
    const target = join(fixture.workspaceRoot, "plugins", "codex");
    raceState.renameFailureTrap = {
      path: target,
      code: "EACCES",
      run: async () => {
        // The claim publishStaged's own mkdir() created is replaced with a
        // DIFFERENT empty directory at the same path — a different device
        // and inode, indistinguishable from the original by an emptiness
        // check alone.
        await rm(target, { recursive: true, force: true });
        await mkdir(target, { recursive: true });
        await writeFile(join(target, "marker.txt"), "not this call's claim");
        await rm(join(target, "marker.txt"));
      },
    };

    const platformDescriptor = Object.getOwnPropertyDescriptor(process, "platform")!;
    Object.defineProperty(process, "platform", { value: "linux", configurable: true });
    try {
      await expect(
        addOfferedPlugin({
          builtinPluginsRoot: fixture.builtinPluginsRoot,
          workspaceRoot: fixture.workspaceRoot,
          directoryName: "codex",
          existingPluginIds: NO_EXISTING_PLUGIN_IDS,
        }),
      ).rejects.toBeInstanceOf(OfferedPluginAddError);
    } finally {
      Object.defineProperty(process, "platform", platformDescriptor);
    }

    // The replacement directory survives — this call never verified it was
    // the one its own mkdir() created, so it left it alone.
    await expect(lstat(target)).resolves.toBeDefined();
    // Not offered again either: from listOfferedPlugins's own perspective
    // this is just some directory sitting there in an unknown state, the
    // same "any state at all" refusal an offer already gives a real plugin.
    const offers = await listOfferedPlugins(
      fixture.builtinPluginsRoot,
      fixture.workspaceRoot,
      NO_EXISTING_PLUGIN_IDS,
    );
    expect(offers.map((offer) => offer.directoryName)).not.toContain("codex");
  });

  // dev/ino can read as 0 on some Windows filesystems and network shares —
  // an unverifiable identity, not proof of anything. Trusting it anyway
  // would make targetIdentity's whole purpose vacuous: a zeroed "captured"
  // identity would match any OTHER zeroed identity later, the opposite of
  // what dev+ino comparison exists to catch. POSIX-only: targetIdentity is
  // only ever read for the mkdir() claim, which only POSIX takes.
  it("refuses to publish when the claim's own identity cannot be verified (zeroed dev/ino)", async () => {
    const fixture = await createFixture();
    const target = join(fixture.workspaceRoot, "plugins", "codex");
    raceState.zeroIdentityTrap = { path: target };

    const platformDescriptor = Object.getOwnPropertyDescriptor(process, "platform")!;
    Object.defineProperty(process, "platform", { value: "linux", configurable: true });
    try {
      await expect(
        addOfferedPlugin({
          builtinPluginsRoot: fixture.builtinPluginsRoot,
          workspaceRoot: fixture.workspaceRoot,
          directoryName: "codex",
          existingPluginIds: NO_EXISTING_PLUGIN_IDS,
        }),
      ).rejects.toBeInstanceOf(OfferedPluginAddError);
    } finally {
      Object.defineProperty(process, "platform", platformDescriptor);
    }

    // The claim this call's own mkdir() made is cleaned up rather than
    // leaked as a permanently "occupied" empty directory — its identity
    // could not be verified, but "not a symlink, is a directory, is
    // empty" was still real evidence, not a blind delete.
    await expect(lstat(target)).rejects.toMatchObject({ code: "ENOENT" });

    // A retry (once the filesystem answers normally, as it does here) can
    // still succeed — the refusal did not strand the offer.
    const added = await addOfferedPlugin({
      builtinPluginsRoot: fixture.builtinPluginsRoot,
      workspaceRoot: fixture.workspaceRoot,
      directoryName: "codex",
      existingPluginIds: NO_EXISTING_PLUGIN_IDS,
    });
    expect(added.rootPath).toBe(target);
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
        contentHash: added.contentHash,
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
        contentHash: added.contentHash,
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
        contentHash: added.contentHash,
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
        contentHash: added.contentHash,
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
  // POSIX-only: races the restore's own mkdir() claim specifically, the
  // same reason the equivalent add-path race test is POSIX-only.
  it.runIf(process.platform !== "win32")(
    "strands the mismatched copy in staging when the restore finds the slot reoccupied",
    async () => {
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
          contentHash: added.contentHash,
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
    },
  );

  // The Windows analogue of the reoccupied-slot race above: a FILE, not a
  // directory, lands in the vacated slot in the exact window the restore's
  // own upfront check runs — the scenario publishStaged's file-vs-directory
  // fix exists to close. This proves the fix reaches the rollback path too,
  // not only the add path.
  it.runIf(process.platform === "win32")(
    "[Windows] strands the mismatched copy in staging when a file occupies the restore's target",
    async () => {
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

      raceState.lstatTrap = {
        path: target,
        afterCall: 1,
        run: async () => {
          await writeFile(target, "raced file");
        },
      };

      await expect(
        removeAddedOfferedPlugin({
          workspaceRoot: fixture.workspaceRoot,
          directoryName: "codex",
          identity: added.identity,
          contentHash: added.contentHash,
        }),
      ).rejects.toBeInstanceOf(OfferedPluginAddError);

      // The file a concurrent actor planted survived untouched, never
      // replaced by the restore's own write.
      await expect(readFile(target, "utf8")).resolves.toBe("raced file");
      // The mismatched copy this call had staged is stranded, not lost.
      const stagingParent = join(fixture.workspaceRoot, ".dohc", "plugin-offer-staging");
      const entries = await readdir(stagingParent);
      expect(entries).toHaveLength(1);
      await expect(
        readFile(join(stagingParent, entries[0], "keep.txt"), "utf8"),
      ).resolves.toBe("keep");
    },
  );

  // Identity alone answers "is this the same directory entry", never "does
  // it still hold what this request put there" — a directory's own inode
  // does not change when a file inside it is edited. A rollback can land
  // well after publish (this pins it through the exact path that reaches
  // it: a conflict detected on a slow rescan), and real work can happen
  // inside that window.
  it("refuses to delete an edited copy, even though its identity still matches", async () => {
    const fixture = await createFixture();
    const added = await addOfferedPlugin({
      builtinPluginsRoot: fixture.builtinPluginsRoot,
      workspaceRoot: fixture.workspaceRoot,
      directoryName: "codex",
      existingPluginIds: NO_EXISTING_PLUGIN_IDS,
    });

    // Real work landing inside the SAME directory entry — its own identity
    // is untouched by this, which is exactly what makes it distinct from
    // every other case in this file.
    const target = join(fixture.workspaceRoot, "plugins", "codex");
    await writeFile(join(target, "NOTES.md"), "left after publish");

    await expect(
      removeAddedOfferedPlugin({
        workspaceRoot: fixture.workspaceRoot,
        directoryName: "codex",
        identity: added.identity,
        contentHash: added.contentHash,
      }),
    ).rejects.toBeInstanceOf(OfferedPluginAddError);

    // Restored to plugins/, not lost: the same "target is a real, safely
    // contained directory" recheck the other mismatch cases already use
    // finds it can put this back, so the edit survives right where it was
    // made rather than stranded in staging.
    await expect(
      readFile(join(target, "NOTES.md"), "utf8"),
    ).resolves.toBe("left after publish");
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
      contentHash: added.contentHash,
    });

    await expect(
      lstat(join(fixture.workspaceRoot, "plugins", "codex")),
    ).rejects.toMatchObject({ code: "ENOENT" });
  });
});
