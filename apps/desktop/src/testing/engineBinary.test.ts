import { afterEach, describe, expect, it, vi } from "vitest";
import { rmSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { isAbsolute, join, resolve } from "node:path";
import {
  ENGINE_BINARY_ENV_VAR,
  REQUIRE_ENGINE_ENV_VAR,
  engineBinaryCandidates,
  findEngineBinary,
  requireEngineBinaryOrSkip,
  resolveEngineBinary,
} from "./engineBinary";
import { createTestScratchSync } from "../workspaces/testTemp";

// This module decides whether the daemon-driving suites run at all, so a
// regression here silently restores the skipped coverage that #390 was about.
// A test that only checked "it returns a path" would not notice any of that,
// so each case below pins one decision the resolver makes.

const scratch: string[] = [];

function tempBinary(mtimeSeconds?: number): string {
  const dir = createTestScratchSync("dohc-engine-binary-test-");
  scratch.push(dir);
  const path = join(dir, "dohc-workspace-engine");
  writeFileSync(path, "not a real binary");
  if (mtimeSeconds !== undefined) utimesSync(path, mtimeSeconds, mtimeSeconds);
  return path;
}

afterEach(() => {
  vi.unstubAllEnvs();
  for (const dir of scratch.splice(0)) {
    rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
  }
});

describe("engine binary discovery", () => {
  it("collapses the candidate list to an override, consulting nothing else", () => {
    const override = resolve("custom-engine-override");
    vi.stubEnv(ENGINE_BINARY_ENV_VAR, override);
    expect(engineBinaryCandidates()).toEqual([override]);
  });

  it("resolves a RELATIVE override to an absolute path", () => {
    // EngineDaemonLifecycle sets the child's cwd to dirname(command) and then
    // spawns `command` from there, so a relative override would be resolved a
    // second time against its own directory — artifacts/artifacts/engine — and
    // fail the startup handshake.
    vi.stubEnv(ENGINE_BINARY_ENV_VAR, "./artifacts/dohc-workspace-engine");
    const [candidate] = engineBinaryCandidates();
    expect(isAbsolute(candidate!)).toBe(true);
    expect(candidate).toBe(resolve("./artifacts/dohc-workspace-engine"));
  });

  it("tries the workspace-root cargo output BEFORE the staged copy", () => {
    // Root first, because it is the only one a `cargo build` refreshes. The
    // staged copy under apps/desktop exists for Electron, and keeping it in step
    // is the staging hook's job.
    vi.stubEnv(ENGINE_BINARY_ENV_VAR, "");
    const candidates = engineBinaryCandidates();
    expect(candidates).toHaveLength(2);
    expect(candidates[0]).not.toMatch(/apps[\\/]desktop/);
    expect(candidates[1]).toMatch(/apps[\\/]desktop[\\/]target[\\/]debug/);
  });

  it("carries the platform executable suffix", () => {
    vi.stubEnv(ENGINE_BINARY_ENV_VAR, "");
    const suffix = process.platform === "win32" ? ".exe" : "";
    for (const candidate of engineBinaryCandidates()) {
      expect(candidate.endsWith(`dohc-workspace-engine${suffix}`)).toBe(true);
    }
  });

  it("takes the FIRST existing candidate, ignoring mtime", () => {
    // Deliberately gives the second candidate the newer mtime. An earlier
    // revision picked by mtime and that heuristic produced four defects in
    // review; order is now the whole rule, so this must not drift back.
    const first = tempBinary(1_700_000_000);
    const secondNewer = tempBinary(1_900_000_000);
    expect(findEngineBinary([first, secondNewer])).toBe(first);
    expect(findEngineBinary([secondNewer, first])).toBe(secondNewer);
  });

  it("ignores a candidate that does not exist when choosing the newest", () => {
    const present = tempBinary(1_700_000_000);
    const absent = join(tmpdir(), "dohc-absent-engine-xyz");
    expect(findEngineBinary([absent, present])).toBe(present);
    expect(findEngineBinary([absent])).toBeNull();
  });

  it("returns null rather than throwing when no binary exists", () => {
    vi.stubEnv(ENGINE_BINARY_ENV_VAR, join(tmpdir(), "dohc-absent-engine-xyz"));
    expect(findEngineBinary()).toBeNull();
  });

  it("resolveEngineBinary throws and names every candidate tried", () => {
    const absent = join(tmpdir(), "dohc-absent-engine-xyz");
    vi.stubEnv(ENGINE_BINARY_ENV_VAR, absent);
    expect(() => resolveEngineBinary()).toThrow(absent);
    expect(() => resolveEngineBinary()).toThrow(/binary not found/);
  });
});

describe("the required-mode gate", () => {
  it("skips when the binary is absent and the flag is unset", () => {
    vi.stubEnv(ENGINE_BINARY_ENV_VAR, join(tmpdir(), "dohc-absent-engine-xyz"));
    vi.stubEnv(REQUIRE_ENGINE_ENV_VAR, "");
    const gate = requireEngineBinaryOrSkip();
    expect(gate.missing).toBe(true);
    expect(gate.path).toBeNull();
  });

  it("THROWS when the binary is absent and the flag is set", () => {
    // The whole point of #390: on a machine that is meant to have a daemon, a
    // silent skip is indistinguishable from a pass.
    vi.stubEnv(ENGINE_BINARY_ENV_VAR, join(tmpdir(), "dohc-absent-engine-xyz"));
    vi.stubEnv(REQUIRE_ENGINE_ENV_VAR, "1");
    expect(() => requireEngineBinaryOrSkip()).toThrow(
      new RegExp(REQUIRE_ENGINE_ENV_VAR),
    );
  });

  it("resolves and reports present when a binary exists", () => {
    const binary = tempBinary();
    vi.stubEnv(ENGINE_BINARY_ENV_VAR, binary);
    vi.stubEnv(REQUIRE_ENGINE_ENV_VAR, "1");
    const gate = requireEngineBinaryOrSkip();
    expect(gate.missing).toBe(false);
    expect(gate.path).toBe(binary);
    expect(gate.require()).toBe(binary);
  });

  it("require() throws when called without a skip guard", () => {
    vi.stubEnv(ENGINE_BINARY_ENV_VAR, join(tmpdir(), "dohc-absent-engine-xyz"));
    vi.stubEnv(REQUIRE_ENGINE_ENV_VAR, "");
    const gate = requireEngineBinaryOrSkip();
    // Reaching require() with gate.missing true means the it.skipIf guard is
    // missing from the suite — fail loudly rather than spawn nothing.
    expect(() => gate.require()).toThrow(/binary not found/);
  });
});
