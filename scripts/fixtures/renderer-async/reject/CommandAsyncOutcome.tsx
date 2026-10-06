import { useCallback, useMemo, useRef, useState } from "react";
import { useDesktopAction, useDesktopCommand, useDesktopEvent, useDesktopLoad } from "./desktopAction";
export function A() { return useDesktopCommand([], "revokeRelayShare", { scope: { live: () => true }, success: async () => { await Promise.resolve(); }, failure: () => {} }); }
