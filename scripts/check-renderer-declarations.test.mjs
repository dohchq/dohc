import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import test from "node:test";
import { checkRendererDeclarations } from "./check-renderer-declarations.mjs";

const panel = "apps/desktop/src/renderer/Panel.tsx";
const contracts = {
  "packages/workspace-contracts/package.json": JSON.stringify({
    name: "@dohc/workspace-contracts",
    exports: {
      "./links": "./src/links.ts",
      "./links-declarations": {
        types: "./src/linksDeclarations.ts",
        default: "./dist/linksDeclarations.js",
      },
    },
  }),
  "packages/workspace-contracts/src/links.ts": "export const LinksInInput = {};",
  "packages/workspace-contracts/src/linksDeclarations.ts":
    'import { LinksInInput } from "./links";\n' +
    "export const LINKS_DECLARATIONS = { linksIn: { input: LinksInInput } } as const satisfies OperationFamily;",
};

function fixture(t, sources) {
  const dir = mkdtempSync(join(tmpdir(), "dohc-renderer-declarations-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  for (const [path, source] of Object.entries({ ...contracts, ...sources })) {
    mkdirSync(dirname(join(dir, path)), { recursive: true });
    writeFileSync(join(dir, path), source);
  }
  return dir;
}

const failures = (t, sources) => checkRendererDeclarations(fixture(t, sources)).failures;

test("rejects a renderer value import of a declaration and names what to import instead", (t) => {
  const [failure, ...rest] = failures(t, {
    [panel]:
      'import { LINKS_DECLARATIONS } from "@dohc/workspace-contracts/links-declarations";\nexport const tools = LINKS_DECLARATIONS;',
  });
  assert.deepEqual(rest, []);
  assert.match(
    failure,
    /^apps\/desktop\/src\/renderer\/Panel\.tsx loads the operation declarations in packages\/workspace-contracts\/src\/linksDeclarations\.ts at run time\./u,
  );
  assert.match(failure, /`import type`.*@dohc\/workspace-contracts\/links\.$/u);
});

test("accepts type-only imports and the contract schema module", (t) => {
  assert.deepEqual(
    failures(t, {
      [panel]:
        'import type { LINKS_DECLARATIONS } from "@dohc/workspace-contracts/links-declarations";\n' +
        'import { type LINKS_DECLARATIONS as Again } from "@dohc/workspace-contracts/links-declarations";\n' +
        'export type { LINKS_DECLARATIONS as Exported } from "@dohc/workspace-contracts/links-declarations";\n' +
        'type Tools = typeof import("@dohc/workspace-contracts/links-declarations");\n' +
        'import { LinksInInput } from "@dohc/workspace-contracts/links";\nexport const input = LinksInInput;',
    }),
    [],
  );
});

test("follows relative modules, re-exports, side-effect imports, and dynamic imports", (t) => {
  const bridge = "apps/desktop/src/ipc/linksTable.ts";
  for (const statement of [
    'import { LINKS_DECLARATIONS } from "@dohc/workspace-contracts/links-declarations"; export const rows = LINKS_DECLARATIONS;',
    'export * from "@dohc/workspace-contracts/links-declarations";',
    'export { LINKS_DECLARATIONS } from "@dohc/workspace-contracts/links-declarations";',
    'import "@dohc/workspace-contracts/links-declarations";',
    'export const later = () => import("@dohc/workspace-contracts/links-declarations");',
  ]) {
    const [failure, ...rest] = failures(t, {
      [panel]: 'import { rows } from "../ipc/linksTable";\nexport const view = rows;',
      [bridge]: statement,
    });
    assert.deepEqual(rest, [], statement);
    assert.match(
      failure,
      /^apps\/desktop\/src\/renderer\/Panel\.tsx loads .*linksDeclarations\.ts at run time through apps\/desktop\/src\/ipc\/linksTable\.ts\./u,
      statement,
    );
  }
});

test("ignores renderer tests, which do not ship", (t) => {
  assert.deepEqual(
    failures(t, {
      "apps/desktop/src/renderer/Panel.test.tsx":
        'import { LINKS_DECLARATIONS } from "@dohc/workspace-contracts/links-declarations";\nexport const tools = LINKS_DECLARATIONS;',
    }),
    [],
  );
});

test("recognises a declaration file by its name, however it spells the family type", (t) => {
  const panelLoads = {
    [panel]:
      'import { LINKS_DECLARATIONS } from "@dohc/workspace-contracts/links-declarations";\nexport const tools = LINKS_DECLARATIONS;',
  };
  for (const declaration of [
    "export const LINKS_DECLARATIONS: OperationFamily = { linksIn: { input: LinksInInput } };",
    "export const LINKS_DECLARATIONS = { linksIn: { input: LinksInInput } } as const satisfies Family;",
    "export const LINKS_DECLARATIONS = { linksIn: { input: LinksInInput } } as const satisfies Contracts.OperationFamily;",
  ]) {
    const [failure, ...rest] = failures(t, {
      ...panelLoads,
      "packages/workspace-contracts/src/linksDeclarations.ts":
        'import { LinksInInput } from "./links";\n' + declaration,
    });
    assert.deepEqual(rest, [], declaration);
    assert.match(
      failure,
      /^apps\/desktop\/src\/renderer\/Panel\.tsx loads the operation declarations in packages\/workspace-contracts\/src\/linksDeclarations\.ts at run time\./u,
      declaration,
    );
  }
});

test("refuses a dynamic import whose module is not a string", (t) => {
  for (const statement of [
    "export const later = () => import(`@dohc/workspace-contracts/links-declarations`);",
    'const name = "@dohc/workspace-contracts/links-declarations";\nexport const later = () => import(name);',
    "export const later = (family) => import(`@dohc/workspace-contracts/${family}-declarations`);",
  ]) {
    assert.deepEqual(
      failures(t, { [panel]: statement }),
      [
        "apps/desktop/src/renderer/Panel.tsx imports a module named by an expression, which this check cannot follow. Name the module with a string.",
      ],
      statement,
    );
  }
});
