import { useRef, type PointerEvent, type ReactNode } from "react";

const KEYBOARD_RESIZE_STEP = 0.05;

export interface EditorGroupLayoutItem {
  id: string;
  size: number;
  content: ReactNode;
}

export function EditorGroupLayout(props: {
  groups: EditorGroupLayoutItem[];
  activeGroupId: string;
  onFocusGroup: (groupId: string) => void;
  onResizeGroups: (
    leftGroupId: string,
    rightGroupId: string,
    leftSize: number,
  ) => void;
}) {
  const layoutRef = useRef<HTMLDivElement | null>(null);
  const resize = useRef<{
    pointerId: number;
    startX: number;
    width: number;
    leftGroupId: string;
    rightGroupId: string;
    leftSize: number;
    rightSize: number;
  } | null>(null);

  const resizeFromPointer = (event: PointerEvent<HTMLDivElement>) => {
    const state = resize.current;
    if (!state || state.pointerId !== event.pointerId) return;
    if ((event.buttons & 1) === 0) {
      resize.current = null;
      return;
    }
    const combined = state.leftSize + state.rightSize;
    const delta = ((event.clientX - state.startX) / state.width) * combined;
    props.onResizeGroups(
      state.leftGroupId,
      state.rightGroupId,
      state.leftSize + delta,
    );
  };

  return (
    <div
      ref={layoutRef}
      data-testid="editor-group-layout"
      className="flex min-h-0 min-w-0 flex-1"
    >
      {props.groups.map((group, index) => {
        const next = props.groups[index + 1];
        return (
          <div key={group.id} className="contents">
            <section
              data-testid={`editor-group-${group.id}`}
              data-active={group.id === props.activeGroupId || undefined}
              role="region"
              aria-label={`Editor group ${index + 1}`}
              style={{ flexGrow: group.size, flexBasis: 0 }}
              onPointerDownCapture={() => props.onFocusGroup(group.id)}
              onFocusCapture={() => props.onFocusGroup(group.id)}
              onContextMenuCapture={() => props.onFocusGroup(group.id)}
              className={`flex min-h-0 min-w-0 flex-col bg-bg ${
                group.id === props.activeGroupId ? "ring-1 ring-inset ring-ink/15" : ""
              }`}
            >
              {group.content}
            </section>
            {next ? (
              <div
                data-testid={`editor-group-resize-${group.id}-${next.id}`}
                role="separator"
                tabIndex={0}
                aria-orientation="vertical"
                aria-label="Resize editor groups"
                aria-valuemin={5}
                aria-valuemax={95}
                aria-valuenow={Math.round(
                  (group.size / (group.size + next.size)) * 100,
                )}
                onKeyDown={(event) => {
                  const direction =
                    event.key === "ArrowLeft" ? -1 : event.key === "ArrowRight" ? 1 : 0;
                  if (direction === 0) return;
                  event.preventDefault();
                  const combined = group.size + next.size;
                  const delta = combined * KEYBOARD_RESIZE_STEP * direction;
                  props.onResizeGroups(
                    group.id,
                    next.id,
                    group.size + delta,
                  );
                }}
                onPointerDown={(event) => {
                  if (event.button !== 0) return;
                  const width = layoutRef.current?.getBoundingClientRect().width ?? 0;
                  if (width <= 0) return;
                  event.preventDefault();
                  event.currentTarget.setPointerCapture(event.pointerId);
                  resize.current = {
                    pointerId: event.pointerId,
                    startX: event.clientX,
                    width,
                    leftGroupId: group.id,
                    rightGroupId: next.id,
                    leftSize: group.size,
                    rightSize: next.size,
                  };
                }}
                onPointerMove={resizeFromPointer}
                onPointerUp={() => {
                  resize.current = null;
                }}
                onPointerCancel={() => {
                  resize.current = null;
                }}
                onLostPointerCapture={() => {
                  resize.current = null;
                }}
                className="group/resize relative z-10 w-px shrink-0 cursor-col-resize bg-line outline-none before:absolute before:-left-1 before:inset-y-0 before:w-[9px] focus-visible:bg-ink/50"
              >
                <span
                  aria-hidden
                  className="absolute inset-y-0 -left-px w-[3px] bg-transparent group-hover/resize:bg-ink/25"
                />
              </div>
            ) : null}
          </div>
        );
      })}
    </div>
  );
}
