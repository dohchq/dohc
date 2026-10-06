import { useCallback, useMemo, useRef, useState } from "react";
import { useDesktopAction, useDesktopCommand, useDesktopEvent, useDesktopLoad } from "./desktopAction";
import { onPage } from "./helpers";
export function A() { useDesktopLoad([], "readPage", {}, { success: onPage, failure: () => {} }); return null; }
