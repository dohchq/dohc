import { useCallback, useMemo, useRef, useState } from "react";
import { useDesktopAction, useDesktopCommand, useDesktopEvent, useDesktopLoad } from "./desktopAction";
import { readAndCache } from "./helpers";
export function A() { useDesktopLoad([], readAndCache, "x", { success: () => {}, failure: () => {} }); return null; }
