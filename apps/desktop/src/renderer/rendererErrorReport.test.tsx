// @vitest-environment jsdom
import { cleanup, render } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { EditorErrorBoundary } from "./editor/EditorErrorBoundary";
import { ErrorBoundary, installGlobalErrorReporters } from "./ErrorBoundary";
import { reportRendererError } from "./rendererErrorReport";

const SECRET = "Secret Trip Plans";
let reportRendererErrorCall: ReturnType<typeof vi.fn>;
// A window hands each distinct error once, so each error here has its own line.
let line = 0;

function secretError(): Error {
  line += 1;
  const error = new RangeError(`${SECRET} failed`);
  error.stack = `RangeError: ${SECRET} failed\n    at open (file:///C:/dohc/resources/app.asar/dist/renderer/index.js:${line}:2)`;
  return error;
}

function Bomb(): never {
  throw secretError();
}

beforeEach(() => {
  vi.spyOn(console, "error").mockImplementation(() => undefined);
  reportRendererErrorCall = vi.fn(async () => undefined);
  window.dohcDesktop = { reportRendererError: reportRendererErrorCall } as unknown as typeof window.dohcDesktop;
});

afterEach(() => {
  cleanup();
  delete window.dohcDesktop;
  vi.restoreAllMocks();
});

describe("renderer error reports", () => {
  it("hands main the class and the stack's frames, never the message", () => {
    reportRendererError("uncaught", secretError());
    expect(reportRendererErrorCall).toHaveBeenCalledWith({
      origin: "uncaught",
      error: { name: "RangeError", stack: `    at open (file:///C:/dohc/resources/app.asar/dist/renderer/index.js:${line}:2)` },
    });
    expect(JSON.stringify(reportRendererErrorCall.mock.calls)).not.toContain(SECRET);
  });

  it("hands main only the type of a thrown value that is not an Error", () => {
    reportRendererError("rejection", SECRET);
    reportRendererError("rejection", null);
    expect(reportRendererErrorCall.mock.calls.map(([payload]) => payload)).toEqual([
      { origin: "rejection", error: { type: "string" } },
      { origin: "rejection", error: { type: "object" } },
    ]);
  });

  it("never throws, with or without a bridge", () => {
    reportRendererErrorCall.mockRejectedValue(new Error("main is gone"));
    expect(() => reportRendererError("uncaught", new Error("x"))).not.toThrow();
    delete window.dohcDesktop;
    expect(() => reportRendererError("uncaught", new Error("x"))).not.toThrow();
  });

  it("forwards uncaught errors and unhandled rejections", () => {
    const target = new EventTarget();
    installGlobalErrorReporters(target as unknown as Window);
    target.dispatchEvent(Object.assign(new Event("error"), { error: secretError(), message: SECRET }));
    target.dispatchEvent(Object.assign(new Event("unhandledrejection"), { reason: secretError() }));
    expect(reportRendererErrorCall.mock.calls.map(([payload]) => (payload as { origin: string }).origin))
      .toEqual(["uncaught", "rejection"]);
    expect(JSON.stringify(reportRendererErrorCall.mock.calls)).not.toContain(SECRET);
  });

  it("forwards what both error boundaries catch", () => {
    render(<ErrorBoundary scope="editor"><Bomb /></ErrorBoundary>);
    render(<EditorErrorBoundary resetKey="notes/a.md"><Bomb /></EditorErrorBoundary>);
    expect(reportRendererErrorCall.mock.calls.map(([payload]) => payload)).toEqual([
      expect.objectContaining({ origin: "boundary", error: expect.objectContaining({ name: "RangeError" }) }),
      expect.objectContaining({ origin: "boundary", error: expect.objectContaining({ name: "RangeError" }) }),
    ]);
  });
});
