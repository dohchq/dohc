import { useCallback, useMemo, useRef, useState } from "react";
import { useDesktopAction, useDesktopCommand, useDesktopEvent, useDesktopLoad } from "./desktopAction";
export function A() {
  const [, setGraph] = useState<unknown>(null);
  async function applyGraph(value: unknown) { await Promise.resolve(); setGraph(value); }
  useDesktopLoad([], "readWorkspaceGraph", { workspaceId: "A", includeChatMentions: false }, {
    success: (value: unknown) => { void applyGraph(value); },
    failure: () => {},
  });
  return null;
}
export function B() {
  function applyGraph(value: unknown) { return value; }
  void applyGraph;
  return null;
}
