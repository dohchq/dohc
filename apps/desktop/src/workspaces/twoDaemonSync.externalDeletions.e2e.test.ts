import { it } from "vitest";

import { engine, runDeleteRepros } from "./twoDaemonSync.fixture";

it.skipIf(engine.missing)("leaves an owner-bound live page deleted outside dohc to its delivered head, with no refusal (file-manager)",
  () => runDeleteRepros(["file-manager"]), 300_000);

it.skipIf(engine.missing)("records an owner-bound live page that capture wrote and that is deleted outside dohc, with no refusal (file-manager-capture)",
  () => runDeleteRepros(["file-manager-capture"]), 300_000);

it.skipIf(engine.missing)("refuses restoring an owner-bound live page deleted outside dohc (file-manager-restore)",
  () => runDeleteRepros(["file-manager-restore"]), 300_000);
