import { it } from "vitest";

import { engine, runDeleteRepros } from "./twoDaemonSync.fixture";

it.skipIf(engine.missing)("refuses deleting an owner-bound live page and keeps its workspace publishing (bound, unbound)",
  () => runDeleteRepros(["bound", "unbound"]), 300_000);

it.skipIf(engine.missing)("refuses restoring an owner-bound live page to before its creation and keeps its workspace publishing",
  () => runDeleteRepros(["restore"]), 300_000);

it.skipIf(engine.missing)("deletes a live page after Stop, and refuses it after a deferred Stop (stop-then-delete, deferred-stop)",
  () => runDeleteRepros(["stop-then-delete", "deferred-stop"]), 300_000);

// Each file-manager case runs alone: its console spies wrap whatever console it finds.
it.skipIf(engine.missing).each(["file-manager-stop", "file-manager-capture-stop-early", "file-manager-capture-stop"] as const)(
  "says Stop live editing stopped for an owner-bound live page deleted outside dohc (#3129, %s)", kind => runDeleteRepros([kind]), 300_000);
