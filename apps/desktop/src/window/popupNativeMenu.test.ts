import { describe, expect, it } from "vitest";
import { popupNativeMenu } from "./popupNativeMenu";

describe("native menu selection", () => {
  it("waits for a clicked item even when the popup closes first", async () => {
    const chosen = popupNativeMenu({
      window: undefined,
      template: (item) => [item("Copy", "copy")],
      buildFromTemplate: (template) => ({
        popup(options) {
          options?.callback?.();
          const click = template[0]?.click;
          // Electron supplies the arguments; the selection handler does not use them.
          Reflect.apply(click!, undefined, []);
        },
      }),
    });
    await expect(chosen).resolves.toBe("copy");
  });

  it("returns null when the menu closes without a selection", async () => {
    await expect(
      popupNativeMenu({
        window: undefined,
        template: (item) => [item("Copy", "copy", { enabled: false })],
        buildFromTemplate: (template) => ({
          popup(options) {
            expect(template[0]?.enabled).toBe(false);
            options?.callback?.();
          },
        }),
      }),
    ).resolves.toBeNull();
  });
});
