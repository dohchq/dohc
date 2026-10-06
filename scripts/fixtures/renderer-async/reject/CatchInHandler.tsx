import { useCallback, useMemo, useRef, useState } from "react";
import { useDesktopAction, useDesktopCommand, useDesktopEvent, useDesktopLoad } from "./desktopAction";
declare function report(e: unknown): Promise<void>;
export function A() {
  useDesktopLoad([], "readPage", {}, { success: () => {}, failure: (e: unknown) => { report(e).catch(() => {}); } });
  return null;
}
