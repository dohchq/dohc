// Each test changes one declaration in memory, as a contributor would in
// linksDeclarations.ts, and expects the CLI to refuse it when it loads.
import { afterEach, expect, it, vi } from "vitest";
import type { LINKS_DECLARATIONS } from "@dohc/workspace-contracts/links-declarations";

type LinksResolve = (typeof LINKS_DECLARATIONS)["linksResolve"];

function changeLinksResolve(change: (declaration: LinksResolve) => object) {
  vi.resetModules();
  vi.doMock("@dohc/workspace-contracts/links-declarations", async importOriginal => {
    const original = await importOriginal<{ LINKS_DECLARATIONS: typeof LINKS_DECLARATIONS }>();
    const declarations = original.LINKS_DECLARATIONS;
    return { LINKS_DECLARATIONS: { ...declarations, linksResolve: change(declarations.linksResolve) } };
  });
}

afterEach(() => {
  vi.doUnmock("@dohc/workspace-contracts/links-declarations");
  vi.resetModules();
});

it("refuses a declared command that repeats a hand-written command", async () => {
  changeLinksResolve(declaration => ({ ...declaration, cli: { ...declaration.cli, command: ["document", "read"] } }));
  await expect(import("./args")).rejects.toThrow("dohc document read is declared twice.");
});

it("refuses a declared command under a command that does not exist", async () => {
  changeLinksResolve(declaration => ({ ...declaration, cli: { ...declaration.cli, command: ["linkz", "resolve"] } }));
  await expect(import("./args")).rejects.toThrow("dohc linkz resolve names no command.");
});

it("refuses a declared socket verb that repeats a hand-written verb", async () => {
  changeLinksResolve(declaration => ({ ...declaration, cli: { ...declaration.cli, verb: "stopSync" } }));
  await expect(import("./protocol")).rejects.toThrow("stopSync is declared twice.");
});

it("loads the declarations as they are", async () => {
  vi.resetModules();
  const { CLI_COMMANDS } = await import("./args");
  expect(Object.keys(CLI_COMMANDS.links!.verbs)).toEqual(["edges", "in", "resolve"]);
  expect(Object.keys(CLI_COMMANDS.chat!.verbs).slice(-2)).toEqual(["links", "file-mentions"]);
});
