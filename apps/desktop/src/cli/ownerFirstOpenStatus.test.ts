import {expect, it, vi} from "vitest";
import {createOwnerFirstOpenStatusReader} from "./ownerFirstOpenStatus";
import type {OwnerLiveDocumentActionDependencies} from "../ipc/relaySharesIpc";

const source = {workspaceId: "w", objectId: "o", path: "a.md", sourceMomentId: "m", sourceDigest: "a".repeat(64)};
const firstOpen = {source, reason: "retry-stopped", code: "build-deadline", deadlineAnswers: 3, recovery: "retry-later"};
function fixture() {
  let generation = 1, active = true;
  const workspace: {workspaceId: string; shareView?: unknown} = {workspaceId: "w"};
  const operation = {workspace, assertCurrent() {if (!active) throw new Error("departed");}};
  let reply: unknown = {ok: true, documents: [{path: "a.md", objectId: "o", status: "unavailable", reason: "live-first-open-retry-stopped", firstOpen,
    document: {binding: "private"}, bearerToken: "private"}]};
  const remote = vi.fn(async () => ({credentials: {serverUrl: "https://relay.test", email: "a@b.test", userId: "owner", token: "owner-token"}, credentialGeneration: generation}));
  const read = vi.fn<(credentials: unknown, path: string) => Promise<unknown>>(async () => reply);
  const list = createOwnerFirstOpenStatusReader({remoteForWorkspace: remote, currentCredentialGeneration: () => generation,
    relayShareJsonWithCredentials: read as OwnerLiveDocumentActionDependencies<typeof workspace>["relayShareJsonWithCredentials"]});
  return {list: () => list(operation), read, remote, workspace, rotate() {generation++;}, depart() {active = false;}, reply(value: unknown) {reply = value;}};
}

it("returns structured feedback under owner credentials, removing bindings and credentials", async () => {
  const f = fixture();
  expect(await f.list()).toEqual([{path: "a.md", objectId: "o", status: "unavailable", reason: "live-first-open-retry-stopped", firstOpen}]);
  expect(f.read.mock.calls[0]).toMatchObject([{token: "owner-token"}, "/sync/w/live-host"]);
  f.workspace.shareView = {};
  await expect(f.list()).rejects.toThrow("original workspace");
  expect(f.remote).toHaveBeenCalledTimes(1);
});

it.each(["credentials", "attachment"])("discards a status reply when its %s changed", async kind => {
  const f = fixture();
  f.read.mockImplementation(async () => {if (kind === "credentials") f.rotate(); else f.depart(); return {ok: true, documents: []};});
  await expect(f.list()).rejects.toThrow();
});

it("rejects source feedback for another workspace, object or path", async () => {
  for (const changed of [{workspaceId: "other"}, {objectId: "other"}, {path: "other.md"}]) {
    const f = fixture();
    f.reply({ok: true, documents: [{path: "a.md", objectId: "o", status: "unavailable", firstOpen: {...firstOpen, source: {...source, ...changed}}}]});
    await expect(f.list()).rejects.toThrow();
  }
});


it("drops a malformed row while returning the good rows", async () => {
  const f = fixture();
  const good = {path: "a.md", objectId: "o", status: "unavailable", reason: "live-first-open-retry-stopped", firstOpen};
  const longPath = "a".repeat(1_025);
  f.reply({ok: true, documents: [good, {...good, path: longPath, firstOpen: {...firstOpen, source: {...source, path: longPath}}},
    {path: "b.md", objectId: "b", status: "ready"}]});
  expect(await f.list()).toEqual([good, {path: "b.md", objectId: "b", status: "ready"}]);
});
