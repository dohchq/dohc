import { useCallback, useMemo, useRef, useState } from "react";
import { useDesktopAction, useDesktopCommand, useDesktopEvent, useDesktopLoad } from "./desktopAction";
export function A() { const [add] = useDesktopCommand([], "addReaction", { scope: { live: () => true }, success: () => {}, failure: () => {} }); return add; }
