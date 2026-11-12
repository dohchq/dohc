import { it } from "vitest";
import { engine, runRenameRepros } from "./twoDaemonSync.fixture";

it.skipIf(engine.missing)("refuses renaming an owner-bound live page, keeps its workspace publishing, and renames it after Stop (bound, unbound)",
  () => runRenameRepros(["bound", "unbound"]), 300_000);

it.skipIf(engine.missing)("renaming or deleting a captured owner-bound live page in the file manager keeps its workspace publishing",
  () => runRenameRepros(["capture-rename", "capture-delete"]), 300_000);
