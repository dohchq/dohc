import { afterEach, describe, expect, it, vi } from "vitest";
import { mkdtempSync, rmSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  ENGINE_BINARY_ENV_VAR,
  REQUIRE_ENGINE_ENV_VAR,
  engineBinaryCandidates,
  findEngineBinary,
  requireEngineBinaryOrSkip,
  resolveEngineBinary,
} from "./engineBinary";

// This module decides whether the daemon-driving suites run at all, so a
// regression here silently restores the skipped coverage that #390 was about.
// A test that only checked "it returns a path" would not notice any of that,
// so each case below pins one decision the resolver makes.

const scratch: string[] = [];

function tempBinary(mtimeSeconds?: number): string {
  const dir = mkdtempSync(join(tmpdir(), "dohc-engine-binary-test-"));
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
    vi.stubEnv(ENGINE_BINARY_ENV_VAR, "C:/somewhere/custom-engine.exe");
    expect(engineBinaryCandidates()).toEqual(["C:/somewhere/custom-engine.exe"]);
  });

  it("offers the desktop-relative path before the repo root, and names both", () => {
    vi.stubEnv(ENGINE_BINARY_ENV_VAR, "");
    const candidates = engineBinaryCandidates();
    expect(candidates).toHaveLength(2);
    // Order is what the diagnostic message shows a developer; the *selection*
    // is by mtime, asserted separately below.
    expect(candidates[0]).toMatch(/apps[\\/]desktop[\\/]target[\\/]debug/);
    expect(candidates[1]).not.toMatch(/apps[\\/]desktop/);
  });

  it("carries the platform executable suffix", () => {
    vi.stubEnv(ENGINE_BINARY_ENV_VAR, "");
    const suffix = process.platform === "win32" ? ".exe" : "";
    for (const candidate of engineBinaryCandidates()) {
      expect(candidate.endsWith(`dohc-workspace-engine${suffix}`)).toBe(true);
    }
  });

  it("prefers the NEWEST existing binary regardless of candidate order", () => {
    // The regression this guards: `cargo build` refreshes only the repo-root
    // binary while require-e2e-engine.mjs leaves a stale COPY under
    // apps/desktop/target/debug. First-match ordering would run the suites
    // against daemon code from an earlier build.
    const older = tempBinary(1_700_000_000);
    const newer = tempBinary(1_800_000_000);

    // Asserted BOTH orders. Passing only [older, newer] would also pass an
    // implementation that simply returned the last existing candidate.
    expect(findEngineBinary([older, newer])).toBe(newer);
    expect(findEngineBinary([newer, older])).toBe(newer);
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
