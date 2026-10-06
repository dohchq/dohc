import { useCallback, useMemo, useRef, useState } from "react";
import { useDesktopAction, useDesktopCommand, useDesktopEvent, useDesktopLoad } from "./desktopAction";
export function A() {
  const delivery = useMemo(() => ({ success: async () => {}, failure: () => {} }), []);
  useDesktopLoad([], "readPage", {}, delivery);
  return null;
}
