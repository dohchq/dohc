import { spawnSync } from "node:child_process";
import { chmod, mkdir, mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  KernelClientError,
  KernelTimeoutError,
  KernelUnavailableError,
  WorkspaceKernelClient,
  defaultWorkspaceKernelDebugBinaryPath,
  defaultWorkspaceKernelPackagedBinaryPath,
  repoRootFromPackage,
  workspaceKernelBinaryName,
  type KernelManifestEntry,
} from ".";

interface FixtureFile {
  path: string;
  text: string;
}

interface FixtureSymlink {
  path: string;
  target: string;
}

interface ContractFixture {
  workspace: {
    files: FixtureFile[];
    symlinks?: FixtureSymlink[];
  };
  request?: {
    paths?: string[];
    manifest?: KernelManifestEntry[];
  };
  expected: Record<string, unknown>;
}

const repoRoot = repoRootFromPackage();
const manifestPath = join(repoRoot, "crates/workspace-kernel/Cargo.toml");
const binaryPath = defaultWorkspaceKernelDebugBinaryPath(repoRoot);
const fixtureDir = join(repoRoot, "fixtures/workspace-kernel");
const roots: string[] = [];

beforeAll(() => {
  const result = spawnSync(
    "cargo",
    ["build", "--offline", "--manifest-path", manifestPath],
    {
      cwd: repoRoot,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
    },
  );
  if (result.status !== 0) {
    throw new Error(`cargo build failed\n${result.stdout}\n${result.stderr}`);
  }
});

