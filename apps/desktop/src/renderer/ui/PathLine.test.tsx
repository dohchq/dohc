// @vitest-environment jsdom
import { render } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { PathLine, pathPieces, splitPath } from "./PathLine";

describe("splitPath", () => {
  it("keeps a root alone as the first folder", () => {
    expect(splitPath("C:\\")).toEqual({ first: "C:\\", middle: "", name: "" });
    expect(splitPath("/")).toEqual({ first: "/", middle: "", name: "" });
  });

  it("splits one folder into the root and the name", () => {
    expect(splitPath("C:\\Personal")).toEqual({ first: "C:\\", middle: "", name: "Personal" });
    expect(splitPath("/Personal")).toEqual({ first: "/", middle: "", name: "Personal" });
  });

  it("keeps the first folder and the name, with every folder between them in the middle", () => {
    expect(splitPath("C:\\Users\\sam\\home\\dohc\\Personal")).toEqual({
      first: "C:\\",
      middle: "Users\\sam\\home\\dohc\\",
      name: "Personal",
    });
    expect(splitPath("/home/sam/dohc/Personal")).toEqual({ first: "/home/", middle: "sam/dohc/", name: "Personal" });
    expect(splitPath("/home/Personal")).toEqual({ first: "/home/", middle: "", name: "Personal" });
    expect(splitPath("\\\\server\\share\\Trips\\Lisbon")).toEqual({
      first: "\\\\server\\",
      middle: "share\\Trips\\",
      name: "Lisbon",
    });
  });

  it("splits a POSIX path on / only, so a backslash stays in its name", () => {
    expect(splitPath("/home/sam/a\\b")).toEqual({ first: "/home/", middle: "sam/", name: "a\\b" });
  });
});

describe("pathPieces", () => {
  it("cuts after every separator and joins back into the path", () => {
    const posix = "/home/user/.nvm/versions/node/v24.16.0/bin/claude";
    expect(pathPieces(posix)).toEqual(["/", "home/", "user/", ".nvm/", "versions/", "node/", "v24.16.0/", "bin/", "claude"]);
    expect(pathPieces(posix).join("")).toBe(posix);
    const windows = "C:\\Users\\sam\\AppData\\Roaming\\npm\\codex.cmd";
    expect(pathPieces(windows)).toEqual(["C:\\", "Users\\", "sam\\", "AppData\\", "Roaming\\", "npm\\", "codex.cmd"]);
    expect(pathPieces(windows).join("")).toBe(windows);
  });

  it("keeps a backslash inside a POSIX name", () => {
    expect(pathPieces("/home/sam/a\\b")).toEqual(["/", "home/", "sam/", "a\\b"]);
  });
});

describe("PathLine", () => {
  it("reads as the whole path, with the middle folders laid out from the right", () => {
    const { container } = render(<PathLine path="C:\Users\sam\dohc\Personal" />);
    expect(container.textContent).toBe("C:\\Users\\sam\\dohc\\Personal");
    expect(container.querySelector('[dir="rtl"]')?.textContent).toBe("Users\\sam\\dohc\\");
  });

  it("has no middle to cut when no folder sits between the first and the name", () => {
    const { container } = render(<PathLine path="/home/Personal" />);
    expect(container.textContent).toBe("/home/Personal");
    expect(container.querySelector('[dir="rtl"]')).toBeNull();
  });
});
