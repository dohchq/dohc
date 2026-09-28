import { useRef, type PointerEvent, type ReactNode } from "react";
import { clampEditorGroupPairLeftSize } from "./workbenchState";
import { useCommitOnRelease } from "./useCommitOnRelease";

const KEYBOARD_RESIZE_STEP = 0.05;

interface EditorGroupLayoutItem {
  id: string;
  size: number;
  content: ReactNode;
}

interface EditorGroupResizePreview {
  leftGroupId: string;
  rightGroupId: string;
  leftSize: number;
  rightSize: number;
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
    pairSize: number;
    totalSize: number;
  } | null>(null);
  const resizeCommit = useCommitOnRelease<EditorGroupResizePreview>((value) =>
    props.onResizeGroups(value.leftGroupId, value.rightGroupId, value.leftSize),
  );
  const groups = props.groups.map((group) => {
    const preview = resizeCommit.previewValue;
    if (group.id === preview?.leftGroupId) return { ...group, size: preview.leftSize };
    if (group.id === preview?.rightGroupId) {
      return { ...group, size: preview.rightSize };
    }
    return group;
  });

  const resizeFromPointer = (event: PointerEvent<HTMLDivElement>) => {
    const state = resize.current;
    if (!state || !resizeCommit.isActive(event.pointerId)) return;
    const delta =
      ((event.clientX - state.startX) / state.width) * state.totalSize;
    const leftSize = clampEditorGroupPairLeftSize(
      state.pairSize,
      state.leftSize + delta,
    );
    resizeCommit.update(
      event.pointerId,
      {
        leftGroupId: state.leftGroupId,
        rightGroupId: state.rightGroupId,
        leftSize,
        rightSize: state.pairSize - leftSize,
      },
      event.buttons,
    );
  };

  return (
    <div
      ref={layoutRef}
      data-testid="editor-group-layout"
      className="flex min-h-0 min-w-0 flex-1"
    >
      {groups.map((group, index) => {
        const next = groups[index + 1];
        return (
          <div key={group.id} className="contents">
            <section
              data-testid={`editor-group-${group.id}`}
              data-editor-group-id={group.id}
              data-focus-surface="editor"
              tabIndex={-1}
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
                  const pairSize = group.size + next.size;
                  resizeCommit.begin(event.pointerId, {
                    leftGroupId: group.id,
                    rightGroupId: next.id,
                    leftSize: group.size,
                    rightSize: next.size,
                  });
                  resize.current = {
                    pointerId: event.pointerId,
                    startX: event.clientX,
                    width,
                    leftGroupId: group.id,
                    rightGroupId: next.id,
                    leftSize: group.size,
                    pairSize,
                    totalSize: groups.reduce(
                      (sum, candidate) => sum + candidate.size,
                      0,
                    ),
                  };
                }}
                onPointerMove={resizeFromPointer}
                onPointerUp={(event) => resizeCommit.commit(event.pointerId)}
                onPointerCancel={(event) => resizeCommit.commit(event.pointerId)}
                onLostPointerCapture={(event) =>
                  resizeCommit.commit(event.pointerId)
                }
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
