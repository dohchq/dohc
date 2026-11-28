import { Asset } from "expo-asset";
import { Directory, File, Paths } from "expo-file-system";
import { sketchAssets, sketchVersion } from "./sketchAssets.generated";

const folder = new Directory(Paths.cache, `sketch-${sketchVersion}`);
const htmlFile = new File(folder, "sketch.html");
let pending: Promise<string> | null = null;

export function sketchHtmlUri(): Promise<string> {
  pending ??= (async () => {
    try {
      if (!folder.exists) folder.create({ intermediates: true });
      for (const entry of sketchAssets) {
        const destination = new File(folder, entry.target);
        if (destination.exists) continue;
        const slash = entry.target.lastIndexOf("/");
        if (slash > 0) {
          const parent = new Directory(folder, entry.target.slice(0, slash));
          if (!parent.exists) parent.create({ intermediates: true });
        }
        const asset = Asset.fromModule(entry.module);
        await asset.downloadAsync();
        const sourceUri = asset.localUri ?? asset.uri;
        if (!sourceUri) throw new Error(`Missing sketch asset ${entry.target}.`);
        await new File(sourceUri).copy(destination);
      }
      return htmlFile.uri;
    } catch (error) {
      try {
        if (folder.exists) folder.delete();
      } catch {}
      throw error;
    }
  })().finally(() => {
    pending = null;
  });
  return pending;
}

export const sketchFolderUri = folder.uri;
