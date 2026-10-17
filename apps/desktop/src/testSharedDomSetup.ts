import { cleanup } from "@testing-library/react";
import { afterAll } from "vitest";
import { RESTORED_PROTOTYPES } from "../vitest.projects.ts";
import { restoreOwnProperties, saveOwnProperties, type OwnProperties } from "./testing/ownProperties";

// The shared jsdom project runs its files one after another in one window.
// Each file starts with nothing rendered, an empty body and storage, and the
// root element's attributes and the common DOM prototypes the worker started
// with. Like testSharedWorkerSetup.ts, which runs before it and restores the
// environment and globals, this reset runs when the file starts and again when
// it ends.

interface Baseline {
  root: Map<string, string>;
  prototypes: [object, OwnProperties][];
}

const store = globalThis as unknown as Record<symbol, Baseline | undefined>;
const key = Symbol.for("dohc.sharedDomBaseline");
const baseline = (store[key] ??= {
  root: new Map([...document.documentElement.attributes].map(({ name, value }) => [name, value])),
  prototypes: RESTORED_PROTOTYPES.map((name) => {
    const prototype = (globalThis as unknown as Record<string, { prototype: object }>)[name].prototype;
    return [prototype, saveOwnProperties(prototype, Reflect.ownKeys)];
  }),
});

function reset(): void {
  try {
    cleanup();
  } catch (error) {
    console.error("[shared jsdom] could not unmount what the last file rendered:", error);
  }
  document.body.replaceChildren();
  const root = document.documentElement;
  for (const { name } of [...root.attributes]) if (!baseline.root.has(name)) root.removeAttribute(name);
  for (const [name, value] of baseline.root) if (root.getAttribute(name) !== value) root.setAttribute(name, value);
  localStorage.clear();
  sessionStorage.clear();
  for (const [prototype, saved] of baseline.prototypes) restoreOwnProperties(prototype, saved);
}

reset();
afterAll(reset);
