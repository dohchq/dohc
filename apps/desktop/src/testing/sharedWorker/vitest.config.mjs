// Runs the test files DOHC_SHARED_WORKER_FILES lists, in that order, in one
// worker of the desktop-shared-dom project.
import { fileURLToPath } from "node:url";
import { BaseSequencer } from "vitest/node";
import base from "../../../vitest.config.ts";

const files = JSON.parse(process.env.DOHC_SHARED_WORKER_FILES ?? "[]");
const root = fileURLToPath(new URL("../../../", import.meta.url));
const position = (moduleId) => files.findIndex((file) => moduleId.replaceAll("\\", "/").endsWith(file));

class InListedOrder extends BaseSequencer {
  async sort(specifications) {
    return [...specifications].sort((a, b) => position(a.moduleId) - position(b.moduleId));
  }
}

const project = base.test.projects.find((candidate) => candidate.test.name === "desktop-shared-dom");
export default {
  ...project,
  root,
  test: { ...project.test, include: files, maxWorkers: 1, fileParallelism: false, sequence: { sequencer: InListedOrder } },
};
