import { useCallback, useMemo, useRef, useState } from "react";
import { useDesktopAction, useDesktopCommand, useDesktopEvent, useDesktopLoad } from "./desktopAction";
export function A() {
  const [, setX] = useState<unknown>(null);
  const onValue = (v: unknown) => { setX(v); };
  useDesktopLoad([], "readPage", {}, { success: onValue, failure: () => {} });
  return null;
}
export function B() {
  const [, setY] = useState<unknown>(null);
  const onValue = async (v: unknown) => { await Promise.resolve(); setY(v); };
  void onValue;
  return null;
}
