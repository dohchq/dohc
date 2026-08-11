import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

// A SOURCE-LEVEL WIRING assertion, in the same spirit as
// main.engineYDocQuitClose.test.ts: this lives inside main.ts's Electron
// bootstrap and has no unit harness. What the cleanup DOES is covered in
// sitePreviewSdkAuthority.test.ts. What is only checkable here is WHEN it is
// asked for — and that is the whole safety argument (#579 review, r19).
//
// A quit is cancellable until every window has closed: the renderer's
// beforeunload can veto it, and the recovery guard does exactly that when a
// set-aside draft is at stake. before-quit runs BEFORE that veto, so cleanup
// wired there tore down live site previews for a quit the user then went back
// from — revoked authorities, stopped servers, a surface unrelated to the
// update left dead while they kept working.
const mainSource = readFileSync(new URL("./main.ts", import.meta.url), "utf8");

describe("site preview cleanup at quit", () => {
  it("runs only from the will-quit teardown", () => {
    const willQuit = mainSource.indexOf('app.on("will-quit"');
    expect(willQuit).toBeGreaterThan(-1);
    const body = mainSource.slice(
      willQuit,
      mainSource.indexOf("\n});", willQuit),
    );
    // MUTATION (cleanup timing): move the call back to a before-quit handler.
    // It then runs before any beforeunload can veto, and "Go back" leaves
    // dead previews behind.
    expect(body).toContain("stopSitePreviewsForQuit();");
  });

  it("is asked for exactly once, and never from a cancellable phase", () => {
    // One definition, one call. Any before-quit or before-quit-for-update
    // caller is a cleanup for an action that may not happen.
    expect(mainSource.split("stopSitePreviewsForQuit();").length - 1).toBe(1);
    const beforeQuit = mainSource.indexOf('app.on("before-quit"');
    expect(beforeQuit).toBeGreaterThan(-1);
    const beforeQuitBody = mainSource.slice(
      beforeQuit,
      mainSource.indexOf("\n  });", beforeQuit),
    );
    expect(beforeQuitBody).not.toContain("stopSitePreviewsForQuit");
    expect(mainSource).not.toContain("onBeforeQuitForUpdate");
  });

  it("aborts pending starts before sweeping previews during a workspace switch", () => {
    const handlerStart = mainSource.indexOf(
      "ipcMain.handle(CHANNELS.openWorkspace",
    );
    expect(handlerStart).toBeGreaterThan(-1);
    const handler = mainSource.slice(
      handlerStart,
      mainSource.indexOf("\n  });", handlerStart),
    );
    const abortAt = handler.indexOf(
      "abortSitePreviewStartsForSender(senderId);",
    );
    const stopAt = handler.indexOf(
      "await stopSitePreviewsForWorkspace(previousWorkspaceId);",
    );

    // MUTATION (switch race): without the abort, a start that has not stored
    // its handle is absent from the sweep. It can finish after the switch and
    // leave its process and allowed origin owned by the old workspace.
    expect(abortAt).toBeGreaterThan(-1);
    expect(stopAt).toBeGreaterThan(abortAt);
  });

  it("does not let queued workspace cleanup stop a replacement preview", () => {
    const cleanupStart = mainSource.indexOf(
      "async function stopSitePreviewsForWorkspace",
    );
    expect(cleanupStart).toBeGreaterThan(-1);
    const cleanup = mainSource.slice(
      cleanupStart,
      mainSource.indexOf("\n}\n\nfunction commandForSiteScript", cleanupStart),
    );

    // MUTATION (replacement race): cleanup can wait behind a preview start.
    // It must retain the old handle so it cannot stop the replacement.
    expect(cleanup).toContain("sitePreviews.previewsForWorkspace(workspaceId)");
    expect(cleanup).toContain(
      "sitePreviews.stop(workspaceId, siteRoot, handle)",
    );
  });

  it("changes renderer authority before workspace cleanup can yield", () => {
    const handlerStart = mainSource.indexOf(
      "ipcMain.handle(CHANNELS.openWorkspace",
    );
    expect(handlerStart).toBeGreaterThan(-1);
    const handler = mainSource.slice(
      handlerStart,
      mainSource.indexOf("\n  });", handlerStart),
    );
    const activeAt = handler.indexOf(
      "activeWorkspaceIdBySender.set(senderId, workspace.workspaceId);",
    );
    const cleanupHookAt = handler.indexOf(
      "if (!activeWorkspaceCleanupHooked.has(event.sender))",
    );
    const stopAt = handler.indexOf(
      "await stopSitePreviewsForWorkspace(previousWorkspaceId);",
    );

    // MUTATION (yield before ownership): leaving the old workspace active
    // keeps its SDK authority usable during cleanup. Installing the destroyed
    // hook later can also let a dead renderer be written back into the map.
    expect(activeAt).toBeGreaterThan(-1);
    expect(cleanupHookAt).toBeGreaterThan(activeAt);
    expect(stopAt).toBeGreaterThan(cleanupHookAt);
  });

  it("stops the sender's active workspace after native activation changes the preference", () => {
    const nativeActivationStart = mainSource.indexOf(
      "function sendWorkspaceActivated",
    );
    expect(nativeActivationStart).toBeGreaterThan(-1);
    const nativeActivation = mainSource.slice(
      nativeActivationStart,
      mainSource.indexOf("\n}", nativeActivationStart),
    );
    expect(nativeActivation).toContain(
      "preferredWorkspaceId = workspace.workspaceId;",
    );

    const handlerStart = mainSource.indexOf(
      "ipcMain.handle(CHANNELS.openWorkspace",
    );
    expect(handlerStart).toBeGreaterThan(-1);
    const handler = mainSource.slice(
      handlerStart,
      mainSource.indexOf("\n  });", handlerStart),
    );
    const previousAt = handler.indexOf(
      "const previousWorkspaceId = activeWorkspaceIdBySender.get(senderId);",
    );
    const activateAt = handler.indexOf(
      "activeWorkspaceIdBySender.set(senderId, workspace.workspaceId);",
    );
    const stopAt = handler.indexOf(
      "await stopSitePreviewsForWorkspace(previousWorkspaceId);",
    );

    // MUTATION (native activation race): native activation writes destination
    // B to the global preference before the renderer opens B. The sender map
    // still names A, so cleanup must capture A from that map before installing B.
    expect(handler).not.toContain(
      "const previousWorkspaceId = preferredWorkspaceId;",
    );
    expect(previousAt).toBeGreaterThan(-1);
    expect(activateAt).toBeGreaterThan(previousAt);
    expect(stopAt).toBeGreaterThan(activateAt);
  });

  it("does not let stale start cleanup forget replacement controllers", () => {
    const beginAt = mainSource.indexOf("function beginSitePreviewStart");
    const abortAt = mainSource.indexOf(
      "function abortSitePreviewStartsForSender",
      beginAt,
    );
    expect(beginAt).toBeGreaterThan(-1);
    expect(abortAt).toBeGreaterThan(beginAt);
    const begin = mainSource.slice(beginAt, abortAt);

    // MUTATION (stale finish): abort removes the old set, then a new start can
    // store a replacement set before the old start reaches finally. The old
    // finish must not delete that replacement and make it uncancellable.
    expect(begin).toContain(
      "sitePreviewStartControllersBySender.get(senderId) === controllers",
    );
  });

  it("refuses a preview outside the sender's active workspace before it starts", () => {
    const handlerStart = mainSource.indexOf(
      "ipcMain.handle(CHANNELS.startSitePreview",
    );
    expect(handlerStart).toBeGreaterThan(-1);
    const handler = mainSource.slice(
      handlerStart,
      mainSource.indexOf("\n  });", handlerStart),
    );
    const activeWorkspaceCheckAt = handler.indexOf(
      "activeWorkspaceIdBySender.get(sender.id) !== workspace.workspaceId",
    );
    const startAt = handler.indexOf("await startPreviewForSite({");

    // MUTATION (off-workspace start): renderer teardown only knows its active
    // workspace. Without this check, another workspace's process and allowed
    // origin survive after the renderer and its SDK grant are gone.
    expect(activeWorkspaceCheckAt).toBeGreaterThan(-1);
    expect(startAt).toBeGreaterThan(activeWorkspaceCheckAt);
  });

  it("refuses to stop a preview outside the sender's active workspace", () => {
    const handlerStart = mainSource.indexOf(
      "ipcMain.handle(CHANNELS.stopSitePreview",
    );
    expect(handlerStart).toBeGreaterThan(-1);
    const handler = mainSource.slice(
      handlerStart,
      mainSource.indexOf("\n  });", handlerStart),
    );
    const earlyCheckAt = handler.indexOf(
      "assertActiveWorkspaceForSitePreviewStop(",
    );
    const lockAt = handler.indexOf("await withSitePreviewStartLock(");
    const lockedCheckAt = handler.indexOf(
      "stopSitePreviewForActiveWorkspace({",
      lockAt,
    );

    // MUTATION (off-workspace stop): a renderer active in workspace B must not
    // stop workspace A's preview, including after waiting for the site lock.
    expect(earlyCheckAt).toBeGreaterThan(-1);
    expect(lockAt).toBeGreaterThan(earlyCheckAt);
    expect(lockedCheckAt).toBeGreaterThan(lockAt);
  });

  it("aborts starts and stops previews when their renderer is destroyed", () => {
    const handlerStart = mainSource.indexOf(
      "ipcMain.handle(CHANNELS.openWorkspace",
    );
    expect(handlerStart).toBeGreaterThan(-1);
    const handler = mainSource.slice(
      handlerStart,
      mainSource.indexOf("\n  });", handlerStart),
    );
    const destroyedAt = handler.indexOf('event.sender.once("destroyed"');
    expect(destroyedAt).toBeGreaterThan(-1);
    const destroyed = handler.slice(destroyedAt);

    // MUTATION (orphaned renderer): revoking the SDK grant alone still leaves
    // the child process alive and its origin allowed when the tray keeps the
    // app running after the last workspace window closes.
    expect(destroyed).toContain(
      "abortSitePreviewStartsForSender(senderId);",
    );
    expect(destroyed).toContain(
      "void stopSitePreviewsForWorkspace(activeWorkspaceId)",
    );
  });
});
