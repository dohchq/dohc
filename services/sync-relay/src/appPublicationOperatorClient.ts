import { createConnection } from "node:net";
import { OPERATOR_MAX_RESPONSE_BYTES, OPERATOR_TIMEOUT_MS, type DisablePublicationRequest, type OperatorResponse } from "./appPublicationOperatorProtocol";

export function requestPublicationTakedown(path: string, request: DisablePublicationRequest, timeoutMs = OPERATOR_TIMEOUT_MS): Promise<OperatorResponse> {
  return new Promise((resolve, reject) => {
    const socket = createConnection(path);
    const deadline = setTimeout(() => socket.destroy(new Error("Publication takedown timed out. Check the relay before retrying.")), timeoutMs);
    socket.once("close", () => clearTimeout(deadline));
    socket.once("error", reject);
    socket.once("connect", () => socket.write(JSON.stringify(request) + "\n"));
    let bytes = Buffer.alloc(0);
    socket.on("data", chunk => {
      if (bytes.length + chunk.length > OPERATOR_MAX_RESPONSE_BYTES) {socket.destroy(new Error("Invalid operator response.")); return;}
      bytes = Buffer.concat([bytes, chunk]);
    });
    socket.once("end", () => {
      try {
        const value: unknown = JSON.parse(bytes.toString("utf8"));
        if (!value || typeof value !== "object") throw new Error("Invalid operator response.");
        const row = value as Record<string, unknown>;
        if (![0, 1, 2, 3].includes(Number(row.code)) || typeof row.code !== "number" || typeof row.message !== "string") throw new Error("Invalid operator response.");
        resolve(value as OperatorResponse);
      } catch (error) {reject(error);}
    });
  });
}
