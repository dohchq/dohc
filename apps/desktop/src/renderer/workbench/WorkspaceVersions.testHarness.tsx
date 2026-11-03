import type { ComponentProps } from "react";
import { VersionMenu, type WorkspaceVersionsOptions, useWorkspaceVersions } from "./WorkspaceVersions";

// The titlebar menu as the shell mounts it: one versions controller, the menu
// while capture is on, and the controller's dialogs. Capture is on unless a
// test turns it off.
export function VersionMenuHarness(
  props: Omit<WorkspaceVersionsOptions, "enabled"> & Omit<ComponentProps<typeof VersionMenu>, "versions"> & { enabled?: boolean },
) {
  const enabled = props.enabled ?? true;
  const versions = useWorkspaceVersions({ ...props, enabled });
  return (
    <>
      {enabled ? (
        <VersionMenu
          versions={versions}
          disabled={props.disabled}
          onOpenCompare={props.onOpenCompare}
          {...(props.onOpenAllVersions ? { onOpenAllVersions: props.onOpenAllVersions } : {})}
          {...(props.onShareVersion ? { onShareVersion: props.onShareVersion } : {})}
        />
      ) : null}
      {versions.dialogs}
    </>
  );
}
