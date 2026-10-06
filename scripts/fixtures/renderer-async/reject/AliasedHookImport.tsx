import { useDesktopLoad as load } from "./desktopAction";
export function A() { load([], "readPage", {}, { success: async () => {}, failure: () => {} }); return null; }
