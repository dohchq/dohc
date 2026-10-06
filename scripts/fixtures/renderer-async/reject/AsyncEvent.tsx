import { useCallback, useMemo, useRef, useState } from "react";
import { useDesktopAction, useDesktopCommand, useDesktopEvent, useDesktopLoad } from "./desktopAction";
declare function enrich(v: unknown): Promise<unknown>;
export function A() {
  const [, setActivity] = useState<unknown>(null);
  useDesktopEvent([], "workspaceActivity", async (value: unknown) => { setActivity(await enrich(value)); });
  return null;
}
