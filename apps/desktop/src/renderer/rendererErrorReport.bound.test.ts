// @vitest-environment jsdom
import { afterEach, expect, it, vi } from "vitest";
import { RENDERER_ERROR_REPORTS, reportRendererError } from "./rendererErrorReport";

// Its own file: the bound lasts as long as the window, which here is this file.
afterEach(() => {
  delete window.dohcDesktop;
});

function error(line: number): Error {
  const thrown = new TypeError("x");
  thrown.stack = `TypeError: x\n    at f (file:///C:/dohc/resources/app.asar/dist/renderer/index.js:${line}:1)`;
  return thrown;
}

it("hands a repeat once, still hands a one-off after a loop, and stops after its bound", () => {
  const send = vi.fn(async () => undefined);
  window.dohcDesktop = { reportRendererError: send } as unknown as typeof window.dohcDesktop;

  for (let index = 0; index < 1_000; index += 1) reportRendererError("uncaught", error(1));
  expect(send).toHaveBeenCalledOnce();
  reportRendererError("boundary", error(2));
  expect(send).toHaveBeenCalledTimes(2);

  for (let line = 3; line < RENDERER_ERROR_REPORTS + 50; line += 1) reportRendererError("uncaught", error(line));
  expect(send).toHaveBeenCalledTimes(RENDERER_ERROR_REPORTS);
});
