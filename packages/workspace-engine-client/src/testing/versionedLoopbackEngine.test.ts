import { expect, it } from "vitest";
import { mergeMarkdown } from "./versionedLoopbackEngine";

// The same cases and outcomes as `crates/dohc-engine-domain/tests/differential_merge.rs`.
const CASES: [string, string, string, string | undefined][] = [
  ["base", "same", "same", "same"],
  ["base", "base", "remote", "remote"],
  ["a\nb\nc", "A\nb\nc", "a\nb\nC", "A\nb\nC"],
  ["a\nb", "local\nb", "remote\nb", undefined],
  ["a\nb", "replacement\nb", "inserted\na\nb", undefined],
  ["a\nb", "a\nb\nlocal", "a\nb\nremote", undefined],
  ["x\nx\na\nb", "x\na\nb", "x\na\nB", "x\na\nB"],
  ["\n\n\n---\n---", "\n\n---", "\n\n\n\n---", "\n\n\n---"],
  [
    "One.\n\nTwo.\n\nThree.",
    "One.\n\nLocal.\n\nTwo.\n\nThree.",
    "One.\n\nTwo.\n\nRemote.\n\nThree.",
    "One.\n\nLocal.\n\nTwo.\n\nRemote.\n\nThree.",
  ],
  ["\nB\nX\n---\n---", "\nB\n---\nX\n---", "B\nX\n\n---\nC", undefined],
  ["\nA", "\n", "B\n", undefined],
  ["", "A\n", "\nB", undefined],
  ["A\n---\n---\n---\nB", "B\n---\nA\n---\n---", "A\n---\n---\nB", undefined],
  ["One.\n\nTwo.", "New.\n\nOne.", "One.\nAdded.\nMore.\n\nTwo.", undefined],
  ["A\n---\nC\n---\nD\nE", "D\nA\n---\nC\n---\nE", "A\n---\n---\nD\nE\nC", "D\nA\n---\n---\nE\nC"],
  ["\n\nb\n---", "\n\n---", "\nLOCAL\nb\nc\n\n---", undefined],
  ["---\n---\nb", "---\nb", "---\n\nb", undefined],
  ["One.\n\nTwo.\n\nThree.", "Three.\n\nOne.\n\nTwo.", "One.\n\nTwo.", undefined],
];

it.each(CASES)("merges %j, %j and %j like the engine", (base, local, remote, expected) => {
  expect(mergeMarkdown(base, local, remote)).toEqual(
    expected === undefined ? { status: "conflict" } : { status: "merged", text: expected },
  );
});
