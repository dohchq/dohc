import { Blocks } from "lucide-react";
import { useState } from "react";
import type { PluginStatusRecord } from "../../ipc/bridgeContract";
import { assetUrl } from "../editor/imageSrc";

// A plugin's icon, or the glyph that stands for every plugin without one.
//
// The icon is an ordinary workspace file — plugins live in the workspace's
// plugins/ folder — so it loads over dohc-file:// like any other image, and
// the main process re-checks containment before serving a byte. Discovery has
// already refused an icon that is missing, oversized, or outside the plugin
// root, so `plugin.icon` is a path worth requesting. The load can still fail
// (a file deleted between discovery and this render), and a failed load falls
// back to the glyph: an icon is decoration, and decoration must never cost a
// reader the row.
export function PluginIcon(props: {
  workspaceId: string;
  plugin: PluginStatusRecord;
  glyphSize: number;
  className: string;
}) {
  const { plugin } = props;
  // The failed file, not a flag: a plugin that points at a different icon
  // gets a fresh request instead of inheriting the last one's failure.
  const [failedSource, setFailedSource] = useState<string | null>(null);
  const source = plugin.icon;
  const key = `${plugin.directoryName}/${source ?? ""}`;

  if (!source || failedSource === key) {
    return (
      <span className={props.className}>
        <Blocks size={props.glyphSize} aria-hidden />
      </span>
    );
  }

  return (
    <span className={props.className}>
      <img
        key={key}
        data-testid="plugin-icon"
        // The title sits beside the icon, so the icon repeats it rather than
        // adding anything a reader needs.
        alt=""
        src={assetUrl(
          props.workspaceId,
          `plugins/${plugin.directoryName}/${source}`,
        )}
        onError={() => setFailedSource(key)}
        className="size-full rounded-[inherit] object-contain"
      />
    </span>
  );
}
