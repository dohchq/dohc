import type { BrowserWindow, Menu, MenuItemConstructorOptions } from "electron";

export function popupNativeMenu<Command>(input: {
  window: BrowserWindow | undefined;
  buildFromTemplate(
    template: MenuItemConstructorOptions[],
  ): Pick<Menu, "popup">;
  template(
    item: (
      label: string,
      command: Command,
      options?: MenuItemConstructorOptions,
    ) => MenuItemConstructorOptions,
  ): MenuItemConstructorOptions[];
}): Promise<Command | null> {
  return new Promise((resolve) => {
    let picked: Command | null = null;
    const menu = input.buildFromTemplate(
      input.template((label, command, options = {}) => ({
        label,
        ...options,
        click: () => {
          picked = command;
        },
      })),
    );
    menu.popup({
      window: input.window,
      // Electron can close the menu before dispatching the selected item's click.
      callback: () => setImmediate(() => resolve(picked)),
    });
  });
}
