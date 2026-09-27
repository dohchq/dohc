import { useEffect, useRef, useState } from "react";
import { useRequestSequence } from "../useRequestSequence";

export function CopyButton(props: {
  getText: () => string | Promise<string> | null;
  testId: string;
}) {
  const [label, setLabel] = useState<"Copy" | "Copied" | "Couldn't copy">("Copy");
  const requests = useRequestSequence();
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  useEffect(() => () => {
    if (timer.current) clearTimeout(timer.current);
  }, []);

  async function copy() {
    const clipboard = navigator.clipboard;
    if (!clipboard) return;
    const request = requests.next();
    try {
      const text = await props.getText();
      if (text === null || !requests.isCurrent(request)) return;
      await clipboard.writeText(text);
      if (!requests.isCurrent(request)) return;
      setLabel("Copied");
    } catch {
      if (!requests.isCurrent(request)) return;
      setLabel("Couldn't copy");
    }
    if (timer.current) clearTimeout(timer.current);
    timer.current = setTimeout(() => setLabel("Copy"), 1200);
  }

  return (
    <button
      type="button"
      data-testid={props.testId}
      onClick={() => void copy()}
      className="rounded-md border border-line px-2 py-0.5 text-[11px] text-muted transition-colors hover:bg-hover hover:text-ink"
    >
      {label}
    </button>
  );
}
