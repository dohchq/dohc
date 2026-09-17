import { parentPort } from "node:worker_threads";
import { createLiveMarkdownJournalValidator, type OrderedLiveUpdateCutPolicy } from "@dohc/ydoc-projection/live-journal-validation";
if (!parentPort) throw new Error("Live validation requires a worker.");
parentPort.on("message", ({ policy, input }: { policy: OrderedLiveUpdateCutPolicy; input: unknown }) => {
  parentPort!.postMessage(createLiveMarkdownJournalValidator(policy)(input));
});
