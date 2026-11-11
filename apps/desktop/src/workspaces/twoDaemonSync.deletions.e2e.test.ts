import { it } from "vitest";

import { engine, runDeleteRepros } from "./twoDaemonSync.fixture";

it.skipIf(engine.missing)("refuses deleting an owner-bound live page and keeps its workspace publishing (bound, unbound)",
  () => runDeleteRepros(["bound", "unbound"]), 300_000);

it.skipIf(engine.missing)("refuses restoring an owner-bound live page to before its creation and keeps its workspace publishing",
  () => runDeleteRepros(["restore"]), 300_000);

it.skipIf(engine.missing)("deletes a live page after Stop, and refuses it after a deferred Stop (stop-then-delete, deferred-stop)",
  () => runDeleteRepros(["stop-then-delete", "deferred-stop"]), 300_000);
