import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const decisions = await readFile(
  new URL("../docs/superpowers/plans/rust-engine/DECISIONS.md", import.meta.url),
  "utf8",
);

test("R13b-S9 records both mandatory pre-flip MCP routing checks", () => {
  assert.match(
    decisions,
    /pre-flip acceptance check is:[\s\S]*packages\/mcp[\s\S]*no longer opens or writes `engine\.db`[\s\S]*`withEngineStores`/,
  );
  assert.match(decisions, /every MCP write tool routes through desktop main/);
  assert.match(decisions, /direct-store fallback does not satisfy the check/);
});

test("S8 records the raw-key RPC boundary and its required runtime proof", () => {
  assert.match(
    decisions,
    /Raw data-key material is forbidden from every RPC input,[\s\S]*response, event, error, diagnostic, and log/,
  );
  assert.match(
    decisions,
    /boundary test that drives the real[\s\S]*request, response, event, and error paths while capturing daemon stderr/,
  );
  assert.match(decisions, /distinctive raw-key sentinel/);
  assert.match(decisions, /no key-envelope RPC surface exists yet/);
});
