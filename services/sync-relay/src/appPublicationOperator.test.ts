import { createConnection, createServer, type Socket } from "node:net";
import { once } from "node:events";
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { startPublicationOperator } from "./appPublicationOperator";
import { operatorSocketPath } from "./appPublicationOperatorProtocol";
import { requestPublicationTakedown } from "./appPublicationOperatorClient";
import { notFound } from "./errors";

let root: string;
const cleanups: (() => Promise<void>)[] = [];
beforeEach(async () => {
  const scratch = fileURLToPath(new URL("../.output", import.meta.url));
  await mkdir(scratch, {recursive: true});
  root = await mkdtemp(join(scratch, "operator-socket-"));
});
afterEach(async () => {
  for (const close of cleanups.splice(0).reverse()) await close();
  await rm(root, {recursive: true, force: true});
});
function exchange(path: string, value: unknown) {
  return new Promise<Record<string, unknown>>((resolve, reject) => {
    const socket = createConnection(path);
    socket.once("error", reject);
    socket.once("connect", () => socket.write(JSON.stringify(value) + "\n"));
    let result = "";
    socket.on("data", bytes => {result += String(bytes);});
    socket.once("end", () => {try {resolve(JSON.parse(result));} catch (error) {reject(error);}});
  });
}

it("accepts only one disable request shape and keeps a not-found failure local to that request", async () => {
  const disableAppPublication = vi.fn(() => {throw notFound();});
  const path = operatorSocketPath({SYNC_RELAY_DB_PATH: join(root, "relay.sqlite")});
  const operator = await startPublicationOperator({disableAppPublication}, path);
  cleanups.push(() => operator.close());
  expect(operator.address()).toBe(path);
  const valid = {type: "disable-publication" as const, publicationId: "a".repeat(64), reason: "Malware"};
  for (const invalid of [{...valid, type: "reactivate"}, {...valid, ownerUserId: "owner"}, {...valid, reason: " "}, [valid, valid], {...valid, publicationId: "bad"}]) {
    expect(await exchange(path, invalid)).toMatchObject({code: 2, message: expect.stringContaining("Invalid takedown request")});
  }
  expect(disableAppPublication).not.toHaveBeenCalled();
  expect(await requestPublicationTakedown(path, valid)).toMatchObject({code: 3, message: expect.stringContaining("was not found")});
  expect(disableAppPublication).toHaveBeenCalledOnce();
  await operator.close();
  const restarted = await startPublicationOperator({disableAppPublication}, path);
  cleanups.push(() => restarted.close());
  expect(restarted.address()).toBe(path);
});

it("times out a client whose connected relay never responds", async () => {
  const path = process.platform === "win32" ? operatorSocketPath({SYNC_RELAY_DB_PATH: join(root, "timeout.sqlite")}) : join(root, "timeout.sock");
  const sockets = new Set<Socket>();
  const server = createServer({allowHalfOpen: true}, socket => {sockets.add(socket); socket.on("data", () => {});});
  server.listen(path);
  await once(server, "listening");
  cleanups.push(async () => {for (const socket of sockets) socket.destroy(); await new Promise<void>(resolve => server.close(() => resolve()));});
  await expect(requestPublicationTakedown(path, {type: "disable-publication", publicationId: "a".repeat(64), reason: "Malware"}, 50)).rejects.toThrow("Publication takedown timed out");
});