afterAll(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

describe("WorkspaceKernelClient", () => {
  it("resolves the packaged resources binary without depending on Electron imports", () => {
    expect(
      defaultWorkspaceKernelPackagedBinaryPath({
        isPackaged: true,
        resourcesPath: "/Applications/dohc.app/Contents/Resources",
        platform: "darwin",
      }),
    ).toBe("/Applications/dohc.app/Contents/Resources/workspace-kernel/dohc-workspace-kernel");
    expect(
      defaultWorkspaceKernelPackagedBinaryPath({
        isPackaged: true,
        resourcesPath: "C:\\dohc\\resources",
        platform: "win32",
      }),
    ).toBe("C:\\dohc\\resources\\workspace-kernel\\dohc-workspace-kernel.exe");
    expect(
      defaultWorkspaceKernelPackagedBinaryPath({ isPackaged: false, resourcesPath: "/tmp" }),
    ).toBeNull();
    expect(workspaceKernelBinaryName("win32")).toBe("dohc-workspace-kernel.exe");
  });

  it("handshakes with the kernel over newline-delimited JSON-RPC", async () => {
    const client = new WorkspaceKernelClient({ binaryPath, timeoutMs: 5000 });
    try {
      await expect(client.handshake()).resolves.toMatchObject({
        protocolVersion: 1,
        capabilities: expect.arrayContaining(["kernel.scan", "kernel.reconcile"]),
      });
    } finally {
      await client.dispose();
    }
  });

  it("matches the shared scan contract fixture", async () => {
    const fixture = await readFixture("scan.json");
    const root = await writeFixtureWorkspace(fixture);
    const client = new WorkspaceKernelClient({ binaryPath, timeoutMs: 5000 });
    try {
      const result = await client.scan(root);
      expect(result.files).toEqual(fixture.expected.files);
    } finally {
      await client.dispose();
    }
  });

  it("matches the shared hashChanged contract fixture", async () => {
    const fixture = await readFixture("hashChanged.json");
    const root = await writeFixtureWorkspace(fixture);
    const paths = fixture.request?.paths ?? [];
    const client = new WorkspaceKernelClient({ binaryPath, timeoutMs: 5000 });
    try {
      const result = await client.hashChanged(root, paths);
      expect(result.files).toEqual(fixture.expected.files);
    } finally {
      await client.dispose();
    }
  });

  it("matches the shared reconcile contract fixture", async () => {
    const fixture = await readFixture("reconcile.json");
    const root = await writeFixtureWorkspace(fixture);
    const manifest = fixture.request?.manifest ?? [];
    const client = new WorkspaceKernelClient({ binaryPath, timeoutMs: 5000 });
    try {
      const result = await client.reconcile(root, manifest);
      expect(result).toEqual(fixture.expected);
    } finally {
      await client.dispose();
    }
  });

  it("surfaces a typed unavailable error when the binary cannot spawn", async () => {
    const client = new WorkspaceKernelClient({
      binaryPath: join(repoRoot, "crates/workspace-kernel/target/debug/missing-kernel"),
      timeoutMs: 100,
      maxRestarts: 0,
    });
    await expect(client.handshake()).rejects.toBeInstanceOf(KernelUnavailableError);
    await client.dispose();
  });

  it("restarts after a kernel crash and enforces the restart limit", async () => {
    const crashOnSecondRequest = await writeFakeKernel(
      `
requests=0
while IFS= read -r line; do
  requests=$((requests + 1))
  if [ "$requests" -eq 2 ]; then
    exit 1
  fi
  id=$(printf '%s' "$line" | sed -n 's/.*"id":\\([0-9][0-9]*\\).*/\\1/p')
  printf '{"jsonrpc":"2.0","id":%s,"result":{"protocolVersion":1,"capabilities":["kernel.handshake"]},"timingMs":{"total":0.1}}\\n' "$id"
done
`,
      `
import { createInterface } from "node:readline";
let requests = 0;
const rl = createInterface({ input: process.stdin });
rl.on("line", (line) => {
  requests += 1;
  if (requests === 2) process.exit(1);
  const id = /"id":([0-9]+)/.exec(line)?.[1] ?? "0";
  process.stdout.write(
    \`{"jsonrpc":"2.0","id":\${id},"result":{"protocolVersion":1,"capabilities":["kernel.handshake"]},"timingMs":{"total":0.1}}\\n\`,
  );
});
`,
    );
    let exitCount = 0;
    const waiters: Array<() => void> = [];
    const waitForExitCount = (count: number) =>
      new Promise<void>((resolve, reject) => {
        if (exitCount >= count) {
          resolve();
          return;
        }
        const timeout = setTimeout(() => {
          reject(new Error(`kernel did not exit ${count} time(s)`));
        }, 500);
        waiters.push(() => {
          if (exitCount >= count) {
            clearTimeout(timeout);
            resolve();
          }
        });
    });
    const client = new WorkspaceKernelClient({
      ...crashOnSecondRequest,
      timeoutMs: 500,
      initialBackoffMs: 1,
      maxBackoffMs: 5,
      onExit: () => {
        exitCount += 1;
        for (const waiter of waiters.splice(0)) waiter();
      },
    });
    try {
      await expect(client.handshake()).resolves.toMatchObject({ protocolVersion: 1 });
      await expect(client.handshake()).rejects.toBeInstanceOf(KernelUnavailableError);
      await waitForExitCount(1);
      await expect(client.handshake()).resolves.toMatchObject({ protocolVersion: 1 });
      expect(exitCount).toBeGreaterThanOrEqual(1);
    } finally {
      await client.dispose();
    }

    const exitsOnRequest = await writeFakeKernel(
      `
IFS= read -r _line
exit 1
`,
      `
process.stdin.once("data", () => process.exit(1));
`,
    );
    const limited = new WorkspaceKernelClient({
      ...exitsOnRequest,
      timeoutMs: 500,
      maxRestarts: 0,
    });
    try {
      await expect(limited.handshake()).rejects.toBeInstanceOf(KernelUnavailableError);
    } finally {
      await limited.dispose();
    }
  });

  it("does not spawn a new child when disposed during a restart backoff", async () => {
    const marker = await freshMarker();
    const crashesOnFirstRequest = await writeFakeKernel(
      `
printf 'x' >> ${marker}
IFS= read -r _line
exit 1
`,
      `
import { appendFileSync } from "node:fs";
appendFileSync(${JSON.stringify(marker)}, "x");
process.stdin.once("data", () => process.exit(1));
`,
    );
    const client = new WorkspaceKernelClient({
      ...crashesOnFirstRequest,
      timeoutMs: 500,
      initialBackoffMs: 500,
      maxBackoffMs: 500,
      maxRestarts: 3,
    });
    // Spawn #1 crashes on the first request and schedules a restart backoff.
    await expect(client.handshake()).rejects.toBeInstanceOf(KernelUnavailableError);
    // Dispose DURING the backoff: startOrRestart must observe disposal and bail
    // instead of leaking a sidecar the disposed client can no longer track.
    await client.dispose();
    // Give any (buggy) scheduled restart well past its backoff to fire.
    await new Promise((resolve) => setTimeout(resolve, 900));
    expect(await readFile(marker, "utf8")).toBe("x");
  });

  it("with maxRestarts:0 spawns the binary only once (one-shot reconcile path)", async () => {
    const marker = await freshMarker();
    const exitsOnRequest = await writeFakeKernel(
      `
printf 'x' >> ${marker}
IFS= read -r _line
exit 1
`,
      `
import { appendFileSync } from "node:fs";
appendFileSync(${JSON.stringify(marker)}, "x");
process.stdin.once("data", () => process.exit(1));
`,
    );
    const client = new WorkspaceKernelClient({
      ...exitsOnRequest,
      timeoutMs: 500,
      maxRestarts: 0,
    });
    await expect(client.handshake()).rejects.toBeInstanceOf(KernelUnavailableError);
    await client.dispose();
    await new Promise((resolve) => setTimeout(resolve, 200));
    // maxRestarts:0 never re-spawns a broken binary an extra time per call.
    expect(await readFile(marker, "utf8")).toBe("x");
  });

  it("times out a call when the kernel never replies", async () => {
    const neverReplies = await writeFakeKernel(
      `
while true; do
  sleep 1
done
`,
      `
process.stdin.resume();
setInterval(() => {}, 1000);
`,
    );
    const client = new WorkspaceKernelClient({ ...neverReplies, timeoutMs: 200 });
    try {
      await expect(client.handshake()).rejects.toBeInstanceOf(KernelTimeoutError);
    } finally {
      await client.dispose();
    }
  });

  it("aborts an in-flight real-kernel scan and reports unknown cancel ids", async () => {
    const root = await writeFixtureWorkspace({
      workspace: { files: [{ path: "note.txt", text: "hello" }] },
      expected: {},
    });
    const client = new WorkspaceKernelClient({ binaryPath, timeoutMs: 5000 });
    const controller = new AbortController();
    try {
      const scan = client.scan(root, { signal: controller.signal });
      controller.abort();
      await expect(scan).rejects.toBeInstanceOf(KernelClientError);
      await expect(scan).rejects.toThrow("aborted");
      await expect(client.cancel("unknown-request")).resolves.toEqual({ cancelled: false });
    } finally {
      await client.dispose();
    }
  });
});

async function readFixture(name: string): Promise<ContractFixture> {
  return JSON.parse(await readFile(join(fixtureDir, name), "utf8")) as ContractFixture;
}

async function writeFixtureWorkspace(fixture: ContractFixture): Promise<string> {
  const root = await mkdtemp(join(nativeTmpdir(), "dohc-kernel-client-"));
  roots.push(root);
  for (const file of fixture.workspace.files) {
    await write(root, file.path, file.text);
  }
  for (const link of fixture.workspace.symlinks ?? []) {
    const absolute = join(root, link.path);
    await mkdir(dirname(absolute), { recursive: true });
    await symlink(link.target, absolute).catch((error: NodeJS.ErrnoException) => {
      if (error.code !== "EPERM" && error.code !== "EEXIST") throw error;
    });
  }
  return root;
}

async function write(root: string, path: string, text: string): Promise<void> {
  const absolute = join(root, path);
  await mkdir(dirname(absolute), { recursive: true });
  await writeFile(absolute, text);
}

// Deterministic misbehaving kernels for supervision tests (crash, silence).
// POSIX platforms run the original bash fakes unchanged; Windows cannot spawn
// shebang scripts, so it runs behavior-identical Node ports through the Node
// executable (via the client's binaryArgs option).
interface FakeKernel {
  binaryPath: string;
  binaryArgs?: string[];
}

async function writeFakeKernel(bashSource: string, nodeSource: string): Promise<FakeKernel> {
  const root = await mkdtemp(join(nativeTmpdir(), "dohc-fake-kernel-"));
  roots.push(root);
  if (process.platform === "win32") {
    const path = join(root, "fake-kernel.mjs");
    await writeFile(path, `${nodeSource.trim()}\n`);
    return { binaryPath: process.execPath, binaryArgs: [path] };
  }
  const path = join(root, "fake-kernel");
  await writeFile(path, `#!/usr/bin/env bash\n${bashSource.trim()}\n`);
  await chmod(path, 0o755);
  return { binaryPath: path };
}

// A per-test marker file a fake kernel appends to on each spawn, so a test can
// count how many times the binary actually started.
async function freshMarker(): Promise<string> {
  const root = await mkdtemp(join(nativeTmpdir(), "dohc-kernel-marker-"));
  roots.push(root);
  return join(root, "spawns.log");
}

function nativeTmpdir(): string {
  return process.platform === "win32" ? tmpdir() : "/tmp";
}
