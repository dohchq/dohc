import { useCallback, useMemo, useRef, useState } from "react";
import { useDesktopAction, useDesktopCommand, useDesktopEvent, useDesktopLoad } from "./desktopAction";
export function A() {
  const [, setX] = useState<unknown>(null);
  const applyRef = useRef(async (v: unknown) => { await Promise.resolve(); setX(v); });
  useDesktopLoad([], "readPage", {}, { success: (v: unknown) => { void applyRef.current(v); }, failure: () => {} });
  return null;
}
