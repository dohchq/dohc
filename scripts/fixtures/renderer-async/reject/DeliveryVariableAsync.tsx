import { useCallback, useMemo, useRef, useState } from "react";
import { useDesktopAction, useDesktopCommand, useDesktopEvent, useDesktopLoad } from "./desktopAction";
declare function followUp(): Promise<void>;
export function A() {
  const [, setPage] = useState<unknown>(null);
  const delivery = { success: async (value: unknown) => { await followUp(); setPage(value); }, failure() {} };
  useDesktopLoad([], "readPage", {}, delivery);
  return null;
}
