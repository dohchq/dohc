#!/usr/bin/env node
// Catch new state, refs, reducers, or effects in the desktop workspace shell.
// The shell composes features; each feature owns its state in its own hook on
// top of the workspace visit. The counts in scripts/shell-composes.json only
// go down. Only direct calls in the DesktopWorkspaceShell component count, so
// state in a custom hook the shell calls, in a helper, or in another component
// is outside this check.
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";

const repoRoot = resolve(import.meta.dirname, "..");
const shellPath = "apps/desktop/src/renderer/DesktopWorkspaceShell.tsx";
const baselinePath = "scripts/shell-composes.json";
export const hookNames = ["useState", "useRef", "useReducer", "useEffect", "useLayoutEffect"];
const { parse } = createRequire(join(repoRoot, "package.json"))("@babel/parser");
const functionTypes = new Set(["FunctionDeclaration", "FunctionExpression", "ArrowFunctionExpression", "ObjectMethod", "ClassMethod", "ClassPrivateMethod"]);
const where = "Put it in the feature's own hook, such as apps/desktop/src/renderer/shell/useSavedWorkbenchLayout.ts. "
  + "Build that hook on the workspace visit in apps/desktop/src/renderer/workspace/workspaceVisit.ts: it gives the selection, admission, readiness, the stop, and the workbench. "
  + "Return a view and named actions, never a setter. "
  + "This check counts only direct calls in the DesktopWorkspaceShell component. It can't see state in a custom hook, a helper, or a child component, "
  + "so a hook that the shell feeds its own setters and refs passes and is still wrong.";

// Counts each React hook called directly in the DesktopWorkspaceShell
// component: through a named import from "react", its alias, or a namespace
// import. Calls inside nested functions belong to those functions.
export function countShellHooks(source) {
  const program = parse(source, { sourceType: "module", plugins: ["typescript", "jsx"] }).program;
  const names = new Map(), namespaces = new Set();
  for (const node of program.body) {
    if (node.type !== "ImportDeclaration" || node.source.value !== "react" || node.importKind === "type") continue;
    for (const specifier of node.specifiers) {
      if (specifier.type === "ImportSpecifier") names.set(specifier.local.name, specifier.imported.name ?? specifier.imported.value);
      else namespaces.add(specifier.local.name);
    }
  }
  const shell = program.body.map(node => node.declaration ?? node)
    .find(node => node.type === "FunctionDeclaration" && node.id?.name === "DesktopWorkspaceShell");
  if (!shell) throw new Error(shellPath + ": no DesktopWorkspaceShell function declaration.");
  const counts = Object.fromEntries(hookNames.map(name => [name, 0]));
  const visit = node => {
    if (node.type === "CallExpression") {
      const callee = node.callee;
      const name = callee.type === "Identifier" ? names.get(callee.name)
        : callee.type === "MemberExpression" && !callee.computed && namespaces.has(callee.object.name) ? callee.property.name : undefined;
      if (name in counts) counts[name] += 1;
    }
    for (const [key, value] of Object.entries(node)) {
      if (key === "loc" || key === "leadingComments" || key === "trailingComments" || key === "innerComments") continue;
      for (const child of Array.isArray(value) ? value : [value]) {
        if (child?.type && !functionTypes.has(child.type)) visit(child);
      }
    }
  };
  visit(shell.body);
  return counts;
}

export function checkShellComposes(source, baseline) {
  if (hookNames.some(name => !Number.isInteger(baseline?.[name])) || Object.keys(baseline).length !== hookNames.length) {
    return { failures: [baselinePath + ": expected a whole number for each of " + hookNames.join(", ") + "."], counts: null };
  }
  const counts = countShellHooks(source), failures = [];
  for (const name of hookNames) {
    if (counts[name] > baseline[name]) {
      failures.push(shellPath + " calls " + name + " " + counts[name] + " times, above the baseline of " + baseline[name]
        + ". The shell composes; a feature owns its state behind the workspace session. " + where
        + " Raising the baseline is not a fix.");
    } else if (counts[name] < baseline[name]) {
      failures.push(shellPath + " calls " + name + " " + counts[name] + " times. Lower " + name + " in " + baselinePath
        + " from " + baseline[name] + " to " + counts[name] + "; the baseline only goes down.");
    }
  }
  return { failures, counts };
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  const root = process.argv[2] ? resolve(process.argv[2]) : repoRoot;
  const baseline = JSON.parse(readFileSync(join(root, baselinePath), "utf8"));
  const { failures, counts } = checkShellComposes(readFileSync(join(root, shellPath), "utf8"), baseline);
  if (failures.length) {
    console.error("Shell composes check failed:\n" + failures.map(failure => "- " + failure).join("\n"));
    process.exitCode = 1;
  } else {
    console.log("Shell composes check passed (" + hookNames.map(name => name + " " + counts[name]).join(", ") + ").");
  }
}
