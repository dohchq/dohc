import assert from "node:assert/strict";
import test from "node:test";
import { checkShellComposes, countShellHooks, hookNames } from "./check-shell-composes.mjs";

const zero = Object.fromEntries(hookNames.map(name => [name, 0]));
const shell = body => `import { useState, useRef as useBox, useEffect } from "react";
import * as React from "react";
import type { useReducer } from "react";
function useFeature() { const [a] = useState(0); return a; }
export function DesktopWorkspaceShell() {
${body}
  return null;
}`;

test("counts direct calls through names, aliases, and the namespace", () => {
  const counts = countShellHooks(shell(`
  const [a] = useState(0);
  const b = useBox(null);
  React.useLayoutEffect(() => {});
  if (a) useEffect(() => {});
  const c = React.useReducer(x => x, 0);`));
  assert.deepEqual(counts, { ...zero, useState: 1, useRef: 1, useReducer: 1, useEffect: 1, useLayoutEffect: 1 });
});

test("does not count calls in nested functions, other hooks, or other components", () => {
  const counts = countShellHooks(shell(`
  const feature = useFeature();
  const later = () => useState(0);
  const handler = useCallback(function () { useEffect(() => {}); }, []);
  const { value } = { value() { return useBox(null); } };`));
  assert.deepEqual(counts, zero);
});

test("a rise fails and says where feature state goes", () => {
  const { failures } = checkShellComposes(shell("  const [a] = useState(0);\n  useEffect(() => {});"), { ...zero, useEffect: 1 });
  assert.equal(failures.length, 1);
  assert.match(failures[0], /calls useState 1 times, above the baseline of 0/u);
  assert.match(failures[0], /The shell composes; a feature owns its state behind the workspace session\./u);
  assert.match(failures[0], /workspace\/workspaceVisit\.ts/u);
  assert.match(failures[0], /Raising the baseline is not a fix/u);
});

test("a fall fails until the baseline comes down", () => {
  const { failures } = checkShellComposes(shell("  const b = useBox(null);"), { ...zero, useRef: 2 });
  assert.deepEqual(failures, [
    "apps/desktop/src/renderer/DesktopWorkspaceShell.tsx calls useRef 1 times. Lower useRef in scripts/shell-composes.json from 2 to 1; the baseline only goes down.",
  ]);
  assert.deepEqual(checkShellComposes(shell("  const b = useBox(null);"), { ...zero, useRef: 1 }).failures, []);
});

test("rejects a baseline without a whole number for each hook", () => {
  for (const baseline of [{ ...zero, useState: undefined }, { ...zero, useState: 1.5 }, { ...zero, useMemo: 0 }]) {
    assert.match(checkShellComposes(shell(""), baseline).failures[0], /expected a whole number for each of useState/u);
  }
});
