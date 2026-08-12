import assert from "node:assert/strict";
import test from "node:test";
import { desktopDevEnvironment } from "./dev.mjs";

test("desktop dev launches Electron outside Node mode", () => {
  const source = {
    ELECTRON_RUN_AS_NODE: "1",
    electron_run_as_node: "1",
    KEEP_ME: "yes",
  };

  const environment = desktopDevEnvironment(source);

  assert.deepEqual(environment, { KEEP_ME: "yes" });
  assert.equal(source.ELECTRON_RUN_AS_NODE, "1");
});
