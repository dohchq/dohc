import { readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";

// Input: CaseFolding.txt and DerivedCoreProperties.txt from this pinned UCD.
const source = "https://www.unicode.org/Public/17.0.0/ucd/";
const directory = process.argv[2];
if (!directory) throw new Error("Provide the directory containing the Unicode 17.0.0 data files");
const read = (name) => readFileSync(resolve(directory, name), "utf8");
const mappings = {};
for (const line of read("CaseFolding.txt").split(/\r?\n/)) {
  const [code, status, mapping] = line.split(";").map((part) => part.trim());
  if (status !== "C" && status !== "F") continue;
  mappings[String.fromCodePoint(parseInt(code, 16))] = String.fromCodePoint(
    ...mapping.split(" ").map((value) => parseInt(value, 16)),
  );
}
const ignorables = [];
for (const line of read("DerivedCoreProperties.txt").split(/\r?\n/)) {
  const [range, property] = line.split("#", 1)[0].split(";").map((part) => part.trim());
  if (property !== "Default_Ignorable_Code_Point") continue;
  const [start, end = start] = range.split("..").map((value) => parseInt(value, 16));
  const previous = ignorables.at(-1);
  if (previous && previous[1] + 1 === start) previous[1] = end;
  else ignorables.push([start, end]);
}
writeFileSync(new URL("../packages/workspace-contracts/src/pathFoldData.json", import.meta.url),
  `${JSON.stringify({ source, license: "https://www.unicode.org/license.txt", mappings, ignorables }, null, 2)}\n`);
