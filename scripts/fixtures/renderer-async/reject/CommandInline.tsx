import { useCallback, useMemo, useRef, useState } from "react";
import { useDesktopAction, useDesktopCommand, useDesktopEvent, useDesktopLoad } from "./desktopAction";
export function A() { return useDesktopCommand([], async (desktop: any, input: { shareId: string }) => desktop.revokeRelayShare(input), { scope: { live: () => true }, success: () => {}, failure: () => {} }); }
