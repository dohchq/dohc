import { createConnection, createServer, type Socket } from "node:net";
import { once } from "node:events";
import { mkdir, mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { startPublicationOperator } from "./appPublicationOperator";
import { operatorSecretPath, operatorSocketPath } from "./appPublicationOperatorProtocol";
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
const unusedLift = vi.fn((): boolean => {throw new Error("Unexpected hold lift");});
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
  const operator = await startPublicationOperator({disableAppPublication, liftAppPublishingHold: unusedLift}, path, join(root, "continuity", "operator.secret"));
  cleanups.push(() => operator.close());
  expect(operator.address()).toBe(path);
  const secret = await readFile(join(root, "continuity", "operator.secret"), "utf8");
  if (process.platform !== "win32") expect((await stat(join(root, "continuity", "operator.secret"))).mode & 0o777).toBe(0o600);
  const valid = {type: "disable-publication" as const, publicationId: "a".repeat(64), reason: "Malware"};
  for (const invalid of [{...valid, type: "reactivate"}, {...valid, ownerUserId: "owner"}, {...valid, reason: " "}, [valid, valid], {...valid, publicationId: "bad"}]) {
    expect(await exchange(path, {...invalid, secret})).toMatchObject({code: 2, message: expect.stringContaining("Invalid takedown request")});
  }
  for (const credential of [undefined, "incorrect", "a".repeat(64)]) {
    expect(await exchange(path, {...valid, secret: credential})).toMatchObject({code: 1, message: expect.stringContaining("authentication failed")});
  }
  expect(disableAppPublication).not.toHaveBeenCalled();
  expect(await requestPublicationTakedown(path, valid, secret)).toMatchObject({code: 3, message: expect.stringContaining("was not found")});
  expect(disableAppPublication).toHaveBeenCalledOnce();
  await operator.close();
  const restarted = await startPublicationOperator({disableAppPublication, liftAppPublishingHold: unusedLift}, path, join(root, "continuity", "operator.secret"));
  cleanups.push(() => restarted.close());
  expect(restarted.address()).toBe(path);
});

it("lifts a publishing hold through one exact request shape", async () => {
  const disableAppPublication = vi.fn(() => {throw notFound();});
  const liftAppPublishingHold = vi.fn((publicationId: string) => publicationId === "a".repeat(64));
  const path = operatorSocketPath({SYNC_RELAY_DB_PATH: join(root, "lift.sqlite")});
  const operator = await startPublicationOperator({disableAppPublication, liftAppPublishingHold}, path, join(root, "lift", "operator.secret"));
  cleanups.push(() => operator.close());
  const secret = await readFile(join(root, "lift", "operator.secret"), "utf8");
  const lift = {type: "lift-publishing-hold" as const, publicationId: "a".repeat(64)};
  for (const invalid of [{...lift, reason: "Malware"}, {...lift, publicationId: "bad"}, {type: "lift-publishing-hold"}]) {
    expect(await exchange(path, {...invalid, secret})).toMatchObject({code: 2});
  }
  expect(await exchange(path, lift)).toMatchObject({code: 1});
  expect(liftAppPublishingHold).not.toHaveBeenCalled();
  expect(await requestPublicationTakedown(path, lift, secret)).toMatchObject({code: 0, publicationId: lift.publicationId, message: expect.stringContaining("The publication stays disabled.")});
  expect(await requestPublicationTakedown(path, {...lift, publicationId: "b".repeat(64)}, secret)).toMatchObject({code: 3, message: expect.stringContaining("No app publishing hold matches")});
  expect(disableAppPublication).not.toHaveBeenCalled();
});

it("times out a client whose connected relay never responds", async () => {
  const path = process.platform === "win32" ? operatorSocketPath({SYNC_RELAY_DB_PATH: join(root, "timeout.sqlite")}) : join(root, "timeout.sock");
  const sockets = new Set<Socket>();
  const server = createServer({allowHalfOpen: true}, socket => {sockets.add(socket); socket.on("data", () => {});});
  server.listen(path);
  await once(server, "listening");
  cleanups.push(async () => {for (const socket of sockets) socket.destroy(); await new Promise<void>(resolve => server.close(() => resolve()));});
  await expect(requestPublicationTakedown(path, {type: "disable-publication", publicationId: "a".repeat(64), reason: "Malware"}, "secret", 50)).rejects.toThrow("Publication takedown timed out");
});

it("rejects a bare disable-publication request before storage", async () => {
  const secretPath = join(root, "operator.secret"); await writeFile(secretPath, "a".repeat(64), {mode: 0o600});
  const disableAppPublication = vi.fn(() => {throw notFound();});
  const path = operatorSocketPath({SYNC_RELAY_DB_PATH: join(root, "auth.sqlite")});
  const operator = await startPublicationOperator({disableAppPublication, liftAppPublishingHold: unusedLift}, path, secretPath); cleanups.push(() => operator.close());
  expect(await exchange(path, {type: "disable-publication", publicationId: "a".repeat(64), reason: "Malware"})).toMatchObject({code: 1});
  expect(disableAppPublication).not.toHaveBeenCalled();
});

it("keeps a development relay's operator secret in its database's folder", () => {
  const database = join(root, "relay.sqlite");
  expect(dirname(operatorSecretPath({SYNC_RELAY_DB_PATH: database}))).toBe(root);
  expect(operatorSecretPath({SYNC_RELAY_DB_PATH: database})).not.toBe(operatorSecretPath({SYNC_RELAY_DB_PATH: join(root, "other.sqlite")}));
  expect(operatorSecretPath({DOHC_RELAY_DEPLOYMENT_CONFIG: join(root, "continuity", "deployment.json")}))
    .toBe(join(root, "continuity", "publication-operator.secret"));
});
