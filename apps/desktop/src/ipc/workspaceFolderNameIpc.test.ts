import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { workspaceFolderNameOperations } from "./bridgeContract";
import { registerWorkspaceFolderNameIpc } from "./workspaceFolderNameIpc";

let location: string;
let handle!: (trusted: boolean, payload: unknown) => Promise<unknown>;
const usableRoot = vi.fn((path: string) => path);

beforeEach(async () => {
  location = await mkdtemp(join(tmpdir(), "dohc-folder-name-"));
  usableRoot.mockClear();
  registerWorkspaceFolderNameIpc<boolean, never>({
    handle(channel, handler) {
      expect(channel).toBe(workspaceFolderNameOperations.suggestWorkspaceFolderName.channel);
      handle = handler;
    },
    assertTrustedSender(trusted) { if (!trusted) throw new Error("Untrusted sender"); },
    withActiveWorkspace: vi.fn(() => { throw new Error("Device operation must not enter a workspace"); }),
  }, usableRoot);
});

afterEach(async () => {
  await rm(location, { recursive: true, force: true });
});

it("checks the sender and the name before it looks at the location", async () => {
  await expect(handle(false, { rootPath: location, name: "Personal" })).rejects.toThrow("Untrusted sender");
  for (const name of ["", ".", "..", "a/b", "a\\b"]) {
    await expect(handle(true, { rootPath: location, name })).rejects.toThrow();
  }
  expect(usableRoot).not.toHaveBeenCalled();
});

it("suggests the name, then the first numbered name nothing in the location has", async () => {
  await expect(handle(true, { rootPath: location, name: "Personal" })).resolves.toBe("Personal");
  await mkdir(join(location, "Personal"));
  await writeFile(join(location, "Personal 2"), "a file takes the name too");
  await expect(handle(true, { rootPath: location, name: "Personal" })).resolves.toBe("Personal 3");
  expect(usableRoot.mock.calls.map(([path]) => path)).toContain(`${location}/Personal 2`);
});

it("suggests the name for a location that does not exist yet", async () => {
  await expect(handle(true, { rootPath: join(location, "dohc"), name: "Personal" })).resolves.toBe("Personal");
});

it("refuses a location dohc never offered", async () => {
  usableRoot.mockImplementationOnce(() => { throw new Error("Workspace root must be chosen through dohc."); });
  await expect(handle(true, { rootPath: location, name: "Personal" })).rejects.toThrow("chosen through dohc");
});
