import { useCallback, useMemo, useRef, useState } from "react";
import { useDesktopAction, useDesktopCommand, useDesktopEvent, useDesktopLoad } from "./desktopAction";
export function A() {
  const [, setX] = useState<unknown>(null);
  const helpers = { async apply(v: unknown) { await Promise.resolve(); setX(v); } };
  useDesktopLoad([], "readPage", {}, { success: (v: unknown) => { void helpers.apply(v); }, failure: () => {} });
  return null;
}
