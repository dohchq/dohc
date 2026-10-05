// Pure renderer workload for PR 1. Packaged admission and timing remain separate.
export const GO_TO_COUNTS = Object.freeze({ files: 5000, folders: 50, collections: 20, apps: 20, versions: 20, groups: 20,
  namedThreads: 40, dms: 7, people: 9, agents: 18, commands: 27, pluginWebApps: 0 });

export function goToIndexFixture(fileCount = GO_TO_COUNTS.files) {
  if (!Number.isSafeInteger(fileCount) || fileCount < 2) throw new Error("files must be an integer of at least two");
  const folders = [
    ...Array.from({ length: 20 }, (_, i) => "collection-" + i),
    ...Array.from({ length: 20 }, (_, i) => "app-" + i),
    "src", ...Array.from({ length: 7 }, (_, i) => "src/module-" + i),
    "shared-with-me", "shared-with-me/team",
  ];
  const fileFolders = folders.filter(path => path !== "shared-with-me");
  const files = [{ path: "small.md", kind: "file" }, { path: "large.md", kind: "file" }];
  for (let n = 2; n < fileCount; n++) files.push({
    path: fileFolders[n % fileFolders.length] + "/fixture-" + String(n).padStart(6, "0") + (n % 3 === 0 && n !== 4242 ? ".ts" : ".txt"), kind: "file",
  });
  return {
    listing: { files, folders, visibility: { status: "ready", hiddenHostPaths: new Set() },
      receivedRoots: [{ path: "shared-with-me/team", ended: false, damaged: false }] },
    collections: folders.slice(0, 20).map((path, i) => ({ path, objectId: "collection-" + i })),
    apps: folders.slice(20, 40).map((root, i) => ({ root, title: "Fixture app " + i })),
    versions: Array.from({ length: 20 }, (_, i) => ({ id: "version-" + i, name: i === 0 ? "Main" : "Fixture version " + i })),
    groups: Array.from({ length: 20 }, (_, i) => ({ id: "group-" + i, name: i === 0 ? "General" : "Fixture Group " + i, kind: "channel" })),
  };
}
