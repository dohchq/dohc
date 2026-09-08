import { lstat, readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import { deferred, type Deferred } from "../testing/deferred";
import { PluginHost } from "./PluginHost";
import { PluginPipeline } from "./PluginPipeline";
import { buildPluginBundle } from "./pluginBuildRunner";
import { HOST_CHANGE_REFUSED_ERROR_CODE, invokeRegisteredPluginCommand } from "./pluginCommandInvocation";
import { PluginHostOwnership } from "./pluginHostOwnership";
import { PLUGIN_HOST_METHODS } from "./pluginHostProtocol";
import { installPluginDependencies } from "./pluginInstallRunner";
import { mutatePluginRecord, readPluginLocalState } from "./pluginLocalState";
import type { PluginSettingDeclaration } from "./pluginManifestSchema";
import { snapshotPluginSource } from "./pluginSourceSnapshot";
import {
  createPluginWorkspace,
  ensureFromCommand,
  ensureFromSurface,
  fakeSpawnTransport,
  liveBundlePath,
  nodeForkProcess,
  pluginsDataRoot,
  pnpmRunnerEntry,
  resourcesBasePath,
  stagingLeftovers,
  waitFor,
} from "./pluginPipelineTestSupport";

export function registerEstablishedPluginRecoveryTests(): void {
  describe("established plugin rebuild recovery", () => {
    async function setupEstablishedPlugin(options: {
      commands?: { id: string; title: string }[];
      settings?: PluginSettingDeclaration[];
      drainTimeoutMs?: number;
      onRuntimeStopped?: (pluginId: string) => void | Promise<void>;
    } = {}) {
      const fixture = await createPluginWorkspace();
      const manifestPath = join(fixture.pluginRoot, "dohc-plugin.json");
      const manifestText = (
        commands: { id: string; title: string }[],
        settings: PluginSettingDeclaration[] = options.settings ?? [],
      ) =>
        `${JSON.stringify({
          version: 1,
          name: "example-plugin",
          displayName: "Example plugin",
          entry: "src/index.ts",
          commands,
          settings,
        }, null, 2)}\n`;
      if (options.commands || options.settings) {
        await writeFile(manifestPath, manifestText(options.commands ?? []));
      }
      let mismatchNextSnapshot = false;
      let failNextDiscard = false;
      let failPublish = false;
      let failRecordWrite = false;
      let failBuild = false;
      let nextStopGate: { entered: Deferred; release: Deferred } | null = null;
      let nextBuildGate: { entered: Deferred; release: Deferred } | null = null;
      let failNextStop = false;
      let nextSnapshotGate: { entered: Deferred; release: Deferred } | null = null;
      let buildCalls = 0;
      let registeredCommands = (options.commands ?? [])
        .map((command) => command.id);
      const statuses: string[] = [];
      let pipeline: PluginPipeline;
      const baseSpawnTransport = fakeSpawnTransport(
        () => [...registeredCommands],
        async (method) => {
          const gate = nextStopGate;
          if (method !== PLUGIN_HOST_METHODS.deactivate || !gate) return;
          nextStopGate = null;
          gate.entered.resolve();
          await gate.release.promise;
        },
      );
      const host = new PluginHost({
        stateDir: fixture.stateDir,
        workspaceRoot: fixture.workspaceRoot,
        // Wrap transport dispose() to make PluginHost.stop() reject. shutdown()
        // awaits it outside a catch, unlike the deactivate RPC, so this reaches
        // stopOldRuntime's stop() call as a rejection.
        spawnTransport: (params) => {
          const transport = baseSpawnTransport(params);
          return {
            ...transport,
            dispose: async () => {
              if (failNextStop) {
                failNextStop = false;
                throw new Error("simulated: PluginHost.stop() transport dispose failed");
              }
              return transport.dispose();
            },
          };
        },
        routeSdkRequest: async () => ({}),
        onStatusChange: (pluginId, status) => {
          pipeline.noteRuntimeStatus(pluginId, status);
        },
      });
      const hostOwnership = new PluginHostOwnership(host, {
        drainTimeoutMs: options.drainTimeoutMs,
      });
      pipeline = new PluginPipeline({
        isEngineCaptureAvailable: () => true,
        workspaceRoot: fixture.workspaceRoot,
        stateDir: fixture.stateDir,
        hostOwnership,
        resourcesBasePath,
        pnpmRunnerEntry,
        onStatusChange: (event) => {
          if (event.kind === "changed") statuses.push(event.plugin.status);
        },
        onRuntimeStopped: options.onRuntimeStopped,
        operations: {
          install: (input) =>
            installPluginDependencies({ ...input, forkProcess: nodeForkProcess }),
          mutateRecord: async (stateDir, workspaceRoot, pluginId, mutate) => {
            if (failRecordWrite) {
              failRecordWrite = false;
              throw new Error("simulated approval record write failure");
            }
            return mutatePluginRecord(stateDir, workspaceRoot, pluginId, mutate);
          },
          snapshot: async (input) => {
            const gate = nextSnapshotGate;
            if (gate) {
              nextSnapshotGate = null;
              gate.entered.resolve();
              await gate.release.promise;
            }
            const result = await snapshotPluginSource(input);
            if (!result.ok || !mismatchNextSnapshot) return result;
            mismatchNextSnapshot = false;
            return {
              ...result,
              sourceHash: "0".repeat(64),
              discard: async () => {
                if (failNextDiscard) {
                  failNextDiscard = false;
                  throw new Error("simulated: staged tree is busy");
                }
                await result.discard();
              },
            };
          },
          build: async (input) => {
            buildCalls += 1;
            const gate = nextBuildGate;
            if (gate) {
              nextBuildGate = null;
              gate.entered.resolve();
              await gate.release.promise;
            }
            if (failBuild) {
              failBuild = false;
              throw new Error("simulated build failure before the approval record write");
            }
            const result = await buildPluginBundle(input);
            if (!result.ok || !failPublish) return result;
            failPublish = false;
            return {
              ...result,
              publish: () => Promise.reject(new Error("simulated publish failure")),
            };
          },
        },
      });

      await pipeline.start();
      const installed = await pipeline.install("example-plugin");
      if (!installed.ok) {
        throw new Error(
          `${installed.error.stage}/${installed.error.code}: ${installed.error.message}`,
        );
      }
      await waitFor(
        () => pipeline.list()[0]?.status === "ready",
        "Plugin did not reach ready after install.",
      );

      return {
        pipeline,
        host,
        fixture,
        entryPath: fixture.entryPath,
        manifestPath,
        manifestText,
        statuses,
        buildCalls: () => buildCalls,
        failNextBuildPublish: () => {
          failPublish = true;
        },
        failNextRecordWrite: () => {
          failRecordWrite = true;
        },
        failNextBuild: () => {
          failBuild = true;
        },
        gateNextStop: () => {
          const gate = { entered: deferred(), release: deferred() };
          nextStopGate = gate;
          return gate;
        },
        gateNextBuild: () => {
          const gate = { entered: deferred(), release: deferred() };
          nextBuildGate = gate;
          return gate;
        },
        gateNextSnapshot: () => {
          const gate = { entered: deferred(), release: deferred() };
          nextSnapshotGate = gate;
          return gate;
        },
        failNextStop: () => {
          failNextStop = true;
        },
        hostOwnership,
        setRegisteredCommands: (commands: string[]) => {
          registeredCommands = [...commands];
        },
        failEstablishedBuild: async () => {
          mismatchNextSnapshot = true;
          failNextDiscard = true;
          pipeline.handleDoorWrittenSourceChange("example-plugin", {
            absolutePath: fixture.entryPath,
            text: await readFile(fixture.entryPath, "utf8"),
          });
          await waitFor(
            () => pipeline.list()[0]?.status === "failed",
            "The established plugin rebuild did not fail.",
          );
        },
      };
    }

    it("refuses an uninstall token after the durable record retargets to another directory", async () => {
      const setup = await setupEstablishedPlugin();
      try {
        const preflight = await setup.pipeline.uninstallPreflight(
          "example-plugin",
          "example-plugin",
        );
        if (!preflight.ok) throw new Error(preflight.error.message);
        const runningRecord = setup.host.currentRecord("example-plugin");
        expect(runningRecord).toBeDefined();
        const bundleBefore = await readFile(
          liveBundlePath(setup.fixture, "example-plugin"),
        );

        await mutatePluginRecord(
          setup.fixture.stateDir,
          setup.fixture.workspaceRoot,
          "example-plugin",
          (record) => ({ ...record, directoryName: "replacement-directory" }),
        );

        const result = await setup.pipeline.uninstall(
          "example-plugin",
          "example-plugin",
          preflight.confirmationToken,
        );

        expect(result).toMatchObject({
          ok: false,
          error: { stage: "uninstall", code: "confirmation-stale" },
        });
        expect(setup.host.currentRecord("example-plugin")).toBe(runningRecord);
        await expect(lstat(setup.fixture.pluginRoot)).resolves.toBeDefined();
        expect(await readFile(liveBundlePath(setup.fixture, "example-plugin")))
          .toEqual(bundleBefore);
        const state = await readPluginLocalState(
          setup.fixture.stateDir,
          setup.fixture.workspaceRoot,
        );
        if (!state.ok) throw new Error(state.warning);
        expect(state.state.plugins["example-plugin"]?.directoryName)
          .toBe("replacement-directory");
      } finally {
        await setup.pipeline.dispose();
      }
    }, 60_000);

    it("retries against the durable approval after a later publish failure", async () => {
      const setup = await setupEstablishedPlugin();
      try {
        const oldApprovedHash = setup.pipeline.list()[0]?.approvedHash;
        await writeFile(setup.entryPath, [
          'export const marker = "durably approved before publish";',
          "export default { activate() {} };",
          "",
        ].join("\n"));
        setup.failNextBuildPublish();

        const approved = await setup.pipeline.approve("example-plugin");

        expect(approved.ok).toBe(false);
        expect(setup.pipeline.list()[0]).toMatchObject({
          status: "failed",
          approvedHash: oldApprovedHash,
        });
        const durableState = await readPluginLocalState(
          setup.fixture.stateDir,
          setup.fixture.workspaceRoot,
        );
        if (!durableState.ok) throw new Error(durableState.warning);
        const durableApprovedHash =
          durableState.state.plugins["example-plugin"]?.approvedHash;
        expect(durableApprovedHash).toMatch(/^[0-9a-f]{64}$/);
        expect(durableApprovedHash).not.toBe(oldApprovedHash);

        const rebuilt = await setup.pipeline.rebuild("example-plugin");

        expect(rebuilt).toMatchObject({
          ok: true,
          plugin: {
            status: "starting",
            approvedHash: durableApprovedHash,
          },
        });
        await waitFor(
          () => setup.pipeline.list()[0]?.status === "ready",
          "Plugin did not reach ready after retrying its durably approved build.",
        );
        expect(setup.pipeline.list()[0]).toMatchObject({
          status: "ready",
          sourceHash: durableApprovedHash,
          approvedHash: durableApprovedHash,
        });
      } finally {
        await setup.pipeline.dispose();
      }
    }, 60_000);

    it("retries unchanged bytes after an approved build fails before the record write", async () => {
      const setup = await setupEstablishedPlugin();
      try {
        const oldApprovedHash = setup.pipeline.list()[0]?.approvedHash;
        await writeFile(setup.entryPath, [
          'export const marker = "approved before a transient build failure";',
          "export default { activate() {} };",
          "",
        ].join("\n"));
        setup.failNextBuild();

        const approved = await setup.pipeline.approve("example-plugin");

        expect(approved.ok).toBe(false);
        const durableState = await readPluginLocalState(
          setup.fixture.stateDir,
          setup.fixture.workspaceRoot,
        );
        if (!durableState.ok) throw new Error(durableState.warning);
        expect(durableState.state.plugins["example-plugin"]?.approvedHash)
          .toBe(oldApprovedHash);

        const rebuilt = await setup.pipeline.rebuild("example-plugin");

        expect(rebuilt).toMatchObject({
          ok: true,
          plugin: { status: "starting" },
        });
        await waitFor(
          () => setup.pipeline.list()[0]?.status === "ready",
          "Plugin did not reach ready after retrying unchanged approved bytes.",
        );
        expect(setup.pipeline.list()[0]?.status)
          .not.toBe("disabled-pending-approval");
      } finally {
        await setup.pipeline.dispose();
      }
    }, 60_000);

    it("retries a failed build for an established plugin", async () => {
      const setup = await setupEstablishedPlugin();
      try {
        await setup.failEstablishedBuild();

        const rebuilt = await setup.pipeline.rebuild("example-plugin");

        expect(rebuilt.ok).toBe(true);
        await waitFor(
          () => setup.pipeline.list()[0]?.status === "ready",
          "Plugin did not reach ready after retrying its build.",
        );
      } finally {
        await setup.pipeline.dispose();
      }
    }, 60_000);

    it("tears down web apps only after the old runtime stops", async () => {
      const setup = await setupEstablishedPlugin();
      try {
        await setup.failEstablishedBuild();
        const stopGate = setup.gateNextStop();
        let callbackCalled = false;
        let lateStart: Promise<unknown> | undefined;

        const rebuilding = setup.pipeline.rebuild("example-plugin", {
          onOldRuntimeStopped: () => {
            callbackCalled = true;
            lateStart = setup.pipeline.host.startWebApp(
              "example-plugin",
              "old-app",
              null,
            );
            void lateStart.catch(() => undefined);
          },
        });

        await stopGate.entered.promise;
        expect(callbackCalled).toBe(false);
        stopGate.release.resolve();
        const rebuilt = await rebuilding;

        expect(rebuilt.ok).toBe(true);
        expect(callbackCalled).toBe(true);
        if (!lateStart) throw new Error("The old-runtime stop callback did not run.");
        await expect(lateStart).rejects.toThrow(
          'Plugin "example-plugin" is not running.',
        );
      } finally {
        await setup.pipeline.dispose();
      }
    }, 60_000);

    it("keeps the running build's commands after a pre-stop failure", async () => {
      const oldCommands = [{ id: "old.cmd", title: "Old Command" }];
      const newCommands = [{ id: "new.cmd", title: "New Command" }];
      const setup = await setupEstablishedPlugin({ commands: oldCommands });
      try {
        setup.failNextRecordWrite();
        setup.setRegisteredCommands(newCommands.map((command) => command.id));
        await writeFile(
          setup.manifestPath,
          setup.manifestText(newCommands),
        );
        // Refresh discovery without reconciling this plugin. The attempted
        // approval below must see the edited manifest while the old runtime
        // remains up until the build reaches its stop step.
        await setup.pipeline.handleWatcherEvents([{
          path: "plugins/unrelated-plugin/dohc-plugin.json",
          operation: "update",
        }]);
        expect(
          setup.pipeline.pluginRegistration("example-plugin")?.manifest.commands,
        ).toEqual(newCommands);

        const failed = await setup.pipeline.approve("example-plugin");

        expect(failed).toMatchObject({
          ok: false,
          plugin: { commands: oldCommands },
        });
        await waitFor(
          () => setup.pipeline.list()[0]?.status === "failed",
          "The pre-stop record write failure did not reach failed status.",
        );

        expect(setup.pipeline.host.getStatus("example-plugin")).toBe("ready");
        expect(setup.pipeline.host.getRegisteredCommands("example-plugin"))
          .toEqual(["old.cmd"]);
        expect(setup.pipeline.list()[0]?.commands).toEqual(oldCommands);
        expect(
          setup.pipeline.pluginRegistration("example-plugin")?.manifest.commands,
        ).toEqual(oldCommands);
        setup.pipeline.noteRuntimeStatus("example-plugin", "crashed");
        setup.pipeline.noteRuntimeStatus("example-plugin", "starting");
        setup.pipeline.noteRuntimeStatus("example-plugin", "ready");
        expect(setup.pipeline.list()[0]?.commands).toEqual(oldCommands);
        expect(
          setup.pipeline.pluginRegistration("example-plugin")?.manifest.commands,
        ).toEqual(oldCommands);
        const recoveredRegistration =
          setup.pipeline.pluginRegistration("example-plugin");
        expect(recoveredRegistration).not.toBeNull();
        if (!recoveredRegistration) {
          throw new Error("The recovered plugin registration is missing.");
        }
        const invoked = await invokeRegisteredPluginCommand({
          input: {
            workspaceId: "workspace-1",
            pluginId: "example-plugin",
            commandId: "old.cmd",
          },
          plugin: recoveredRegistration,
          runCommand: (operation) =>
            setup.hostOwnership.runCommand("example-plugin", operation),
          // This test isolates the recovered registration and old host. The
          // production start/activation seam has its own behavior tests.
          ensureStarted: async () => setup.pipeline.host,
          ensureCurrent: () => {},
        });
        expect(invoked.status).toBe("ok");

        const approved = await setup.pipeline.approve("example-plugin");

        expect(approved.ok).toBe(true);
        await waitFor(
          () => setup.pipeline.list()[0]?.status === "ready",
          "Plugin did not reach ready after approving the replacement build.",
        );
        expect(setup.pipeline.list()[0]?.commands).toEqual(newCommands);
        expect(setup.pipeline.host.getRegisteredCommands("example-plugin"))
          .toEqual(["new.cmd"]);
        expect(
          setup.pipeline.pluginRegistration("example-plugin")?.manifest.commands,
        ).toEqual(newCommands);
      } finally {
        await setup.pipeline.dispose();
      }
    }, 60_000);

    it("reports no live runtime, not the pre-build status it captured before this attempt started, once the old runtime actually stopped and publish then failed", async () => {
      const setup = await setupEstablishedPlugin();
      try {
        expect(setup.pipeline.host.getStatus("example-plugin")).toBe("ready");
        // publish() rejects only once the build itself has already
        // succeeded — runFullBuild stops the old runtime before either
        // publish, so this failure lands after that stop already ran.
        setup.failNextBuildPublish();
        await writeFile(setup.entryPath, [
          'export const marker = "attempted after the old runtime stopped";',
          "export default { activate() {} };",
          "",
        ].join("\n"));
        const approved = await setup.pipeline.approve("example-plugin");
        expect(approved.ok).toBe(false);
        expect(setup.pipeline.list()[0]?.status).toBe("failed");
        expect(setup.pipeline.host.getStatus("example-plugin")).toBeUndefined();
        // The stale pre-build "ready" this attempt captured before it ever
        // touched anything must not be reported here — nothing is actually
        // running now.
        expect(setup.pipeline.list()[0]?.runtimeStatus).toBeNull();
      } finally {
        await setup.pipeline.dispose();
      }
    }, 60_000);

    it("keeps the running build's commands after a verify-pass failure", async () => {
      // The twin of "keeps the running build's commands after a pre-stop
      // failure" above, reached through reconcileApprovedCandidate's
      // verifyApprovedSource pass instead of runFullBuild's own — the two
      // failure paths write the recovery cache from two different call
      // sites, and only one of them did until this fix.
      const oldCommands = [{ id: "old.cmd", title: "Old Command" }];
      const newCommands = [{ id: "new.cmd", title: "New Command" }];
      const setup = await setupEstablishedPlugin({ commands: oldCommands });
      try {
        await writeFile(setup.manifestPath, setup.manifestText(newCommands));
        await setup.pipeline.handleWatcherEvents([{
          path: "plugins/unrelated-plugin/dohc-plugin.json",
          operation: "update",
        }]);
        expect(
          setup.pipeline.pluginRegistration("example-plugin")?.manifest.commands,
        ).toEqual(newCommands);

        await setup.failEstablishedBuild();

        expect(setup.pipeline.host.getStatus("example-plugin")).toBe("ready");
        expect(setup.pipeline.list()[0]?.commands).toEqual(oldCommands);
        expect(
          setup.pipeline.pluginRegistration("example-plugin")?.manifest.commands,
        ).toEqual(oldCommands);
      } finally {
        await setup.pipeline.dispose();
      }
    }, 60_000);

    it("keeps recovered commands authoritative throughout a pre-stop retry", async () => {
      const oldCommands = [{ id: "old.cmd", title: "Old Command" }];
      const newCommands = [{ id: "new.cmd", title: "New Command" }];
      const setup = await setupEstablishedPlugin({ commands: oldCommands });
      try {
        setup.failNextRecordWrite();
        await writeFile(setup.manifestPath, setup.manifestText(newCommands));
        await setup.pipeline.handleWatcherEvents([{
          path: "plugins/unrelated-plugin/dohc-plugin.json",
          operation: "update",
        }]);
        expect((await setup.pipeline.approve("example-plugin")).ok).toBe(false);
        expect(setup.pipeline.list()[0]?.commands).toEqual(oldCommands);

        const buildGate = setup.gateNextBuild();
        setup.failNextBuild();
        const retry = setup.pipeline.approve("example-plugin");
        await buildGate.entered.promise;

        try {
          expect(setup.pipeline.host.getStatus("example-plugin")).toBe("ready");
          expect(setup.pipeline.list()[0]?.commands).toEqual(oldCommands);
          expect(
            setup.pipeline.pluginRegistration("example-plugin")?.manifest.commands,
          ).toEqual(oldCommands);
        } finally {
          buildGate.release.resolve();
        }
        expect((await retry).ok).toBe(false);
        expect(setup.pipeline.host.getStatus("example-plugin")).toBe("ready");
        expect(setup.pipeline.list()[0]?.commands).toEqual(oldCommands);
        expect(
          setup.pipeline.pluginRegistration("example-plugin")?.manifest.commands,
        ).toEqual(oldCommands);
      } finally {
        await setup.pipeline.dispose();
      }
    }, 60_000);

    it("keeps a failed approved attempt's recovery intact through a watcher touch that changes nothing, and leaves Retry still working", async () => {
      const setup = await setupEstablishedPlugin();
      try {
        // Approve new content, but the build behind it fails —
        // recoveryState captures the still-running old build, and
        // lastApprovedAttemptHash remembers this exact attempted content
        // (the same hash Retry's own buildFromCurrentSource later accepts
        // via alsoAcceptHash).
        setup.failNextBuild();
        await writeFile(setup.entryPath, [
          'export const marker = "attempted approval";',
          "export default { activate() {} };",
          "",
        ].join("\n"));
        const approved = await setup.pipeline.approve("example-plugin");
        expect(approved.ok).toBe(false);
        expect(setup.pipeline.list()[0]?.status).toBe("failed");
        expect(setup.pipeline.host.getStatus("example-plugin")).toBe("ready");

        // A watcher event touches the plugin's tree without changing its
        // content — the exact same, still-unapproved attempted content
        // that just failed. Awaited, not fire-and-forget: it settles once
        // the reconcile below is queued (not once it has run), and the
        // next two calls share its per-plugin FIFO queue — enqueuing
        // after this await guarantees they land behind that reconcile,
        // not racing ahead of it.
        await setup.pipeline.handleWatcherEvents([{
          path: "plugins/example-plugin/src/index.ts",
          operation: "update",
        }]);

        // Synchronizes with the watcher's own queued reconcile without
        // itself changing anything: preflight shares the same per-plugin
        // queue, so by the time it resolves, the reconcile above already
        // has.
        const preflight = await setup.pipeline.uninstallPreflight("example-plugin", "example-plugin");
        expect(preflight.ok).toBe(true);

        // No hold: the recovery is untouched, and the old runtime the
        // failed attempt left running is still running.
        expect(setup.pipeline.list()[0]?.status).toBe("failed");
        expect(setup.pipeline.host.getStatus("example-plugin")).toBe("ready");

        // Retry still works against the same attempted content — it would
        // reject with "no-failed-build" had the watcher's own reconcile
        // held this for approval instead.
        const retried = await setup.pipeline.rebuild("example-plugin");
        expect(retried.ok).toBe(true);
      } finally {
        await setup.pipeline.dispose();
      }
    }, 60_000);

    it("evaluates A again after A fails, B is held for approval, and the source returns to A", async () => {
      const setup = await setupEstablishedPlugin();
      try {
        const key = "example-plugin";
        // A fails to build — lastApprovedAttemptHash remembers A's hash,
        // the old runtime stays up under recovery.
        setup.failNextBuild();
        await writeFile(setup.entryPath, [
          'export const marker = "content A";',
          "export default { activate() {} };",
          "",
        ].join("\n"));
        const approvedA = await setup.pipeline.approve("example-plugin");
        expect(approvedA.ok).toBe(false);
        expect(setup.pipeline.list()[0]?.status).toBe("failed");

        // Edited to B — genuinely different content, so the watcher's own
        // reconcile finds no hash it recognizes and holds for approval,
        // stopping the old runtime for real. That stop is where the
        // recovery genuinely ends: A's own attempt hash must not survive
        // it.
        await writeFile(setup.entryPath, [
          'export const marker = "content B";',
          "export default { activate() {} };",
          "",
        ].join("\n"));
        await setup.pipeline.handleWatcherEvents([{
          path: "plugins/example-plugin/src/index.ts",
          operation: "update",
        }]);
        await setup.pipeline.uninstallPreflight("example-plugin", "example-plugin");
        const heldForB = setup.pipeline.list()[0];
        expect(heldForB?.status).toBe("disabled-pending-approval");
        const bSourceHash = heldForB?.sourceHash;
        expect(bSourceHash).toBeDefined();
        expect(setup.pipeline.host.getStatus("example-plugin")).toBeUndefined();

        // Edited back to A — its content hash matches what step one's own
        // failed attempt recorded, but that recovery is long gone: this
        // must evaluate A on its own, not resurrect B's exact status
        // object (which would misreport A's own live content as B's).
        await writeFile(setup.entryPath, [
          'export const marker = "content A";',
          "export default { activate() {} };",
          "",
        ].join("\n"));
        await setup.pipeline.handleWatcherEvents([{
          path: "plugins/example-plugin/src/index.ts",
          operation: "update",
        }]);
        await setup.pipeline.uninstallPreflight("example-plugin", "example-plugin");
        const afterReturnToA = setup.pipeline.list()[0];
        expect(afterReturnToA?.status).toBe("disabled-pending-approval");
        expect(afterReturnToA?.sourceHash).not.toBe(bSourceHash);
      } finally {
        await setup.pipeline.dispose();
      }
    }, 60_000);

    it("keeps the running build's settings and validation after a pre-stop failure", async () => {
      const oldSettings: PluginSettingDeclaration[] = [{
        key: "greeting",
        type: "string",
        label: "Greeting",
        description: "What the plugin says.",
        default: "Hello",
      }];
      const newSettings: PluginSettingDeclaration[] = [{
        key: "repeat",
        type: "number",
        label: "Repeat",
        description: "How many times the plugin repeats itself.",
        default: 1,
      }];
      const setup = await setupEstablishedPlugin({ settings: oldSettings });
      try {
        setup.failNextRecordWrite();
        await writeFile(
          setup.manifestPath,
          setup.manifestText([], newSettings),
        );
        await setup.pipeline.handleWatcherEvents([{
          path: "plugins/unrelated-plugin/dohc-plugin.json",
          operation: "update",
        }]);

        expect((await setup.pipeline.approve("example-plugin")).ok).toBe(false);
        expect(setup.pipeline.list()[0]?.settings).toEqual(oldSettings);
        await expect(
          setup.pipeline.setPluginSettings("example-plugin", "example-plugin", { greeting: "Hi" }),
        ).resolves.toEqual({ greeting: "Hi" });
        await expect(
          setup.pipeline.setPluginSettings("example-plugin", "example-plugin", { repeat: 2 }),
        ).rejects.toThrow('does not declare a setting named "repeat"');

        expect((await setup.pipeline.approve("example-plugin")).ok).toBe(true);
        await waitFor(
          () => setup.pipeline.list()[0]?.status === "ready",
          "Plugin did not reach ready after replacing its settings declaration.",
        );
        expect(setup.pipeline.list()[0]?.settings).toEqual(newSettings);
        await expect(
          setup.pipeline.setPluginSettings("example-plugin", "example-plugin", { repeat: 2 }),
        ).resolves.toEqual({ repeat: 2 });
        await expect(
          setup.pipeline.setPluginSettings("example-plugin", "example-plugin", { greeting: "Hi" }),
        ).rejects.toThrow('does not declare a setting named "greeting"');
      } finally {
        await setup.pipeline.dispose();
      }
    }, 60_000);

    it("notifies when rebuild stops an old runtime to hold changed source", async () => {
      const setup = await setupEstablishedPlugin();
      try {
        await setup.failEstablishedBuild();
        await writeFile(setup.entryPath, [
          'export const marker = "changed before retry";',
          "export default { activate() {} };",
          "",
        ].join("\n"));
        let callbackCalled = false;

        const rebuilt = await setup.pipeline.rebuild("example-plugin", {
          onOldRuntimeStopped: () => {
            callbackCalled = true;
          },
        });

        expect(rebuilt).toMatchObject({
          ok: true,
          plugin: { status: "disabled-pending-approval" },
        });
        expect(setup.pipeline.host.getStatus("example-plugin")).toBeUndefined();
        expect(callbackCalled).toBe(true);
      } finally {
        await setup.pipeline.dispose();
      }
    }, 60_000);

    it("survives a throwing old-runtime-stopped notification and still publishes the replacement", async () => {
      const setup = await setupEstablishedPlugin();
      try {
        setup.failNextRecordWrite();
        expect((await setup.pipeline.approve("example-plugin")).ok).toBe(false);
        expect(setup.pipeline.list()[0]?.status).toBe("failed");
        // The old runtime never stopped for this failure — it failed at the
        // durable write, before the stop step. The retry below reuses the
        // same, unchanged, durably-approved source, so it takes the ordinary
        // success path (not approval-hold) and reaches its own stop, where
        // the notification below throws.
        expect(setup.pipeline.host.getStatus("example-plugin")).toBe("ready");

        const rebuilt = await setup.pipeline.rebuild("example-plugin", {
          onOldRuntimeStopped: () => {
            throw new Error("simulated notification failure");
          },
        });

        expect(rebuilt).toMatchObject({
          ok: true,
          plugin: { status: "starting" },
        });
        await waitFor(
          () => setup.pipeline.list()[0]?.status === "ready",
          "Plugin did not reach ready after a throwing stop notification.",
        );
        expect(setup.pipeline.list()[0]?.status).toBe("ready");
      } finally {
        await setup.pipeline.dispose();
      }
    }, 60_000);

    it("holds changed source for approval instead of approving it on rebuild", async () => {
      const setup = await setupEstablishedPlugin();
      try {
        await setup.failEstablishedBuild();
        const approvedHash = setup.pipeline.list()[0]?.approvedHash;
        await writeFile(setup.entryPath, [
          'export const marker = "changed before retry";',
          "export default { activate() {} };",
          "",
        ].join("\n"));

        const rebuilt = await setup.pipeline.rebuild("example-plugin");

        expect(rebuilt).toMatchObject({
          ok: true,
          plugin: {
            status: "disabled-pending-approval",
            approvedHash,
          },
        });
        expect(setup.pipeline.list()[0]).toMatchObject({
          status: "disabled-pending-approval",
          approvedHash,
        });
        expect(setup.pipeline.host.getStatus("example-plugin")).toBeUndefined();
      } finally {
        await setup.pipeline.dispose();
      }
    }, 60_000);

    it("keeps the approved build recoverable when its rebuild fails again", async () => {
      const setup = await setupEstablishedPlugin();
      try {
        await setup.failEstablishedBuild();
        const approvedHash = setup.pipeline.list()[0]?.approvedHash;
        setup.failNextBuildPublish();

        const rebuilt = await setup.pipeline.rebuild("example-plugin");

        expect(rebuilt.ok).toBe(false);
        expect(setup.pipeline.list()[0]).toMatchObject({
          status: "failed",
          approvedHash,
        });
      } finally {
        await setup.pipeline.dispose();
      }
    }, 60_000);

    it("rejects rebuild when the plugin has no failed approved build", async () => {
      const setup = await setupEstablishedPlugin();
      try {
        await waitFor(
          () => setup.statuses.at(-1) === "ready",
          "The initial ready status event was not delivered.",
        );
        const buildsBefore = setup.buildCalls();
        const statusesBefore = setup.statuses.length;

        const rebuilt = await setup.pipeline.rebuild("example-plugin");
        await waitFor(
          () => setup.statuses.length > statusesBefore,
          "The rejected rebuild status event was not delivered.",
        );

        expect(rebuilt).toMatchObject({
          ok: false,
          error: {
            stage: "state",
            code: "no-failed-build",
            message: 'Plugin "example-plugin" has no failed build to retry.',
          },
        });
        expect(setup.buildCalls()).toBe(buildsBefore);
        expect(setup.statuses.slice(statusesBefore)).not.toContain("installing");
        expect(setup.statuses.slice(statusesBefore)).not.toContain("scanning");
        expect(setup.statuses.slice(statusesBefore)).not.toContain("building");
      } finally {
        await setup.pipeline.dispose();
      }
    }, 60_000);

    it("keeps offering a build retry through a crash-loop respawn, until the replacement publishes", async () => {
      const setup = await setupEstablishedPlugin();
      try {
        await setup.failEstablishedBuild();
        expect(setup.pipeline.list()[0]?.hasFailedReplacement).toBe(true);

        // A crash-loop respawn between the failure and the fix — the
        // host's own health reporting, not a rebuild — flips
        // runtimeStatus, and with it status via noteRuntimeStatus, back to
        // "ready" even though the replacement this failure owes was never
        // built.
        setup.pipeline.noteRuntimeStatus("example-plugin", "crashed");
        setup.pipeline.noteRuntimeStatus("example-plugin", "starting");
        setup.pipeline.noteRuntimeStatus("example-plugin", "ready");
        expect(setup.pipeline.list()[0]?.status).toBe("ready");
        expect(setup.pipeline.list()[0]?.hasFailedReplacement).toBe(true);

        const rebuilt = await setup.pipeline.rebuild("example-plugin");

        expect(rebuilt.ok).toBe(true);
        await waitFor(
          () =>
            setup.pipeline.list()[0]?.status === "ready" &&
            setup.pipeline.list()[0]?.hasFailedReplacement === false,
          "Plugin did not clear its failed-replacement fact after the retried build.",
        );
      } finally {
        await setup.pipeline.dispose();
      }
    }, 60_000);

    it("keeps Retry available through a crash-loop respawn even when the generated manifest cannot be read", async () => {
      const setup = await setupEstablishedPlugin();
      try {
        // captureRecoveredManifest reads this file to populate the
        // palette's own recovery cache — corrupted here so that read
        // fails, the way an interrupted publish or a permissions error
        // would leave it.
        const liveRoot = join(pluginsDataRoot(setup.fixture), "example-plugin");
        await writeFile(
          join(liveRoot, "dohc-plugin.generated.json"),
          "not valid json",
        );

        await setup.failEstablishedBuild();
        // hasFailedReplacement checks recoveryState.has(), even when its value
        // is null because the generated manifest could not be parsed. Retry stays
        // available without a recovered manifest for the palette preview.
        expect(setup.pipeline.list()[0]?.hasFailedReplacement).toBe(true);

        // A crash-loop respawn can report "ready" without rebuilding the failed
        // replacement. Recovery must survive that runtime status change.
        setup.pipeline.noteRuntimeStatus("example-plugin", "crashed");
        setup.pipeline.noteRuntimeStatus("example-plugin", "starting");
        setup.pipeline.noteRuntimeStatus("example-plugin", "ready");
        expect(setup.pipeline.list()[0]?.status).toBe("ready");

        // Retry must still be offered — an unreadable manifest cost the
        // palette its preview, not the user their own way back.
        const rebuilt = await setup.pipeline.rebuild("example-plugin");
        expect(rebuilt.ok).toBe(true);
      } finally {
        await setup.pipeline.dispose();
      }
    }, 60_000);

    it("keeps offering a build retry after a failed approve with no old runtime to preserve, even once something later resets status", async () => {
      const setup = await setupEstablishedPlugin();
      try {
        const disabled = await setup.pipeline.disable("example-plugin");
        expect(disabled.ok).toBe(true);
        expect(setup.pipeline.host.getStatus("example-plugin")).toBeUndefined();

        // Approve fails with nothing running to preserve — the branch
        // captureRecoveredManifest's own call used to skip entirely.
        setup.failNextBuild();
        await writeFile(setup.entryPath, [
          'export const marker = "attempted while disabled";',
          "export default { activate() {} };",
          "",
        ].join("\n"));
        const approved = await setup.pipeline.approve("example-plugin");
        expect(approved.ok).toBe(false);
        expect(setup.pipeline.list()[0]?.status).toBe("failed");
        expect(setup.pipeline.list()[0]?.hasFailedReplacement).toBe(true);

        // No host was running, but the failed replacement must survive other
        // status resets too. Simulate a reset directly, as in the respawn case.
        setup.pipeline.noteRuntimeStatus("example-plugin", "ready");
        expect(setup.pipeline.list()[0]?.status).toBe("ready");

        const retried = await setup.pipeline.rebuild("example-plugin");
        expect(retried.ok).toBe(true);
      } finally {
        await setup.pipeline.dispose();
      }
    }, 60_000);

    it("publishes the manifest a build actually installed and started, not discovery's own stale candidate, when the source changed again after discovery scanned it", async () => {
      const oldCommands = [{ id: "old.cmd", title: "Old Command" }];
      const newCommands = [{ id: "new.cmd", title: "New Command" }];
      const setup = await setupEstablishedPlugin({ commands: oldCommands });
      try {
        // No handleWatcherEvents call: requireValidCandidate's own
        // discovery cache still reads oldCommands. approve()'s own
        // snapshot reads this file directly off disk at build time and
        // picks up newCommands regardless — that snapshot's manifest, not
        // discovery's stale copy, is what actually got installed, scanned,
        // built and started.
        await writeFile(setup.manifestPath, setup.manifestText(newCommands));
        const approved = await setup.pipeline.approve("example-plugin");
        expect(approved.ok).toBe(true);
        expect(setup.pipeline.list()[0]?.commands).toEqual(newCommands);
        expect(
          setup.pipeline.pluginRegistration("example-plugin")?.manifest.commands,
        ).toEqual(newCommands);
      } finally {
        await setup.pipeline.dispose();
      }
    }, 60_000);

    it("refreshes the icon a build actually installed, not discovery's own stale one, when the source declared it again after discovery last scanned", async () => {
      const setup = await setupEstablishedPlugin();
      try {
        expect(setup.pipeline.list()[0]?.icon).toBeNull();
        // No handleWatcherEvents call, same as the manifest-staleness pin
        // above: discovery's own cached candidate still reports no icon.
        // Only this build's own snapshot sees the file added below.
        await writeFile(join(setup.fixture.pluginRoot, "icon.svg"), "<svg/>");
        await writeFile(
          setup.manifestPath,
          `${JSON.stringify({
            version: 1,
            name: "example-plugin",
            displayName: "Example plugin",
            entry: "src/index.ts",
            icon: "icon.svg",
            commands: [],
            settings: [],
          }, null, 2)}\n`,
        );
        const approved = await setup.pipeline.approve("example-plugin");
        expect(approved.ok).toBe(true);
        expect(setup.pipeline.list()[0]?.icon).toBe("icon.svg");
      } finally {
        await setup.pipeline.dispose();
      }
    }, 60_000);

    it("falls back to the prior contributions when a failed replacement has no readable manifest", async () => {
      const oldCommands = [{ id: "old.cmd", title: "Old Command" }];
      const newCommands = [{ id: "new.cmd", title: "New Command" }];
      const setup = await setupEstablishedPlugin({ commands: oldCommands });
      try {
        const liveRoot = join(pluginsDataRoot(setup.fixture), "example-plugin");
        await writeFile(
          join(liveRoot, "dohc-plugin.generated.json"),
          "not valid json",
        );
        await writeFile(setup.manifestPath, setup.manifestText(newCommands));
        await setup.pipeline.handleWatcherEvents([{
          path: "plugins/unrelated-plugin/dohc-plugin.json",
          operation: "update",
        }]);
        setup.failNextBuild();

        const approved = await setup.pipeline.approve("example-plugin");

        expect(approved.ok).toBe(false);
        expect(setup.pipeline.list()[0]).toMatchObject({
          status: "failed",
          hasFailedReplacement: true,
          commands: oldCommands,
        });
        expect(setup.pipeline.pluginRegistration("example-plugin")).toBeNull();
      } finally {
        await setup.pipeline.dispose();
      }
    }, 60_000);

    it("keeps a build retry available after the old runtime reaches crash-loop disable", async () => {
      const setup = await setupEstablishedPlugin();
      try {
        await setup.failEstablishedBuild();
        setup.pipeline.noteRuntimeStatus("example-plugin", "disabled");

        expect(setup.pipeline.list()[0]).toMatchObject({
          status: "disabled",
          disabledReason: "crash-loop",
          hasFailedReplacement: true,
        });
        expect((await setup.pipeline.rebuild("example-plugin")).ok).toBe(true);
        await waitFor(
          () =>
            setup.pipeline.list()[0]?.status === "ready" &&
            setup.pipeline.list()[0]?.hasFailedReplacement === false,
          "Plugin did not recover from a crash-loop disable.",
        );
      } finally {
        await setup.pipeline.dispose();
      }
    }, 60_000);

    it("reserves a host change before the queued action can run", async () => {
      const setup = await setupEstablishedPlugin();
      try {
        const disabling = setup.pipeline.disable("example-plugin");
        const racingCommand = await setup.hostOwnership.runCommand(
          "example-plugin",
          async () => "ran",
        );

        expect(racingCommand).toEqual({
          kind: "refused",
          reason: "change-in-progress",
        });
        expect((await disabling).ok).toBe(true);
      } finally {
        await setup.pipeline.dispose();
      }
    }, 60_000);

    it("revokes, stops, then awaits external runtime cleanup for disable", async () => {
      const steps: string[] = [];
      const cleanupEntered = deferred();
      const releaseCleanup = deferred();
      const setup = await setupEstablishedPlugin({
        onRuntimeStopped: async (pluginId) => {
          steps.push(`stopped:${pluginId}`);
          cleanupEntered.resolve();
          await releaseCleanup.promise;
          steps.push(`cleaned:${pluginId}`);
        },
      });
      const originalStop = setup.pipeline.host.stop.bind(setup.pipeline.host);
      const stop = vi.spyOn(setup.pipeline.host, "stop").mockImplementation(
        async (pluginId) => {
          steps.push("host-stop");
          await originalStop(pluginId);
        },
      );
      try {
        let settled = false;
        const disabling = setup.pipeline.disable("example-plugin", {
          onWillStopRuntime: (pluginId) => steps.push(`revoke:${pluginId}`),
        });
        void disabling.then(() => {
          settled = true;
        });

        await cleanupEntered.promise;
        expect(steps).toEqual([
          "revoke:example-plugin",
          "host-stop",
          "stopped:example-plugin",
        ]);
        await Promise.resolve();
        expect(settled).toBe(false);

        releaseCleanup.resolve();
        const disabled = await disabling;

        expect(disabled.ok).toBe(true);
        expect(steps).toEqual([
          "revoke:example-plugin",
          "host-stop",
          "stopped:example-plugin",
          "cleaned:example-plugin",
        ]);
      } finally {
        releaseCleanup.resolve();
        stop.mockRestore();
        await setup.pipeline.dispose();
      }
    }, 60_000);

    it("keeps external authority when disable fails before the stop boundary", async () => {
      const revoke = vi.fn();
      const stopped = vi.fn();
      const setup = await setupEstablishedPlugin({ onRuntimeStopped: stopped });
      try {
        setup.failNextRecordWrite();
        const disabled = await setup.pipeline.disable("example-plugin", {
          onWillStopRuntime: revoke,
        });

        expect(disabled.ok).toBe(false);
        expect(revoke).not.toHaveBeenCalled();
        expect(stopped).not.toHaveBeenCalled();
        expect(setup.pipeline.host.getStatus("example-plugin")).toBe("ready");
      } finally {
        await setup.pipeline.dispose();
      }
    }, 60_000);

    it("keeps a completed stop when external runtime cleanup rejects", async () => {
      const failure = new Error("simulated surface cleanup failure");
      const setup = await setupEstablishedPlugin({
        onRuntimeStopped: async () => {
          throw failure;
        },
      });
      const consoleError = vi.spyOn(console, "error").mockImplementation(
        () => undefined,
      );
      try {
        const disabled = await setup.pipeline.disable("example-plugin");

        expect(disabled.ok).toBe(true);
        expect(setup.pipeline.host.currentRecord("example-plugin"))
          .toBeUndefined();
        expect(consoleError).toHaveBeenCalledWith(
          expect.stringContaining("runtime-stopped cleanup failed"),
          failure,
        );
      } finally {
        consoleError.mockRestore();
        await setup.pipeline.dispose();
      }
    }, 60_000);

    it("keeps the live host when disable cannot revoke its external authority", async () => {
      const setup = await setupEstablishedPlugin();
      const runningRecord = setup.pipeline.host.currentRecord("example-plugin");
      const stop = vi.spyOn(setup.pipeline.host, "stop");
      try {
        const disabled = await setup.pipeline.disable("example-plugin", {
          onWillStopRuntime: () => {
            throw new Error("simulated authority revocation failure");
          },
        });

        expect(disabled).toMatchObject({
          ok: false,
          error: {
            code: "disable-failed",
            message: "simulated authority revocation failure",
          },
        });
        expect(stop).not.toHaveBeenCalled();
        expect(setup.pipeline.host.currentRecord("example-plugin"))
          .toBe(runningRecord);
        expect(setup.pipeline.host.getStatus("example-plugin")).toBe("ready");
        const state = await readPluginLocalState(
          setup.fixture.stateDir,
          setup.fixture.workspaceRoot,
        );
        if (!state.ok) throw new Error(state.warning);
        expect(state.state.plugins["example-plugin"]?.disabled).toBe(false);
      } finally {
        stop.mockRestore();
        await setup.pipeline.dispose();
      }
    }, 60_000);

    it("preserves a live plugin when uninstall cannot revoke its external authority", async () => {
      const setup = await setupEstablishedPlugin();
      const runningRecord = setup.pipeline.host.currentRecord("example-plugin");
      const stop = vi.spyOn(setup.pipeline.host, "stop");
      try {
        const preflight = await setup.pipeline.uninstallPreflight(
          "example-plugin",
          "example-plugin",
        );
        if (!preflight.ok) throw new Error(preflight.error.message);

        const removed = await setup.pipeline.uninstall(
          "example-plugin",
          "example-plugin",
          preflight.confirmationToken,
          {
            onWillStopRuntime: () => {
              throw new Error("simulated authority revocation failure");
            },
          },
        );

        expect(removed).toMatchObject({
          ok: false,
          error: {
            code: "delete-failed",
            message: "simulated authority revocation failure",
          },
        });
        expect(stop).not.toHaveBeenCalled();
        expect(setup.pipeline.host.currentRecord("example-plugin"))
          .toBe(runningRecord);
        await expect(lstat(setup.fixture.pluginRoot)).resolves.toBeDefined();
      } finally {
        stop.mockRestore();
        await setup.pipeline.dispose();
      }
    }, 60_000);

    it("restores durable enablement when disable cannot stop the live host", async () => {
      const stopped = vi.fn();
      const setup = await setupEstablishedPlugin({ onRuntimeStopped: stopped });
      const record = setup.pipeline.host.currentRecord("example-plugin");
      expect(record).toBeDefined();
      const stop = vi.spyOn(setup.pipeline.host, "stop").mockRejectedValue(
        new Error("simulated stop failure with a live record"),
      );
      try {
        const disabled = await setup.pipeline.disable("example-plugin");

        expect(disabled).toMatchObject({
          ok: false,
          error: {
            code: "disable-failed",
            message: "simulated stop failure with a live record",
          },
        });
        expect(stop).toHaveBeenCalledTimes(1);
        expect(stopped).not.toHaveBeenCalled();
        expect(setup.pipeline.host.currentRecord("example-plugin")).toBe(record);
        expect(setup.pipeline.host.getStatus("example-plugin")).toBe("ready");
        expect(setup.pipeline.list()[0]).toMatchObject({
          status: "ready",
          runtimeStatus: "ready",
          error: { code: "disable-failed" },
        });
        const state = await readPluginLocalState(
          setup.fixture.stateDir,
          setup.fixture.workspaceRoot,
        );
        if (!state.ok) throw new Error(state.warning);
        expect(state.state.plugins["example-plugin"]?.disabled).toBe(false);

        await expect(
          setup.hostOwnership.runCommand(
            "example-plugin",
            async (authority) => authority.start(() =>
              setup.pipeline.ensureStarted("example-plugin", authority)),
          ),
        ).resolves.toMatchObject({
          kind: "completed",
          value: {
            kind: "admitted",
            value: {
              ok: true,
              plugin: { status: "ready", runtimeStatus: "ready" },
            },
          },
        });
      } finally {
        stop.mockRestore();
        await setup.pipeline.dispose();
      }
    }, 60_000);

    it("keeps the safe durable disable when stop compensation cannot be written", async () => {
      const setup = await setupEstablishedPlugin();
      const record = setup.pipeline.host.currentRecord("example-plugin");
      expect(record).toBeDefined();
      const consoleError = vi.spyOn(console, "error").mockImplementation(
        () => undefined,
      );
      const stop = vi.spyOn(setup.pipeline.host, "stop").mockImplementation(
        async () => {
          setup.failNextRecordWrite();
          throw new Error("simulated original stop failure");
        },
      );
      try {
        const disabled = await setup.pipeline.disable("example-plugin");

        expect(disabled).toMatchObject({
          ok: false,
          error: {
            code: "disable-failed",
            message: "simulated original stop failure",
          },
        });
        expect(stop).toHaveBeenCalledTimes(1);
        expect(setup.pipeline.host.currentRecord("example-plugin")).toBe(record);
        expect(setup.pipeline.host.getStatus("example-plugin")).toBe("ready");
        const state = await readPluginLocalState(
          setup.fixture.stateDir,
          setup.fixture.workspaceRoot,
        );
        if (!state.ok) throw new Error(state.warning);
        expect(state.state.plugins["example-plugin"]?.disabled).toBe(true);
        expect(consoleError).toHaveBeenCalledWith(
          expect.stringContaining("failed to restore the durable state"),
          expect.objectContaining({
            message: "simulated approval record write failure",
          }),
        );
      } finally {
        stop.mockRestore();
        consoleError.mockRestore();
        await setup.pipeline.dispose();
      }
    }, 60_000);

    it("keeps the durable disable when disposal supersedes the stop", async () => {
      const setup = await setupEstablishedPlugin();
      try {
        const disabling = setup.pipeline.disable("example-plugin");
        const disposing = setup.pipeline.dispose();

        await expect(disabling).resolves.toMatchObject({ ok: false });
        await disposing;

        const state = await readPluginLocalState(
          setup.fixture.stateDir,
          setup.fixture.workspaceRoot,
        );
        if (!state.ok) throw new Error(state.warning);
        expect(state.state.plugins["example-plugin"]?.disabled).toBe(true);
        expect(setup.pipeline.host.currentRecord("example-plugin")).toBeUndefined();
      } finally {
        await setup.pipeline.dispose();
      }
    }, 60_000);

    it("keeps warm command admission open while approved source is verified", async () => {
      const setup = await setupEstablishedPlugin();
      const snapshotGate = setup.gateNextSnapshot();
      const statusEventStart = setup.statuses.length;
      let runChangeCalls = () => -1;
      try {
        const first = setup.hostOwnership.runCommand(
          "example-plugin",
          async (authority) => {
            const runChange = vi.spyOn(authority, "runChange");
            runChangeCalls = () => runChange.mock.calls.length;
            return authority.start(() =>
              setup.pipeline.ensureStarted("example-plugin", authority));
          },
        );
        await snapshotGate.entered.promise;
        expect(runChangeCalls()).toBe(0);

        const secondEntered = deferred();
        const second = setup.hostOwnership.runCommand(
          "example-plugin",
          async (authority) => {
            secondEntered.resolve();
            return authority.start(() =>
              setup.pipeline.ensureStarted("example-plugin", authority));
          },
        );
        await expect(Promise.race([
          secondEntered.promise.then(() => "entered"),
          second.then(() => "settled"),
        ])).resolves.toBe("entered");

        snapshotGate.release.resolve();
        await expect(first).resolves.toMatchObject({
          kind: "completed",
          value: { kind: "admitted", value: { ok: true } },
        });
        await expect(second).resolves.toMatchObject({
          kind: "completed",
          value: { kind: "admitted", value: { ok: true } },
        });
        expect(runChangeCalls()).toBe(0);
        expect(setup.pipeline.list()[0]).toMatchObject({
          status: "ready",
          runtimeStatus: "ready",
        });
        const warmStatusEvents = setup.statuses.slice(statusEventStart);
        expect(warmStatusEvents).not.toContain("starting");
        expect(warmStatusEvents.at(-1)).toBe("ready");
      } finally {
        snapshotGate.release.resolve();
        await setup.pipeline.dispose();
      }
    }, 60_000);

    it("reserves a queued warm surface before a later command can queue behind it", async () => {
      const setup = await setupEstablishedPlugin({ drainTimeoutMs: 0 });
      const snapshotGate = setup.gateNextSnapshot();
      const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
      const surface = setup.hostOwnership.acquireSurface("example-plugin");
      if ("kind" in surface) throw new Error("Surface lease was refused.");
      let first: Promise<unknown> | undefined;
      let surfaceStart: Promise<unknown> | undefined;
      let second: Promise<unknown> | undefined;
      try {
        first = setup.hostOwnership.runCommand(
          "example-plugin",
          async (authority) => authority.start(() =>
            setup.pipeline.ensureStarted("example-plugin", authority)),
        );
        await snapshotGate.entered.promise;
        const bundlePath = liveBundlePath(setup.fixture, "example-plugin");
        await writeFile(
          bundlePath,
          `${await readFile(bundlePath, "utf8")}\n// tampered before the queued surface\n`,
        );

        surfaceStart = surface.start((authority) =>
          setup.pipeline.ensureStarted("example-plugin", authority));
        const secondEntered = deferred();
        second = setup.hostOwnership.runCommand(
          "example-plugin",
          async (authority) => {
            secondEntered.resolve();
            return authority.start(() =>
              setup.pipeline.ensureStarted("example-plugin", authority));
          },
        );
        const secondObservation = await Promise.race([
          second.then((result) => ({ kind: "settled" as const, result })),
          secondEntered.promise.then(() => ({ kind: "entered" as const })),
        ]);
        expect(secondObservation).toEqual({
          kind: "settled",
          result: { kind: "refused", reason: "change-in-progress" },
        });

        snapshotGate.release.resolve();
        await expect(first).resolves.toMatchObject({
          kind: "completed",
          value: {
            kind: "admitted",
            value: {
              ok: false,
              error: { code: HOST_CHANGE_REFUSED_ERROR_CODE },
            },
          },
        });
        await expect(surfaceStart).resolves.toMatchObject({
          kind: "admitted",
          value: { ok: true },
        });
        await expect(second).resolves.toEqual({
          kind: "refused",
          reason: "change-in-progress",
        });
        expect(warn).not.toHaveBeenCalled();
      } finally {
        snapshotGate.release.resolve();
        await Promise.allSettled(
          [first, surfaceStart, second].filter(
            (pending): pending is Promise<unknown> => pending !== undefined,
          ),
        );
        await surface.release();
        await setup.pipeline.dispose();
        warn.mockRestore();
      }
    }, 60_000);

    it("parks a second queued surface outside the first surface change", async () => {
      const setup = await setupEstablishedPlugin({ drainTimeoutMs: 0 });
      const snapshotGate = setup.gateNextSnapshot();
      const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
      const firstSurface = setup.hostOwnership.acquireSurface("example-plugin");
      const secondSurface = setup.hostOwnership.acquireSurface("example-plugin");
      if ("kind" in firstSurface || "kind" in secondSurface) {
        throw new Error("Surface lease was refused.");
      }
      let command: Promise<unknown> | undefined;
      let firstStart: Promise<unknown> | undefined;
      let secondStart: Promise<unknown> | undefined;
      let secondEnqueued = false;
      try {
        command = setup.hostOwnership.runCommand(
          "example-plugin",
          async (authority) => authority.start(() =>
            setup.pipeline.ensureStarted("example-plugin", authority)),
        );
        await snapshotGate.entered.promise;
        const bundlePath = liveBundlePath(setup.fixture, "example-plugin");
        await writeFile(
          bundlePath,
          `${await readFile(bundlePath, "utf8")}\n// tampered before two queued surfaces\n`,
        );

        firstStart = firstSurface.start((authority) =>
          setup.pipeline.ensureStarted("example-plugin", authority));
        secondStart = secondSurface.start((authority) => {
          secondEnqueued = true;
          return setup.pipeline.ensureStarted("example-plugin", authority);
        });
        expect(secondEnqueued).toBe(false);

        snapshotGate.release.resolve();
        await expect(command).resolves.toMatchObject({
          kind: "completed",
          value: {
            kind: "admitted",
            value: {
              ok: false,
              error: { code: HOST_CHANGE_REFUSED_ERROR_CODE },
            },
          },
        });
        await expect(firstStart).resolves.toMatchObject({
          kind: "admitted",
          value: { ok: true },
        });
        await expect(secondStart).resolves.toMatchObject({
          kind: "admitted",
          value: { ok: true },
        });
        expect(warn).not.toHaveBeenCalled();
      } finally {
        snapshotGate.release.resolve();
        await Promise.allSettled(
          [command, firstStart, secondStart].filter(
            (pending): pending is Promise<unknown> => pending !== undefined,
          ),
        );
        await firstSurface.release();
        await secondSurface.release();
        await setup.pipeline.dispose();
        warn.mockRestore();
      }
    }, 60_000);

    it("keeps surface verification under change admission", async () => {
      const setup = await setupEstablishedPlugin();
      const snapshotGate = setup.gateNextSnapshot();
      const lease = setup.hostOwnership.acquireSurface("example-plugin");
      if ("kind" in lease) throw new Error("Surface lease was refused.");
      let runChangeCalls = () => -1;
      try {
        const starting = lease.start(async (authority) => {
          const runChange = vi.spyOn(authority, "runChange");
          runChangeCalls = () => runChange.mock.calls.length;
          return setup.pipeline.ensureStarted("example-plugin", authority);
        });
        await snapshotGate.entered.promise;

        expect(runChangeCalls()).toBe(1);
        await expect(
          setup.hostOwnership.runCommand(
            "example-plugin",
            async () => "ran",
          ),
        ).resolves.toEqual({
          kind: "refused",
          reason: "change-in-progress",
        });

        snapshotGate.release.resolve();
        await expect(starting).resolves.toMatchObject({
          kind: "admitted",
          value: { ok: true },
        });
      } finally {
        snapshotGate.release.resolve();
        await lease.release();
        await setup.pipeline.dispose();
      }
    }, 60_000);

    it("returns exact evidence for a cold command start", async () => {
      const fixture = await createPluginWorkspace();
      let pipeline: PluginPipeline;
      const host = new PluginHost({
        stateDir: fixture.stateDir,
        workspaceRoot: fixture.workspaceRoot,
        spawnTransport: fakeSpawnTransport(),
        routeSdkRequest: async () => ({}),
        onStatusChange: (pluginId, status) => {
          pipeline.noteRuntimeStatus(pluginId, status);
        },
      });
      const hostOwnership = new PluginHostOwnership(host);
      pipeline = new PluginPipeline({
        isEngineCaptureAvailable: () => true,
        workspaceRoot: fixture.workspaceRoot,
        stateDir: fixture.stateDir,
        hostOwnership,
        resourcesBasePath,
        pnpmRunnerEntry,
        operations: {
          install: (input) =>
            installPluginDependencies({ ...input, forkProcess: nodeForkProcess }),
        },
      });

      try {
        await pipeline.start();
        let exactResult:
          | Awaited<ReturnType<PluginPipeline["ensureStarted"]>>
          | undefined;
        const command = await hostOwnership.runCommand(
          "example-plugin",
          async (authority) => authority.start(async () => {
            exactResult = await pipeline.ensureStarted("example-plugin", authority);
            return exactResult;
          }),
        );

        expect(command).toMatchObject({
          kind: "completed",
          value: {
            kind: "admitted",
            value: {
              ok: true,
              plugin: { status: "starting", runtimeStatus: "starting" },
            },
          },
        });
        expect(exactResult?.kind).toBe("started");
        expect(host.getStatus("example-plugin")).toBeUndefined();
      } finally {
        await pipeline.dispose();
      }
    }, 60_000);

    it("preserves workspace ownership when a surface rebuilds a running host", async () => {
      const setup = await setupEstablishedPlugin();
      try {
        await writeFile(
          liveBundlePath(setup.fixture, "example-plugin"),
          "// changed after approval\n",
        );
        const surface = await ensureFromSurface(
          setup.pipeline,
          "example-plugin",
        );

        expect(surface.result).toMatchObject({ ok: true });
        expect(surface.exact.kind).toBe("existing");
        await surface.release();
        expect(setup.pipeline.host.getStatus("example-plugin")).toBeDefined();
      } finally {
        await setup.pipeline.dispose();
      }
    }, 60_000);

    it("restores ready status when a command finds a running host without approval", async () => {
      const setup = await setupEstablishedPlugin();
      try {
        await mutatePluginRecord(
          setup.fixture.stateDir,
          setup.fixture.workspaceRoot,
          "example-plugin",
          (record) => {
            if (!record) throw new Error("Expected an installed plugin record.");
            const { approvedHash: _approvedHash, ...withoutApproval } = record;
            return withoutApproval;
          },
        );
        const statusBefore = setup.pipeline.list()[0];
        const stateBefore = await readPluginLocalState(
          setup.fixture.stateDir,
          setup.fixture.workspaceRoot,
        );
        if (!stateBefore.ok) throw new Error(stateBefore.warning);

        const started = await ensureFromCommand(setup.pipeline, "example-plugin");

        expect(started).toMatchObject({
          exact: { kind: "existing" },
          result: {
            ok: false,
            error: { code: HOST_CHANGE_REFUSED_ERROR_CODE },
          },
        });
        expect(setup.pipeline.list()[0]).toEqual(statusBefore);
        const stateAfter = await readPluginLocalState(
          setup.fixture.stateDir,
          setup.fixture.workspaceRoot,
        );
        expect(stateAfter).toEqual(stateBefore);
        expect(setup.pipeline.host.getStatus("example-plugin")).toBeDefined();
      } finally {
        await setup.pipeline.dispose();
      }
    }, 60_000);

    it("refuses a command-origin approval hold before it mutates the record", async () => {
      const setup = await setupEstablishedPlugin();
      try {
        await writeFile(setup.entryPath, [
          'export const marker = "edited out of band";',
          "export default { activate() {} };",
          "",
        ].join("\n"));

        let exactResult:
          | Awaited<ReturnType<PluginPipeline["ensureStarted"]>>
          | undefined;
        const command = await setup.hostOwnership.runCommand(
          "example-plugin",
          async (authority) => authority.start(async () => {
            exactResult = await setup.pipeline.ensureStarted(
              "example-plugin",
              authority,
            );
            return exactResult;
          }),
        );

        expect(command).toMatchObject({
          kind: "completed",
          value: {
            kind: "admitted",
            value: { ok: false, error: { code: HOST_CHANGE_REFUSED_ERROR_CODE } },
          },
        });
        expect(exactResult?.kind).toBe("existing");
        expect(setup.pipeline.list()[0]?.status).toBe("ready");
        const state = await readPluginLocalState(
          setup.fixture.stateDir,
          setup.fixture.workspaceRoot,
        );
        if (!state.ok) throw new Error(state.warning);
        expect(state.state.plugins["example-plugin"]?.disabled).toBe(false);
        expect(setup.pipeline.host.getStatus("example-plugin")).toBeDefined();
      } finally {
        await setup.pipeline.dispose();
      }
    }, 60_000);

    it("refuses a command-origin bundle repair before it mutates durable state", async () => {
      const setup = await setupEstablishedPlugin();
      try {
        const stateBefore = await readPluginLocalState(
          setup.fixture.stateDir,
          setup.fixture.workspaceRoot,
        );
        if (!stateBefore.ok) throw new Error(stateBefore.warning);
        await writeFile(
          liveBundlePath(setup.fixture, "example-plugin"),
          "globalThis.tampered = true;\n",
        );

        let exactResult:
          | Awaited<ReturnType<PluginPipeline["ensureStarted"]>>
          | undefined;
        const command = await setup.hostOwnership.runCommand(
          "example-plugin",
          async (authority) => authority.start(async () => {
            exactResult = await setup.pipeline.ensureStarted(
              "example-plugin",
              authority,
            );
            return exactResult;
          }),
        );

        expect(command).toMatchObject({
          kind: "completed",
          value: {
            kind: "admitted",
            value: { ok: false, error: { code: HOST_CHANGE_REFUSED_ERROR_CODE } },
          },
        });
        expect(exactResult?.kind).toBe("existing");
        expect(setup.pipeline.list()[0]?.status).toBe("ready");
        const stateAfter = await readPluginLocalState(
          setup.fixture.stateDir,
          setup.fixture.workspaceRoot,
        );
        if (!stateAfter.ok) throw new Error(stateAfter.warning);
        expect(stateAfter.state.plugins["example-plugin"])
          .toEqual(stateBefore.state.plugins["example-plugin"]);
        expect(await stagingLeftovers(setup.fixture, "example-plugin")).toEqual([]);
        expect(await readFile(
          liveBundlePath(setup.fixture, "example-plugin"),
          "utf8",
        )).toBe("globalThis.tampered = true;\n");
        expect(setup.pipeline.host.getStatus("example-plugin")).toBeDefined();
      } finally {
        await setup.pipeline.dispose();
      }
    }, 60_000);

    it("adopts a runtime that an explicit action started before it failed", async () => {
      const setup = await setupEstablishedPlugin();
      try {
        expect((await setup.pipeline.disable("example-plugin")).ok).toBe(true);
        const originalStart = setup.pipeline.host.start.bind(setup.pipeline.host);
        let failNextPipelineStatus = false;
        vi.spyOn(setup.pipeline.host, "start").mockImplementation(async (...args) => {
          const evidence = await originalStart(...args);
          failNextPipelineStatus = true;
          return evidence;
        });
        const pipelineInternals = setup.pipeline as unknown as {
          setStatus: (...args: unknown[]) => unknown;
        };
        const originalSetStatus = pipelineInternals.setStatus.bind(setup.pipeline);
        vi.spyOn(pipelineInternals, "setStatus").mockImplementation((...args) => {
          if (failNextPipelineStatus) {
            failNextPipelineStatus = false;
            throw new Error("simulated post-start status failure");
          }
          return originalSetStatus(...args);
        });

        const enabled = await setup.pipeline.enable("example-plugin");

        expect(enabled).toMatchObject({
          ok: false,
          error: { code: "enable-failed" },
        });
        expect(setup.pipeline.host.getStatus("example-plugin")).toBeDefined();
      } finally {
        await setup.pipeline.dispose();
      }
    }, 60_000);

    it("closes ownership once and prevents a queued action from starting the host", async () => {
      const setup = await setupEstablishedPlugin();
      const queueGate = deferred();
      try {
        expect((await setup.pipeline.disable("example-plugin")).ok).toBe(true);
        const enqueue = (
          setup.pipeline as unknown as {
            enqueueActionValue: <T>(
              pluginId: string,
              run: () => Promise<T>,
            ) => Promise<T>;
          }
        ).enqueueActionValue.bind(setup.pipeline);
        const blocker = enqueue("example-plugin", async () => {
          await queueGate.promise;
        });
        const enabling = setup.pipeline.enable("example-plugin");
        const close = vi.spyOn(setup.hostOwnership, "close");

        const firstDispose = setup.pipeline.dispose();
        const secondDispose = setup.pipeline.dispose();
        expect(secondDispose).toBe(firstDispose);
        queueGate.resolve();

        await blocker;
        await expect(enabling).resolves.toMatchObject({
          ok: false,
          error: { code: "pipeline-closed" },
        });
        await firstDispose;
        expect(close).toHaveBeenCalledTimes(1);
        expect(setup.pipeline.host.getStatus("example-plugin")).toBeUndefined();
        await expect(setup.pipeline.enable("example-plugin")).resolves.toMatchObject({
          ok: false,
          error: { code: "pipeline-closed" },
        });
        await expect(
          setup.pipeline.uninstallPreflight("example-plugin", "example-plugin"),
        ).resolves.toMatchObject({
          ok: false,
          error: { code: "pipeline-closed" },
        });
        await expect(
          setup.pipeline.uninstall("example-plugin", "example-plugin", "expired"),
        ).resolves.toMatchObject({
          ok: false,
          error: { code: "pipeline-closed" },
        });
      } finally {
        queueGate.resolve();
        await setup.pipeline.dispose();
      }
    }, 60_000);

    it("does not translate an ordinary stale reservation into pipeline close", async () => {
      const setup = await setupEstablishedPlugin();
      const stale = setup.hostOwnership.reserveChange("example-plugin");
      await stale.cancel();
      vi.spyOn(setup.hostOwnership, "reserveChange").mockReturnValueOnce(stale);

      const disabling = setup.pipeline.disable("example-plugin");
      const disposing = setup.pipeline.dispose();

      await expect(disabling).rejects.toThrow(
        "Change reservation is no longer active.",
      );
      await disposing;
    }, 60_000);

    it("releases reservations after action preconditions fail", async () => {
      const setup = await setupEstablishedPlugin();
      try {
        expect((await setup.pipeline.rebuild("example-plugin")).ok).toBe(false);
        await expect(
          setup.hostOwnership.runCommand("example-plugin", async () => "ready"),
        ).resolves.toEqual({ kind: "completed", value: "ready" });

        expect((await setup.pipeline.disable("missing-plugin")).ok).toBe(false);
        await expect(
          setup.hostOwnership.runCommand("missing-plugin", async () => "ready"),
        ).resolves.toEqual({ kind: "completed", value: "ready" });
      } finally {
        await setup.pipeline.dispose();
      }
    }, 60_000);

    it("preserves a command cold start through a precondition-failed action", async () => {
      const setup = await setupEstablishedPlugin();
      const commandStarted = deferred();
      const releaseCommand = deferred();
      try {
        expect((await setup.pipeline.disable("example-plugin")).ok).toBe(true);
        await mutatePluginRecord(
          setup.fixture.stateDir,
          setup.fixture.workspaceRoot,
          "example-plugin",
          (record) => ({ ...record, disabled: false }),
        );
        const command = setup.hostOwnership.runCommand(
          "example-plugin",
          async (authority) => {
            const started = await authority.start(() =>
              setup.pipeline.ensureStarted("example-plugin", authority));
            commandStarted.resolve();
            await releaseCommand.promise;
            return started;
          },
        );
        await commandStarted.promise;
        expect(setup.pipeline.host.getStatus("example-plugin")).toBeDefined();

        const rebuilt = await setup.pipeline.rebuild("example-plugin");
        expect(rebuilt).toMatchObject({
          ok: false,
          error: { code: "no-failed-build" },
        });
        expect(setup.pipeline.host.getStatus("example-plugin")).toBeDefined();

        releaseCommand.resolve();
        await command;
        expect(setup.pipeline.host.getStatus("example-plugin")).toBeUndefined();
      } finally {
        releaseCommand.resolve();
        await setup.pipeline.dispose();
      }
    }, 60_000);

    it("propagates owner close failure after stopping the host", async () => {
      const setup = await setupEstablishedPlugin();
      const stopAll = setup.pipeline.host.stopAll.bind(setup.pipeline.host);
      vi.spyOn(setup.pipeline.host, "stopAll").mockImplementationOnce(async () => {
        await stopAll();
        throw new Error("simulated owner close failure");
      });

      await expect(setup.pipeline.dispose()).rejects.toThrow(
        "simulated owner close failure",
      );
      expect(setup.pipeline.host.getStatus("example-plugin")).toBeUndefined();
      await expect(setup.pipeline.enable("example-plugin")).resolves.toMatchObject({
        ok: false,
        error: { code: "pipeline-closed" },
      });
    }, 60_000);

    it("waits for a live command before disposal stops the host", async () => {
      const setup = await setupEstablishedPlugin();
      const commandEntered = deferred();
      const commandGate = deferred();
      const bumpGeneration = vi.spyOn(setup.pipeline.host, "bumpGeneration");
      try {
        const command = setup.hostOwnership.runCommand(
          "example-plugin",
          async () => {
            commandEntered.resolve();
            await commandGate.promise;
          },
        );
        await commandEntered.promise;

        const disposing = setup.pipeline.dispose();

        await expect(
          setup.hostOwnership.runCommand("example-plugin", async () => undefined),
        ).resolves.toEqual({ kind: "refused", reason: "closed" });
        expect(setup.pipeline.host.getStatus("example-plugin")).toBe("ready");
        expect(bumpGeneration).not.toHaveBeenCalled();

        commandGate.resolve();
        await command;
        await disposing;
        expect(bumpGeneration).toHaveBeenCalledTimes(1);
        expect(setup.pipeline.host.getStatus("example-plugin")).toBeUndefined();
      } finally {
        commandGate.resolve();
        await setup.pipeline.dispose();
      }
    }, 60_000);

    it("warns when a host change reaches the command drain deadline", async () => {
      const setup = await setupEstablishedPlugin({ drainTimeoutMs: 0 });
      const commandEntered = deferred();
      const commandGate = deferred();
      const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
      try {
        const command = setup.hostOwnership.runCommand(
          "example-plugin",
          async () => {
            commandEntered.resolve();
            await commandGate.promise;
          },
        );
        await commandEntered.promise;
        await writeFile(setup.entryPath, [
          'export const marker = "replacement";',
          "export default { activate() {} };",
          "",
        ].join("\n"));

        const approved = await setup.pipeline.approve("example-plugin");

        expect(approved.ok).toBe(true);
        expect(warn).toHaveBeenCalledWith(expect.stringContaining(
          'Plugin "example-plugin" still has work in flight',
        ));
        commandGate.resolve();
        await command;
      } finally {
        commandGate.resolve();
        warn.mockRestore();
        await setup.pipeline.dispose();
      }
    }, 60_000);

    it("runs stop-boundary consequences after transport cleanup rejects", async () => {
      const setup = await setupEstablishedPlugin();
      let oldRuntimeStoppedCalls = 0;
      try {
        await setup.failEstablishedBuild();
        setup.failNextStop();

        const rebuilt = await setup.pipeline.rebuild("example-plugin", {
          onOldRuntimeStopped: () => {
            oldRuntimeStoppedCalls += 1;
          },
        });

        expect(rebuilt.ok).toBe(true);
        expect(oldRuntimeStoppedCalls).toBe(1);
        await expect(
          setup.hostOwnership.runCommand("example-plugin", async () => "ready"),
        ).resolves.toEqual({ kind: "completed", value: "ready" });
      } finally {
        await setup.pipeline.dispose();
      }
    }, 60_000);

    it("takes an ownership stop boundary when no host record exists yet", async () => {
      const setup = await setupEstablishedPlugin();
      try {
        expect((await setup.pipeline.disable("example-plugin")).ok).toBe(true);
        expect(setup.pipeline.host.currentRecord("example-plugin")).toBeUndefined();
        const stop = vi.spyOn(setup.pipeline.host, "stop");

        const disabled = await setup.pipeline.disable("example-plugin");

        expect(disabled.ok).toBe(true);
        expect(stop).toHaveBeenCalledTimes(1);
      } finally {
        await setup.pipeline.dispose();
      }
    }, 60_000);

    it("holds changed source without stopping again when no host record exists", async () => {
      const setup = await setupEstablishedPlugin();
      try {
        expect((await setup.pipeline.disable("example-plugin")).ok).toBe(true);
        const stop = vi.spyOn(setup.pipeline.host, "stop");
        await writeFile(setup.entryPath, [
          'export const marker = "changed while disabled";',
          "export default { activate() {} };",
          "",
        ].join("\n"));

        const enabled = await setup.pipeline.enable("example-plugin");

        expect(enabled).toMatchObject({
          ok: true,
          plugin: { status: "disabled-pending-approval" },
        });
        expect(stop).not.toHaveBeenCalled();
      } finally {
        await setup.pipeline.dispose();
      }
    }, 60_000);

    it("keeps ownership closed across queued source refresh and identity removal", async () => {
      const setup = await setupEstablishedPlugin();
      let buildGate: ReturnType<typeof setup.gateNextBuild> | undefined;
      try {
        buildGate = setup.gateNextBuild();
        const driftedText = [
          'export const marker = "door-written drift";',
          "export default { activate() {} };",
          "",
        ].join("\n");
        await writeFile(setup.entryPath, driftedText);
        setup.pipeline.handleDoorWrittenSourceChange("example-plugin", {
          absolutePath: setup.entryPath,
          text: driftedText,
        });
        await buildGate.entered.promise;
        await expect(
          setup.hostOwnership.runCommand("example-plugin", async () => undefined),
        ).resolves.toEqual({ kind: "refused", reason: "change-in-progress" });

        await rm(setup.fixture.pluginRoot, { recursive: true, force: true });
        const watching = setup.pipeline.handleWatcherEvents([{
          path: "plugins/example-plugin",
          operation: "delete",
        }]);
        await expect(
          setup.hostOwnership.runCommand("example-plugin", async () => undefined),
        ).resolves.toEqual({ kind: "refused", reason: "change-in-progress" });

        buildGate.release.resolve();
        await watching;

        await expect(
          setup.hostOwnership.runCommand("example-plugin", async () => "ready"),
        ).resolves.toEqual({ kind: "completed", value: "ready" });
        expect(
          setup.pipeline.list().some((plugin) => plugin.id === "example-plugin"),
        ).toBe(false);
      } finally {
        buildGate?.release.resolve();
        await setup.pipeline.dispose();
      }
    }, 60_000);

    it("awaits failed surface cleanup before removing a watched identity", async () => {
      const cleanupEntered = deferred();
      const cleanupRelease = deferred();
      const cleanupFailure = new Error("simulated surface cleanup failure");
      const steps: string[] = [];
      let watcherSettled = false;
      const setup = await setupEstablishedPlugin({
        onRuntimeStopped: async (pluginId) => {
          steps.push(`cleanup:${pluginId}`);
          cleanupEntered.resolve();
          await cleanupRelease.promise;
          steps.push(`cleanup-failed:${pluginId}`);
          throw cleanupFailure;
        },
      });
      const consoleError = vi.spyOn(console, "error").mockImplementation(
        () => undefined,
      );
      try {
        await rm(setup.fixture.pluginRoot, { recursive: true, force: true });
        const watching = setup.pipeline.handleWatcherEvents([{
          path: "plugins/example-plugin",
          operation: "delete",
        }]).then(() => {
          watcherSettled = true;
          steps.push("watcher-settled");
        });

        await cleanupEntered.promise;

        expect(steps).toEqual(["cleanup:example-plugin"]);
        expect(setup.pipeline.host.currentRecord("example-plugin")).toBeUndefined();
        expect(watcherSettled).toBe(false);
        const whileCleaning = await readPluginLocalState(
          setup.fixture.stateDir,
          setup.fixture.workspaceRoot,
        );
        if (!whileCleaning.ok) throw new Error(whileCleaning.warning);
        expect(whileCleaning.state.plugins["example-plugin"]).toBeDefined();

        cleanupRelease.resolve();
        await watching;

        expect(steps).toEqual([
          "cleanup:example-plugin",
          "cleanup-failed:example-plugin",
          "watcher-settled",
        ]);
        const removed = await readPluginLocalState(
          setup.fixture.stateDir,
          setup.fixture.workspaceRoot,
        );
        if (!removed.ok) throw new Error(removed.warning);
        expect(removed.state.plugins["example-plugin"]).toBeUndefined();
        expect(
          setup.pipeline.list().some((plugin) => plugin.id === "example-plugin"),
        ).toBe(false);
        expect(consoleError).toHaveBeenCalledWith(
          expect.stringContaining("runtime-stopped cleanup failed"),
          cleanupFailure,
        );
      } finally {
        cleanupRelease.resolve();
        consoleError.mockRestore();
        await setup.pipeline.dispose();
      }
    }, 60_000);

  });
}
