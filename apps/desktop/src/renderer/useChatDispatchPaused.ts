import { useEffect, useRef, useState } from "react";
import { bridge } from "./bridge";

// Whether agent dispatch is paused on this computer. Main pushes each change,
// whether a window or the tray made it, and a pushed answer is newer than the
// first read.
export function useChatDispatchPaused(onReadError: (error: unknown) => void): boolean {
  const [paused, setPaused] = useState(false);
  const onReadErrorRef = useRef(onReadError);
  onReadErrorRef.current = onReadError;
  useEffect(() => {
    let live = true;
    let heard = false;
    const stopListening = bridge().onChatDispatchPaused((event) => {
      heard = true;
      if (live) setPaused(event.paused);
    });
    void bridge().readChatDispatchPaused({}).then((event) => {
      if (live && !heard) setPaused(event.paused);
    }, (error: unknown) => {
      if (live) onReadErrorRef.current(error);
    });
    return () => {
      live = false;
      stopListening();
    };
  }, []);
  return paused;
}
