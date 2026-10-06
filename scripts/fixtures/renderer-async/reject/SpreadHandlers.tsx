import { useCallback, useMemo, useRef, useState } from "react";
import { useDesktopAction, useDesktopCommand, useDesktopEvent, useDesktopLoad } from "./desktopAction";
declare const handlers: { success(v: unknown): void; failure(e: unknown): void };
export function A() { useDesktopLoad([], "readPage", {}, { ...handlers }); return null; }
