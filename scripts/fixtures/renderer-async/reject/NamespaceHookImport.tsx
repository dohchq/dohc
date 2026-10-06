import * as desktop from "./desktopAction";
export function A() { desktop.useDesktopLoad([], "readPage", {}, { success: async () => {}, failure: () => {} }); return null; }
