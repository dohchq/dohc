import { useCallback, useMemo, useRef, useState } from "react";
import { useDesktopAction, useDesktopCommand, useDesktopEvent, useDesktopLoad } from "./desktopAction";
export function A(p: { save: (v: unknown) => Promise<void> }) {
  function save(v: unknown) { return v; }
  void save;
  return function Inner({ save }: { save: (v: unknown) => Promise<void> }) {
    useDesktopLoad([], "readPage", {}, { success: (v: unknown) => { void save(v); }, failure: () => {} });
    return p;
  };
}
