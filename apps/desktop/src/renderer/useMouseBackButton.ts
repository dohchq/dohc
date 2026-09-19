import { useEffect } from "react";

// Chromium reports the mouse's back button (XButton1) as button 3.
const BACK_BUTTON = 3;

// Makes the mouse's back button do what the route's Back control does. Pass
// undefined while that control is absent or disabled, so the two never
// disagree about whether leaving is allowed.
export function useMouseBackButton(onBack: (() => void) | undefined): void {
  useEffect(() => {
    if (!onBack) return;
    const onMouseUp = (event: MouseEvent) => {
      if (event.button !== BACK_BUTTON) return;
      event.preventDefault();
      onBack();
    };
    window.addEventListener("mouseup", onMouseUp);
    return () => window.removeEventListener("mouseup", onMouseUp);
  }, [onBack]);
}
