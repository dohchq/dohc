import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const mainSource = readFileSync(new URL("./main.ts", import.meta.url), "utf8").replaceAll(
  "\r\n",
  "\n",
);
const ingressSource = readFileSync(
  new URL("./shareHandoffIngress.ts", import.meta.url),
  "utf8",
).replaceAll("\r\n", "\n");

function handlerSource(event: string): string {
  const marker = `app.on("${event}",`;
  const start = mainSource.indexOf(marker);
  if (start < 0) throw new Error(`Missing app.on("${event}") handler`);
  const next = mainSource.indexOf("app.on(", start + marker.length);
  return mainSource.slice(start, next < 0 ? undefined : next);
}

describe("share handoff main-process wiring", () => {
  it("captures cold argv before renderer bootstrap or credential work", () => {
    const coldCaptureAt = mainSource.indexOf(
      "receiveShareHandoffArguments(process.argv, shareHandoffIntentSlot)",
    );
    const whenReadyAt = mainSource.indexOf("app.whenReady().then(");
    const rendererBootstrapAt = mainSource.indexOf(
      "registerIpcHandlers();",
      whenReadyAt,
    );
    const credentialWorkAt = mainSource.indexOf(
      "warmCredentialCache()",
      whenReadyAt,
    );

    expect(coldCaptureAt).toBeGreaterThanOrEqual(0);
    expect(coldCaptureAt).toBeLessThan(whenReadyAt);
    expect(coldCaptureAt).toBeLessThan(rendererBootstrapAt);
    expect(coldCaptureAt).toBeLessThan(credentialWorkAt);
    expect(
      mainSource.lastIndexOf('if (process.platform !== "darwin")', coldCaptureAt),
    ).toBeGreaterThanOrEqual(0);
  });

  it("registers open-url before readiness and keeps the bootstrap gate closed", () => {
    const handlerAt = mainSource.indexOf('app.on("open-url",');
    const whenReadyAt = mainSource.indexOf("app.whenReady().then(");
    const handler = handlerSource("open-url");

    expect(handlerAt).toBeGreaterThanOrEqual(0);
    expect(handlerAt).toBeLessThan(whenReadyAt);
    expect(handler).toContain("event.preventDefault();");
    expect(handler).toContain("receiveShareHandoffArguments([rawArgument]");
    expect(handler).toContain("if (!accepted || !bootstrapComplete) return;");
    expect(handler.indexOf("receiveShareHandoffArguments")).toBeLessThan(
      handler.indexOf("if (!accepted || !bootstrapComplete) return;"),
    );
  });

  it("feeds every second-instance argument through the ingress before acting", () => {
    const handler = handlerSource("second-instance");
    const captureAt = handler.indexOf(
      "receiveShareHandoffArguments(argv, shareHandoffIntentSlot)",
    );
    const windowGateAt = handler.indexOf("showOrCreateMainWindow()");

    expect(captureAt).toBeGreaterThanOrEqual(0);
    expect(windowGateAt).toBeGreaterThan(captureAt);
    expect(handler).toContain("if (!accepted && workspacePaths.length === 0) return;");
    expect(handler).toContain("pendingOpenPaths.push(...workspacePaths)");
    expect(handler).toContain("openWorkspacePaths(workspacePaths, window)");
  });

  it("calls Electron's runtime registration API", () => {
    expect(mainSource).toContain("registerShareHandoffProtocol(app, process);");
  });

  it("does not log protocol arguments on any ingress path", () => {
    expect(ingressSource).not.toMatch(/console\s*\./);
    expect(handlerSource("open-url")).not.toMatch(/console\s*\./);
    expect(handlerSource("second-instance")).not.toMatch(/console\s*\./);
    expect(mainSource).not.toMatch(
      /console\.(?:debug|info|log|warn|error)\([^\n]*(?:process\.argv|\bargv\b|rawArgument)/,
    );
  });

  it("preserves the existing open-file and open-workspace paths", () => {
    expect(handlerSource("open-file")).toContain("pendingOpenPaths.push(path)");
    expect(handlerSource("second-instance")).toContain(
      "collectOpenWorkspaceArgs(argv)",
    );
    expect(mainSource).toContain("collectOpenWorkspaceArgs(process.argv)");
  });
});
