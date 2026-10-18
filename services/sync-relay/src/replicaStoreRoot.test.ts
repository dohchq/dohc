import {afterEach, expect, it, vi} from "vitest";
import {join} from "node:path";
import {createReplicaSupervisor} from "./replicaSupervisor";
import {closeTestStorages, tempRoot, testStorage} from "./testing";

const state = vi.hoisted(() => ({symlink: false, uid: 42, mode: 0o40700, real: ""}));
vi.mock("node:fs/promises", async original => ({
  ...await original<typeof import("node:fs/promises")>(),
  realpath: async (path: string) => state.real || path,
  lstat: vi.fn(async () => ({isSymbolicLink: () => state.symlink, isDirectory: () => true, uid: state.uid, mode: state.mode})),
}));
afterEach(async () => {
  state.symlink = false; state.uid = 42; state.mode = 0o40700; state.real = "";
  vi.unstubAllGlobals(); await closeTestStorages();
});
async function supervisor(platform = "linux", root?: string) {
  vi.stubGlobal("process", {...process, platform, getuid: () => 42});
  return createReplicaSupervisor({storage: await testStorage(), storeRoot: root ?? await tempRoot("root-guard"),
    startChild: async () => {throw Error("must not start");}});
}
it.each([
  ["symlink", () => {state.symlink = true;}, /symlink/],
  ["ownership", () => {state.uid = 43;}, /owned/],
  ["group write", () => {state.mode = 0o40720;}, /writable/],
  ["other write", () => {state.mode = 0o40702;}, /writable/],
] as const)("refuses store root %s before use", async (_, change, message) => {
  change(); const instance = await supervisor();
  await expect(instance.settled("w")).rejects.toThrow(message);
});
it.each(["linux", "darwin"])("refuses an overlong %s socket path", async platform => {
  const root = join(await tempRoot("long-root"), "a".repeat(110));
  const instance = await supervisor(platform, root);
  await expect(instance.settled("w")).rejects.toThrow(/socket path.*bytes/);
});
it("keeps Windows root behavior", async () => {
  state.symlink = true; state.uid = 43; state.mode = 0o40777;
  await (await supervisor("win32")).close();
});
it("measures the canonical socket path after creating the root", async () => {
  state.real = "/private/" + "x".repeat(90);
  const instance = await supervisor("darwin");
  await expect(instance.settled("w")).rejects.toThrow(/socket path.*bytes/);
});
