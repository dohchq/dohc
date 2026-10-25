import * as nativePath from "node:path";

export function shortNamePairs(base: string, leaf: string, path: Pick<typeof nativePath, "join"> = nativePath) {
  return [
    { name: "short child at parent depth", parent: path.join(base, leaf), child: path.join(base, "FOLDER~1") },
    { name: "short parent at parent depth", parent: path.join(base, "FOLDER~1"), child: path.join(base, leaf) },
    { name: "short child above parent depth", parent: path.join(base, "LongFolderName", leaf), child: path.join(base, "LONGFO~1", leaf) },
    { name: "short parent above parent depth", parent: path.join(base, "LONGFO~1", leaf), child: path.join(base, "LongFolderName", leaf) },
  ];
}

export const folderIdentities = [
  { name: "same folder", inside: true, fails: false, same: true },
  { name: "different folder", inside: false, fails: false, same: false },
  { name: "unavailable identity", inside: true, fails: true, same: true },
];
