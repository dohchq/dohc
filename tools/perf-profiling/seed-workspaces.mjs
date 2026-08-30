#!/usr/bin/env node

import { mkdir, rm, writeFile } from "node:fs/promises";
import { dirname, isAbsolute, parse, relative, resolve } from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";

const DEFAULT_SEED = 0x5eedc0de;
const FULL_COUNTS = {
  largeFlatFiles: 15_000,
  flatFolderFiles: 5_000,
  largeDeepFiles: 8_000,
  drawingElements: [300, 1_500],
  editableDocBytes: 250 * 1024,
  bigDocBytes: [1, 2, 3, 4, 5].map((mib) => mib * 1024 * 1024),
};
const TINY_COUNTS = {
  largeFlatFiles: 200,
  flatFolderFiles: 100,
  largeDeepFiles: 200,
  drawingElements: [30, 100],
  editableDocBytes: 250 * 1024,
  bigDocBytes: [1, 2, 3, 4, 5].map((unit) => unit * 64 * 1024),
};

function usage() {
  return [
    "Usage: node tools/perf-profiling/seed-workspaces.mjs --output <directory> [--seed <uint32>] [--tiny]",
    "",
    "The output directory is replaced. --tiny keeps large-flat at 200 files for harness smoke runs.",
  ].join("\n");
}

function parseArgs(argv) {
  let output = null;
  let seed = DEFAULT_SEED;
  let scale = "full";
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === "--output") {
      output = argv[++index] ?? null;
    } else if (arg === "--seed") {
      const raw = argv[++index];
      seed = Number(raw);
      if (!Number.isSafeInteger(seed) || seed < 0 || seed > 0xffff_ffff) {
        throw new Error(`--seed must be an unsigned 32-bit integer, received ${raw ?? "nothing"}.`);
      }
    } else if (arg === "--tiny") {
      scale = "tiny";
    } else if (arg === "--help" || arg === "-h") {
      console.log(usage());
      process.exit(0);
    } else {
      throw new Error(`Unknown argument: ${arg}\n\n${usage()}`);
    }
  }
  if (!output) throw new Error(`--output is required.\n\n${usage()}`);
  return { output: safeOutputPath(output), scale, seed: seed >>> 0 };
}

function safeOutputPath(value) {
  const output = resolve(value);
  const root = parse(output).root;
  const cwd = resolve(process.cwd());
  const cwdFromOutput = relative(output, cwd);
  const outputContainsCwd =
    cwdFromOutput !== "" &&
    !cwdFromOutput.startsWith("..") &&
    !isAbsolute(cwdFromOutput);
  if (output === root || output === cwd || outputContainsCwd) {
    throw new Error(`Refusing to replace unsafe output directory: ${output}`);
  }
  return output;
}

function mulberry32(seed) {
  let state = seed >>> 0;
  return () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let value = state;
    value = Math.imul(value ^ (value >>> 15), value | 1);
    value ^= value + Math.imul(value ^ (value >>> 7), value | 61);
    return ((value ^ (value >>> 14)) >>> 0) / 0x1_0000_0000;
  };
}

function padded(value, width = 5) {
  return String(value).padStart(width, "0");
}

function isMarkdownIndex(index) {
  return index % 5 < 3;
}

function largeFlatPath(index, flatFolderFiles) {
  const extension = isMarkdownIndex(index) ? "md" : "txt";
  const basename = `${isMarkdownIndex(index) ? "flatnote" : "text"}-${padded(index)}.${extension}`;
  if (index < flatFolderFiles) {
    return `flat-5000/${basename}`;
  }
  const bucket = Math.floor((index - flatFolderFiles) / 100);
  return `buckets/bucket-${padded(bucket, 3)}/${basename}`;
}

function markdownFixture(path, index, markdownPaths, random) {
  const links = [];
  for (let offset = 0; offset < 3; offset += 1) {
    const target = markdownPaths[Math.floor(random() * markdownPaths.length)];
    links.push(`[[${target.slice(0, -3)}]]`);
  }
  return [
    `# Fixture ${padded(index)}`,
    "",
    `Path: \`${path}\``,
    "",
    `Links: ${links.join(" ")}`,
    "",
    `Deterministic payload ${Math.floor(random() * 0xffff_ffff).toString(16).padStart(8, "0")}.`,
    "",
  ].join("\n");
}

async function writeFiles(root, files, concurrency = 64) {
  const directories = new Set(files.map((file) => dirname(resolve(root, file.path))));
  await Promise.all([...directories].map((directory) => mkdir(directory, { recursive: true })));
  let next = 0;
  await Promise.all(
    Array.from({ length: Math.min(concurrency, files.length) }, async () => {
      while (next < files.length) {
        const index = next;
        next += 1;
        const file = files[index];
        await writeFile(resolve(root, file.path), file.contents);
      }
    }),
  );
}

async function seedLargeFlat(root, counts, random) {
  const paths = Array.from({ length: counts.largeFlatFiles }, (_, index) =>
    largeFlatPath(index, counts.flatFolderFiles),
  );
  const markdownPaths = paths.filter((_, index) => isMarkdownIndex(index));
  const files = paths.map((path, index) => ({
    path,
    contents: isMarkdownIndex(index)
      ? markdownFixture(path, index, markdownPaths, random)
      : `fixture=${padded(index)}\npath=${path}\nvalue=${Math.floor(random() * 0xffff_ffff)}\n`,
  }));
  await writeFiles(root, files);
  return { files: files.length, markdownFiles: markdownPaths.length, flatFolderFiles: counts.flatFolderFiles };
}

function deepPath(index) {
  let value = index;
  const segments = [];
  for (let depth = 1; depth <= 8; depth += 1) {
    segments.push(`level-${depth}-${value % 4}`);
    value = Math.floor(value / 4);
  }
  return `${segments.join("/")}/deep-${padded(index)}.${isMarkdownIndex(index) ? "md" : "txt"}`;
}

