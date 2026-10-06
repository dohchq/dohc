import { useCallback, useMemo, useRef, useState } from "react";
import { useDesktopAction, useDesktopCommand, useDesktopEvent, useDesktopLoad } from "./desktopAction";
declare function follow(): Promise<unknown>;
export function A() {
  const [, setX] = useState<unknown>(null);
  useDesktopLoad([], "readPage", {}, { success: () => { follow().then(setX); }, failure: () => {} });
  return null;
}
