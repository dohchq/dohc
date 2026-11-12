import { it } from "vitest";

import { engine, runDeleteRepros } from "./twoDaemonSync.fixture";

// Each file-manager case runs alone: its console spies wrap whatever console it finds.
it.skipIf(engine.missing).each(["file-manager-stop", "file-manager-capture-stop-early", "file-manager-capture-stop"] as const)(
  "says Stop live editing stopped for an owner-bound live page deleted outside dohc (#3129, %s)", kind => runDeleteRepros([kind]), 300_000);
