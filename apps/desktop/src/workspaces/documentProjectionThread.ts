import { parentPort } from "node:worker_threads";
import { runDocumentProjection, transferList, type DocumentProjectionRequest } from "./documentProjection";

const port = parentPort;
if (!port) {
  throw new Error("The document projection thread requires a worker parent port.");
}

port.on("message", ({ id, request }: { id: number; request: DocumentProjectionRequest }) => {
  try {
    const result = runDocumentProjection(request);
    port.postMessage({ id, ok: true, result }, transferList(result));
  } catch (error) {
    port.postMessage({
      id,
      ok: false,
      message: error instanceof Error ? error.message : String(error),
    });
  }
});
