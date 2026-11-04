import assert from "node:assert/strict";
import {once} from "node:events";
import {createServer} from "node:http";
import {WebSocket, WebSocketServer} from "ws";
import {parseDeviceLiveHostCredit} from "@dohc/live-session-contract/device-control";
import {EngineClient} from "@dohc/workspace-engine-client/daemon";
import {DeviceEngineConnection} from "./deviceEngineConnection";
import {startExistingOwnerDeviceTransport, type ExistingOwnerSession} from "./deviceExistingOwnerTransport";
import type {LiveObjectBinding} from "@dohc/live-session-contract/live-object-binding";

// Both ends use the production device transport. The fixture's document session
// supplies the renderer callbacks; all adoption and application writes reach the daemon.
export async function ownerBridge(native: EngineClient, workspace: string,
  relayNamespace: string, host: {hostId: string; hostEpoch: number; instanceId: string; connectionId: string},
  ownerFor: (binding: LiveObjectBinding) => Promise<ExistingOwnerSession>) {
  const server = createServer(), sockets = new WebSocketServer({server});
  server.listen(0, "127.0.0.1"); await once(server, "listening");
  const address = server.address(); assert(address && typeof address !== "string");
  const connected = once(sockets, "connection");
  const desktop = new WebSocket(`ws://127.0.0.1:${address.port}`);
  const opened = once(desktop, "open");
  const [relay] = await connected as [WebSocket]; await opened;
  const limits = {maxConnections: 2, maxHeaderBytes: 8192, maxCredentialBytes: 4096, maxFragments: 1024, maxBufferedChunks: 1024,
    handshakeTimeoutMs: 120_000, heartbeatIntervalMs: 30_000, heartbeatTimeoutMs: 30_000, maxPayloadBytes: 1024 * 1024, maxPendingBytes: 64 * 1024 * 1024, closeTimeoutMs: 1000};
  const authToken = "replica-journal-owner-bridge";
  let connection: DeviceEngineConnection;
  let transported!: () => void;
  const transportReady = new Promise<void>(resolve => {transported = resolve;});
  let received = 0;
  relay.on("message", (bytes, binary) => {
    const buffer = Buffer.from(bytes as Buffer);
    if (binary) {
      connection.receive(buffer); received += buffer.length + 16; connection.acknowledge(received);
    } else {
      const message = JSON.parse(buffer.toString());
      if (message.type === "liveHost.transport") {
        connection = new DeviceEngineConnection(relay, limits, message.receive, limits.maxPendingBytes, () => relay.close());
        transported();
      } else connection.credit(parseDeviceLiveHostCredit(message));
    }
  });
  const transport = startExistingOwnerDeviceTransport({ws: desktop, limits, stop: () => {desktop.close();},
    start: {type: "liveHost.start", version: 1, relayNamespace, host: host as never, authToken,
      receive: {maxPayloadBytes: limits.maxPayloadBytes, maxPendingBytes: limits.maxPendingBytes}},
    config: {client: native, workspaces: [{workspaceId: "workspace", workspaceHandle: workspace}], ownerFor,
      maxQueuedBytes: limits.maxPendingBytes, maxFrameBytes: 4 * 1024 * 1024, maxUploads: 2, maxRegistrations: 16,
      aggregateBytes: 512 * 1024 * 1024, maxAdoptionBytes: 4 * 1024 * 1024, maxAdoptionEvents: 64,
      maxRestoreBytes: 4 * 1024 * 1024, requestDeadlineMs: 120_000,
      sync: {maxClientVectorBytes: 128 * 1024, maxOutputBytes: 4 * 1024 * 1024}}});
  desktop.on("message", (bytes, binary) => {
    const buffer = Buffer.from(bytes as Buffer);
    if (binary) transport.receive(buffer);
    else transport.credit(parseDeviceLiveHostCredit(JSON.parse(buffer.toString())));
  });
  await transportReady;
  const client = new EngineClient(connection!, {authToken, protocolVersion: 2, capabilities: ["blobs"], maxFrameBytes: 4 * 1024 * 1024,
    privateLiveApplication: {aggregateBytes: 512 * 1024 * 1024, maxUploads: 2}, connectTimeoutMs: 120_000});
  await client.ready();
  return {client, async close() {
    client.close(); await transport.close(); desktop.terminate(); relay.terminate();
    await new Promise<void>(resolve => sockets.close(() => resolve()));
    await new Promise<void>(resolve => server.close(() => resolve()));
  }};
}
