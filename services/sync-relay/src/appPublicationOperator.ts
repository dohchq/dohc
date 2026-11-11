import { chmod, lstat, mkdir, open, rmdir, unlink } from "node:fs/promises";
import { createConnection, createServer, type Socket } from "node:net";
import { dirname } from "node:path";
import { constants } from "node:fs";
import { randomBytes, timingSafeEqual } from "node:crypto";
import { RelayError } from "./errors";
import type { SyncRelayStorage } from "./storage";
import { OPERATOR_MAX_REQUEST_BYTES, OPERATOR_TIMEOUT_MS, parseOperatorRequest, type OperatorResponse } from "./appPublicationOperatorProtocol";

function copiesMessage({publicationIds, total}: {publicationIds: string[]; total: number}): string {
  if (total === 0) return "\nThe owner has no other active publication of this app.";
  const more = total > publicationIds.length ? `\nThese are the first ${publicationIds.length}. Run this takedown again after disabling them to list the rest.` : "";
  return `\nThe owner has ${total} other active ${total === 1 ? "publication" : "publications"} of this app. They keep serving until you disable each one:\n${publicationIds.join("\n")}${more}`;
}

export async function startPublicationOperator(storage: Pick<SyncRelayStorage, "disableAppPublication" | "liftAppPublishingHold">, path: string, secretPath: string) {
  const uid = typeof process.getuid === "function" ? process.getuid() : undefined;
  const unix = uid !== undefined, directory = dirname(path);
  if (unix) {
    await mkdir(directory, {mode: 0o700}).catch(error => {if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;});
    const info = await lstat(directory);
    if (!info.isDirectory() || info.isSymbolicLink() || info.uid !== uid || (info.mode & 0o777) !== 0o700) throw new Error("The operator socket directory must belong to the relay user with mode 0700.");
    const existing = await lstat(path).catch(error => {if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined; throw error;});
    if (existing) {
      if (!existing.isSocket() || existing.uid !== uid || (existing.mode & 0o777) !== 0o600) throw new Error("Refusing an unowned operator socket.");
      await new Promise<void>((resolve, reject) => {
        const probe = createConnection(path);
        const deadline = setTimeout(() => {probe.destroy(); reject(new Error("Operator socket probe timed out."));}, OPERATOR_TIMEOUT_MS);
        probe.once("connect", () => {clearTimeout(deadline); probe.destroy(); reject(new Error("Another relay owns the operator socket."));});
        probe.once("error", error => {clearTimeout(deadline); if ((error as NodeJS.ErrnoException).code === "ECONNREFUSED") resolve(); else reject(error);});
      });
      await unlink(path);
    }
  }
  await mkdir(dirname(secretPath), {recursive: true, mode: 0o700});
  const file = await open(secretPath, constants.O_RDWR | constants.O_CREAT | constants.O_NOFOLLOW, 0o600);
  let secret: string;
  try {
    const info = await file.stat();
    if (!info.isFile() || (unix && (info.uid !== uid || (info.mode & 0o777) !== 0o600))) throw new Error("Operator secret must belong to the relay user with mode 0600.");
    secret = await file.readFile("utf8");
    if (!secret) {secret = randomBytes(32).toString("hex"); await file.writeFile(secret);}
    if (!/^[a-f0-9]{64}$/.test(secret)) throw new Error("Invalid operator secret file.");
  } finally {await file.close();}
  const connections = new Set<Socket>();
  const server = createServer({allowHalfOpen: true}, socket => {
    connections.add(socket);
    socket.once("close", () => connections.delete(socket));
    socket.on("error", () => socket.destroy());
    const deadline = setTimeout(() => socket.destroy(), OPERATOR_TIMEOUT_MS);
    socket.once("close", () => clearTimeout(deadline));
    let bytes = Buffer.alloc(0);
    const reply = (result: OperatorResponse) => socket.end(JSON.stringify(result));
    let received = false;
    socket.on("data", chunk => {
      if (received) return;
      if (bytes.length + chunk.length > OPERATOR_MAX_REQUEST_BYTES) {received = true; reply({code: 2, message: "Takedown request is too large."}); return;}
      bytes = Buffer.concat([bytes, chunk]);
      const boundary = bytes.indexOf(10);
      if (boundary === -1) return;
      received = true;
      if (boundary !== bytes.length - 1) {reply({code: 2, message: "Send exactly one takedown request."}); return;}
      let request;
      try {
        const {secret: credential, ...value} = JSON.parse(bytes.toString("utf8"));
        const offered = Buffer.from(typeof credential === "string" ? credential : "");
        if (offered.length !== secret.length || !timingSafeEqual(offered, Buffer.from(secret))) {
          reply({code: 1, message: "Operator authentication failed. Run takedown with access to the relay continuity volume."}); return;
        }
        request = parseOperatorRequest(value);
      }
      catch {reply({code: 2, message: "Invalid takedown request. Supply a publication ID, and for a takedown a reason of 1 to 1024 characters."}); return;}
      try {
        if (request.type === "lift-publishing-hold") {
          const {publicationId} = request;
          if (storage.liftAppPublishingHold(publicationId)) reply({code: 0, message: `Lifted the app publishing hold from the owner of publication ${publicationId}. The publication stays disabled.`, publicationId});
          else reply({code: 3, message: `No app publishing hold matches publication ${publicationId}. Check the publication ID.`});
          return;
        }
        const result = storage.disableAppPublication({...request, nowMs: Date.now()});
        reply({code: 0, message: `Disabled publication ${result.publicationId}. Its owner cannot publish apps on this server until you lift the hold.${copiesMessage(result.otherActiveCopies)}`,
          publicationId: result.publicationId, authorityRevision: result.authorityRevision, operatorTakedown: result.operatorTakedown, otherActiveCopies: result.otherActiveCopies});
      } catch (error) {
        if (error instanceof RelayError && error.code === "not_found") reply({code: 3, message: `Publication ${request.publicationId} was not found. Check the publication ID.`});
        else if (error instanceof RelayError && error.code === "bad_request") reply({code: 2, message: error.message});
        else {console.error("[sync-relay] publication takedown failed", error); reply({code: 1, message: "Publication takedown failed. Check the relay logs before retrying."});}
      }
    });
    socket.once("end", () => {if (!received) reply({code: 2, message: "Incomplete takedown request."});});
  });
  server.maxConnections = 16;
  try {
    await new Promise<void>((resolve, reject) => {server.once("error", reject); server.listen(path, () => {server.off("error", reject); resolve();});});
    if (unix) await chmod(path, 0o600);
  } catch (error) {
    await new Promise<void>(resolve => server.close(() => resolve()));
    if (unix) await rmdir(directory);
    throw error;
  }
  let closing: Promise<void> | undefined;
  return {
    address: () => server.address(),
    close() {
      return closing ??= (async () => {
        for (const socket of connections) socket.destroy();
        await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
        if (unix) await rmdir(directory);
      })();
    },
  };
}
