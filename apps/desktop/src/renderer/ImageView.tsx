import { Minus, Plus, TriangleAlert } from "lucide-react";
import { useCallback, useEffect, useRef, useState } from "react";
import { EmptyState, IconButton } from "./ui/controls";
import { SegmentedControl, type SegmentedOption } from "./ui/SegmentedControl";

type Backdrop = "checker" | "paper" | "dark";
type Zoom = "fit" | number;

const ZOOM_STEPS = [0.25, 0.5, 0.75, 1, 1.5, 2, 3, 4] as const;
const BACKDROP_OPTIONS: readonly SegmentedOption<Backdrop>[] = [
  { value: "checker", label: "Checker" },
  { value: "paper", label: "Paper" },
  { value: "dark", label: "Dark" },
];

const CHECKER_STYLE = {
  backgroundImage:
    "repeating-conic-gradient(color-mix(in srgb, var(--dohc-ink) 6%, transparent) 0 25%, transparent 0 50%)",
  backgroundSize: "16px 16px",
};

function stepZoom(current: Zoom, direction: 1 | -1): number {
  const base = current === "fit" ? 1 : current;
  if (direction > 0) {
    return ZOOM_STEPS.find((step) => step > base + 0.001) ?? ZOOM_STEPS.at(-1)!;
  }
  for (let index = ZOOM_STEPS.length - 1; index >= 0; index -= 1) {
    if (ZOOM_STEPS[index]! < base - 0.001) return ZOOM_STEPS[index]!;
  }
  return ZOOM_STEPS[0]!;
}

export function ImageView({ url, path }: { url: string; path: string }) {
  const [dims, setDims] = useState<{ w: number; h: number } | null>(null);
  const [failed, setFailed] = useState(false);
  const [backdrop, setBackdrop] = useState<Backdrop>("checker");
  const [zoom, setZoom] = useState<Zoom>("fit");
  const rootRef = useRef<HTMLDivElement | null>(null);
  const name = path.split("/").pop() ?? path;

  useEffect(() => {
    setDims(null);
    setFailed(false);
    setZoom("fit");
  }, [url]);

  const zoomIn = useCallback(() => setZoom((current) => stepZoom(current, 1)), []);
  const zoomOut = useCallback(() => setZoom((current) => stepZoom(current, -1)), []);
  const toggleFit = useCallback(() => setZoom((current) => (current === "fit" ? 1 : "fit")), []);

  useEffect(() => {
    if (failed) return;
    function onKeyDown(event: KeyboardEvent) {
      if (!(event.ctrlKey || event.metaKey) || event.altKey) return;
      const target = event.target;
      if (
        target instanceof Element &&
        target.closest('input, textarea, select, [contenteditable]:not([contenteditable="false"])')
      ) {
        return;
      }
      const root = rootRef.current;
      if (!root || root.offsetParent === null) return;
      if (event.key === "=" || event.key === "+") {
        event.preventDefault();
        zoomIn();
      } else if (event.key === "-") {
        event.preventDefault();
        zoomOut();
      } else if (event.key === "0") {
        event.preventDefault();
        setZoom("fit");
      }
    }
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [failed, zoomIn, zoomOut]);

  const frameClass =
    backdrop === "paper" ? "bg-bg dark:bg-ink" : backdrop === "dark" ? "bg-ink dark:bg-bg" : "";
  const scaled = zoom !== "fit" && dims !== null;
  const imgStyle = scaled
    ? {
        width: Math.max(1, Math.round(dims.w * zoom)),
        height: Math.max(1, Math.round(dims.h * zoom)),
      }
    : undefined;
  const zoomLabel = zoom === "fit" ? "Fit" : `${Math.round(zoom * 100)}%`;

  return (
    <div ref={rootRef} className="flex min-h-0 flex-1 flex-col bg-bg" data-testid="view-image">
      <div
        className="flex min-h-0 flex-1 items-center justify-center overflow-auto p-6"
        onWheel={(event) => {
          if (failed || !(event.ctrlKey || event.metaKey)) return;
          event.preventDefault();
          if (event.deltaY < 0) zoomIn();
          else if (event.deltaY > 0) zoomOut();
        }}
      >
        {failed ? (
          <EmptyState tone="danger" icon={TriangleAlert} title="dohc could not load this image." />
        ) : (
          <div
            data-testid="image-backdrop-frame"
            data-backdrop={backdrop}
            style={backdrop === "checker" ? CHECKER_STYLE : undefined}
            className={`flex min-h-12 min-w-12 items-center justify-center rounded border border-line p-2 ${
              zoom === "fit" ? "max-h-full max-w-full" : ""
            } ${frameClass}`}
          >
            <img
              src={url}
              alt={name}
              onClick={toggleFit}
              className={`block ${
                zoom === "fit"
                  ? "max-h-full max-w-full cursor-zoom-in object-contain"
                  : "max-w-none cursor-zoom-out"
              }`}
              style={imgStyle}
              onLoad={(e) =>
                setDims({
                  w: e.currentTarget.naturalWidth,
                  h: e.currentTarget.naturalHeight,
                })
              }
              onError={() => setFailed(true)}
            />
          </div>
        )}
      </div>
      <div className="flex shrink-0 flex-wrap items-center justify-between gap-2 border-t border-line bg-panel px-4 py-1.5 text-[12px] text-subtle">
        <span className="min-w-0 truncate tabular-nums">
          {name}
          {dims ? ` · ${dims.w}×${dims.h}` : ""}
        </span>
        {!failed ? (
          <div className="flex shrink-0 items-center gap-2">
            <div className="flex items-center gap-0.5" role="group" aria-label="Image zoom">
              <IconButton
                data-testid="image-zoom-out"
                aria-label="Zoom out"
                title="Zoom out"
                disabled={zoom !== "fit" && zoom <= ZOOM_STEPS[0]!}
                onClick={zoomOut}
              >
                <Minus size={13} aria-hidden />
              </IconButton>
              <button
                type="button"
                data-testid="image-zoom-toggle"
                aria-label="Toggle fit and 100%"
                title={zoom === "fit" ? "Show at 100%" : "Fit to view"}
                onClick={toggleFit}
                className="h-6 min-w-11 rounded-md px-1.5 text-center text-[12px] tabular-nums text-muted transition-colors hover:bg-hover hover:text-ink active:bg-selected"
              >
                {zoomLabel}
              </button>
              <IconButton
                data-testid="image-zoom-in"
                aria-label="Zoom in"
                title="Zoom in"
                disabled={zoom !== "fit" && zoom >= ZOOM_STEPS.at(-1)!}
                onClick={zoomIn}
              >
                <Plus size={13} aria-hidden />
              </IconButton>
            </div>
            <SegmentedControl
              label="Image backdrop"
              testId="image-backdrop"
              value={backdrop}
              options={BACKDROP_OPTIONS}
              onChange={setBackdrop}
            />
          </div>
        ) : null}
      </div>
    </div>
  );
}
