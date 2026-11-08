import { expect, test } from "@playwright/test";
import { launchDesktopApp } from "./helpers/desktopApp";
import { cleanupDesktopWorkspace, createTempWorkspace } from "./helpers/workspace";

const seconds = (value: string) => Number.parseFloat(value) / (value.endsWith("ms") ? 1000 : 1);

// Under reduced motion a transition ends at once, so a colour change starts
// none. An animation keeps a tiny length, so menus and dialogs still get
// animationend. Both ways the renderer learns the preference are checked: the
// media query, and the native value it reads on Linux.
test("reduced motion ends transitions at once and keeps animations ending", async () => {
  const temp = await createTempWorkspace();
  let desktop: Awaited<ReturnType<typeof launchDesktopApp>> | null = null;
  try {
    desktop = await launchDesktopApp({ workspace: temp });
    const page = desktop.page;
    await expect(page.getByTestId("first-run-open-share")).toBeVisible();

    // The Linux poll rewrites the native attribute between tasks, so each
    // read sets it, computes, and puts it back in one task.
    const durations = async (native: "true" | null) => {
      const read = await page.evaluate((native) => {
        const root = document.documentElement;
        const previous = root.dataset.systemReducedMotion;
        if (native === null) delete root.dataset.systemReducedMotion;
        else root.dataset.systemReducedMotion = native;
        const probe = document.createElement("div");
        probe.style.transition = "color 1s";
        probe.style.animation = "reduced-motion-probe 1s";
        document.body.append(probe);
        const style = getComputedStyle(probe);
        const result = { transition: style.transitionDuration, animation: style.animationDuration };
        probe.remove();
        if (previous === undefined) delete root.dataset.systemReducedMotion;
        else root.dataset.systemReducedMotion = previous;
        return result;
      }, native);
      return { transition: seconds(read.transition), animation: seconds(read.animation) };
    };
    const reduced = (read: { transition: number; animation: number }) => {
      expect(read.transition, "reduced-motion transition").toBe(0);
      expect(read.animation).toBeGreaterThan(0);
      expect(read.animation).toBeLessThan(0.001);
    };

    await page.emulateMedia({ reducedMotion: "no-preference" });
    expect(await durations(null)).toEqual({ transition: 1, animation: 1 });
    reduced(await durations("true"));
    await page.emulateMedia({ reducedMotion: "reduce" });
    reduced(await durations(null));
  } finally {
    if (desktop) await cleanupDesktopWorkspace(desktop, temp);
    else await temp.cleanup();
  }
});
