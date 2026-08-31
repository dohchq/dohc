import { existsSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, test } from "vitest";
import { launchReadinessTours } from "./launchReadinessManifest";

const desktopRoot = resolve(import.meta.dirname, "../..");

describe("launch readiness tour manifest", () => {
  test("keeps every critical workflow group and archetype visible", () => {
    expect(new Set(launchReadinessTours.map((tour) => tour.group))).toEqual(
      new Set(Array.from({ length: 12 }, (_, index) => index + 1)),
    );
    expect(new Set(launchReadinessTours.map((tour) => tour.archetype))).toEqual(
      new Set(["new-user", "student", "developer", "collaborator", "power-user"]),
    );
  });

  test("uses stable unique ids and names a real owning spec when automated", () => {
    const ids = launchReadinessTours.map((tour) => tour.id);
    expect(new Set(ids).size).toBe(ids.length);

    for (const tour of launchReadinessTours) {
      expect(tour.workflow.trim()).not.toBe("");
      expect(tour.expectedResult.trim()).not.toBe("");
      expect(tour.performanceMarks.length).toBeGreaterThan(0);
      for (const mark of tour.performanceMarks) {
        expect(mark.trim()).not.toBe("");
        expect(mark).not.toContain(" and ");
      }
      if (tour.automatedBy) {
        expect(existsSync(resolve(desktopRoot, tour.automatedBy)), tour.id).toBe(true);
      }
    }
  });

  test("does not hide manual and conflict-fenced work", () => {
    expect(launchReadinessTours.some((tour) => tour.automatedBy === null)).toBe(true);
    expect(launchReadinessTours.some((tour) => tour.conflictFence === "share-links")).toBe(
      true,
    );
    expect(launchReadinessTours.some((tour) => tour.conflictFence === "notion-parity")).toBe(
      true,
    );
  });
});
