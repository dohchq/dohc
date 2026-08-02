// The native-target guard decides whether a gate run may be recorded as native
// evidence. Its first version collapsed cfg values into a Set, so two targets
// that shared an arch and an os counted as one and passed; the defect shipped
// because nothing could import the function to test it.
import assert from "node:assert/strict";
import test from "node:test";
import {
  cfgValues,
  verifyNativeTarget,
} from "../tools/rust-engine-program/native-target.mjs";

/** One `--print cfg` block, as rustc emits it per target. */
function cfgBlock({ arch = "x86_64", os = "windows", env = "msvc" } = {}) {
  return [
    "debug_assertions",
    `target_arch="${arch}"`,
    'target_endian="little"',
    `target_env="${env}"`,
    `target_os="${os}"`,
    'target_pointer_width="64"',
  ].join("\n");
}

const probeOf = (stdout, over = {}) => () => ({ status: 0, stdout, ...over });
const windowsHost = { nodeArch: "x64", nodePlatform: "win32" };

test("one host target passes and reports the cfg rustc gave", () => {
  const result = verifyNativeTarget({
    ...windowsHost,
    runProbe: probeOf(cfgBlock()),
  });
  assert.equal(result.ok, true);
  assert.equal(result.cfg, "x86_64/windows/msvc");
});

test("two targets sharing an arch and an os are counted, not deduplicated", () => {
  // gnu + musl on one host: identical target_arch and target_os, so a Set sees
  // one value each and certifies a multi-target build as native.
  const linuxHost = { nodeArch: "x64", nodePlatform: "linux" };
  const stdout = [
    cfgBlock({ os: "linux", env: "gnu" }),
    cfgBlock({ os: "linux", env: "musl" }),
  ].join("\n");

  assert.deepEqual(cfgValues(stdout, "target_arch"), ["x86_64", "x86_64"]);

  const result = verifyNativeTarget({ ...linuxHost, runProbe: probeOf(stdout) });
  assert.equal(result.ok, false);
  assert.match(result.reason, /compiled for 2 targets/);
  assert.match(result.reason, /requires exactly 1, the host's x86_64\/linux/);
});

test("a cross-compiled target fails and names host, observation, and the fix", () => {
  const result = verifyNativeTarget({
    ...windowsHost,
    runProbe: probeOf(cfgBlock({ os: "linux", env: "gnu" })),
  });
  assert.equal(result.ok, false);
  assert.match(result.reason, /cargo compiled for x86_64\/linux/);
  assert.match(result.reason, /not the host's x86_64\/windows/);
  assert.match(result.reason, /CARGO_BUILD_TARGET/);
});

test("a host with no rustc name fails closed instead of skipping the check", () => {
  let probed = false;
  const result = verifyNativeTarget({
    nodeArch: "mips",
    nodePlatform: "haiku",
    runProbe: () => {
      probed = true;
      return { status: 0, stdout: cfgBlock() };
    },
  });
  assert.equal(result.ok, false);
  assert.equal(probed, false, "an unmappable host must not be probed at all");
  assert.match(result.reason, /no rustc arch\/os name is known/);
  assert.match(result.reason, /haiku\/mips/);
});

test("a failed probe carries cargo's full output, not a tail of it", () => {
  const stderr = [
    "error[E0463]: can't find crate for `core`",
    "  --> src/lib.rs:1:1",
    "error: could not compile `serde` (build script)",
    "error: could not compile `proc-macro2` (build script)",
    "error: could not compile `quote` (build script)",
  ].join("\n");
  const result = verifyNativeTarget({
    ...windowsHost,
    runProbe: () => ({ status: 101, stdout: "", stderr }),
  });
  assert.equal(result.ok, false);
  assert.equal(result.output, stderr, "the primary error sits above the tail");
  assert.match(result.reason, /failed \(exit 101\)/);
});