async function seedLargeDeep(root, counts, random) {
  const paths = Array.from({ length: counts.largeDeepFiles }, (_, index) => deepPath(index));
  const markdownPaths = paths.filter((_, index) => isMarkdownIndex(index));
  const files = paths.map((path, index) => ({
    path,
    contents: isMarkdownIndex(index)
      ? markdownFixture(path, index, markdownPaths, random)
      : `deep fixture ${padded(index)} ${Math.floor(random() * 0xffff_ffff)}\n`,
  }));
  await writeFiles(root, files);
  return { files: files.length, markdownFiles: markdownPaths.length, levels: 8 };
}

function exactMarkdownBytes(targetBytes, documentNumber) {
  const header = [
    `# Big document ${documentNumber}`,
    "",
    `[[doc-${documentNumber === 5 ? 1 : documentNumber + 1}mb]] [[../large-flat/root-00000]]`,
    "",
  ].join("\n");
  const block = [
    `## Section ${documentNumber}`,
    "",
    "A deterministic paragraph links [[doc-1mb]] to [[doc-5mb]] for graph parsing.",
    "",
  ].join("\n");
  let text = header;
  while (text.length + block.length + 1 <= targetBytes) text += block;
  text += "x".repeat(targetBytes - text.length - 1);
  return `${text}\n`;
}

async function seedBigDocs(root, counts) {
  const files = [
    {
      path: "docs/doc-250kb.md",
      contents: exactMarkdownBytes(counts.editableDocBytes, 1),
    },
    ...counts.bigDocBytes.map((bytes, index) => ({
      path: `docs/doc-${index + 1}mb.md`,
      contents: exactMarkdownBytes(bytes, index + 1),
    })),
  ];
  await writeFiles(root, files, 5);
  return {
    files: files.map((file) => ({
      path: file.path,
      bytes: Buffer.byteLength(file.contents),
    })),
  };
}

function rectangleElement(index, count, random) {
  const columns = Math.ceil(Math.sqrt(count * 1.6));
  const row = Math.floor(index / columns);
  const column = index % columns;
  const central = index === count - 1;
  const gridElementCount = count - 1;
  const gridColumns = Math.min(columns, gridElementCount);
  const gridRows = Math.ceil(gridElementCount / columns);
  const gridWidth = Math.max(24, (gridColumns - 1) * 34 + 24);
  const gridHeight = Math.max(20, (gridRows - 1) * 30 + 20);
  return {
    id: `rect-${padded(index, 4)}`,
    type: "rectangle",
    x: central ? gridWidth / 2 - 130 : column * 34,
    y: central ? gridHeight / 2 - 90 : row * 30,
    width: central ? 260 : 24,
    height: central ? 180 : 20,
    angle: 0,
    strokeColor: central ? "#e03131" : "#1e1e1e",
    backgroundColor: central ? "#ffc9c9" : "transparent",
    fillStyle: "solid",
    strokeWidth: 1,
    strokeStyle: "solid",
    roughness: 0,
    opacity: 100,
    groupIds: [],
    frameId: null,
    index: `a0${index.toString(36).padStart(4, "0")}1`,
    roundness: { type: 3 },
    seed: Math.max(1, Math.floor(random() * 0x7fff_ffff)),
    version: 1,
    versionNonce: Math.max(1, Math.floor(random() * 0x7fff_ffff)),
    isDeleted: false,
    boundElements: null,
    updated: 1_720_000_000_000,
    link: null,
    locked: false,
  };
}

async function seedDrawings(root, counts, random) {
  const files = counts.drawingElements.map((elementCount) => {
    const scene = {
      type: "excalidraw",
      version: 2,
      source: "https://excalidraw.com",
      elements: Array.from({ length: elementCount }, (_, index) =>
        rectangleElement(index, elementCount, random),
      ),
      appState: { gridSize: null, viewBackgroundColor: "#ffffff" },
      files: {},
    };
    return {
      path: `scenes/scene-${elementCount}.excalidraw`,
      contents: `${JSON.stringify(scene, null, 2)}\n`,
      elementCount,
    };
  });
  await writeFiles(root, files, 2);
  return { files: files.map(({ path, elementCount }) => ({ path, elementCount })) };
}

export async function seedProfilingWorkspaces({ output, scale, seed }) {
  const counts = scale === "tiny" ? TINY_COUNTS : FULL_COUNTS;
  const random = mulberry32(seed);
  await rm(output, { recursive: true, force: true });
  await mkdir(output, { recursive: true });

  const fixtures = {
    "large-flat": await seedLargeFlat(resolve(output, "large-flat"), counts, random),
    "large-deep": await seedLargeDeep(resolve(output, "large-deep"), counts, random),
    "big-docs": await seedBigDocs(resolve(output, "big-docs"), counts),
    drawings: await seedDrawings(resolve(output, "drawings"), counts, random),
  };
  const manifest = {
    schemaVersion: 1,
    seed,
    scale,
    fixtures,
  };
  await writeFile(resolve(output, "seed-manifest.json"), `${JSON.stringify(manifest, null, 2)}\n`);
  return manifest;
}

const scriptPath = fileURLToPath(import.meta.url);
if (process.argv[1] && resolve(process.argv[1]) === scriptPath) {
  try {
    const options = parseArgs(process.argv.slice(2));
    const manifest = await seedProfilingWorkspaces(options);
    console.log(
      `[perf-profiling] seeded ${manifest.scale} fixtures at ${options.output} ` +
        `(large-flat=${manifest.fixtures["large-flat"].files}, large-deep=${manifest.fixtures["large-deep"].files})`,
    );
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  }
}
