import { useCallback, useMemo, useRef, useState } from "react";
import { useDesktopAction, useDesktopCommand, useDesktopEvent, useDesktopLoad } from "./desktopAction";
export function A() {
  const [, setX] = useState<unknown>(null);
  function apply(v: unknown) { setX(v); }
  useDesktopLoad([], "readPage", {}, { success: (v: unknown) => { apply(v); }, failure: () => {} });
  return null;
}
export function B() { const apply = async () => {}; void apply; return null; }
