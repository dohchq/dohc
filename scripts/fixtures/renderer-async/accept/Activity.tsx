import { useCallback, useMemo, useRef, useState } from "react";
import { useDesktopAction, useDesktopCommand, useDesktopEvent, useDesktopLoad } from "./desktopAction";
export function Activity(p: { workspaceId: string }) {
  const [, setActivity] = useState<unknown>(null);
  useDesktopEvent([p.workspaceId], "workspaceActivity", setActivity);
  return null;
}
