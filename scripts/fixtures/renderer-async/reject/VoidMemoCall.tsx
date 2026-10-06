import { useCallback, useMemo, useRef, useState } from "react";
import { useDesktopAction, useDesktopCommand, useDesktopEvent, useDesktopLoad } from "./desktopAction";
export function A() {
  const [, setX] = useState<unknown>(null);
  const apply = useMemo(() => async (v: unknown) => { await Promise.resolve(); setX(v); }, []);
  useDesktopLoad([], "readPage", {}, { success: (v: unknown) => { void apply(v); }, failure: () => {} });
  return null;
}
