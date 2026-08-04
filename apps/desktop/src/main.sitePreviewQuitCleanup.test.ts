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
});
