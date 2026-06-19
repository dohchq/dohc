import { mkdir, mkdtemp, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { beforeEach, describe, expect, it } from "vitest";
import {
  buildMarkdownGraph,
  extractMarkdownGraphLinks,
  readWorkspaceGraph,
} from "./workspaceGraph";

let root: string;

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), "dohc-graph-"));
});

describe("extractMarkdownGraphLinks", () => {
  it("extracts wikilinks and local markdown links while skipping code and images", () => {
    expect(
      extractMarkdownGraphLinks(
        [
          "[[Alpha|friendly title]]",
          "![[diagram.png]]",
          "[[#Heading]]",
          "[[attachment.pdf]]",
          "[beta](docs/beta.md)",
          "[external](https://example.com)",
          "[pdf](attachments/brief.pdf)",
          "[csv](data/table.csv)",
          "[extensionless](Daily%20Note)",
          "[parenthesized](docs/ADR(draft).md)",
          "![image](media/photo.png)",
          "`[[Ignored]]`",
          "   ```",
          "[indented-code](ignored.md)",
          "   ```",
          "```",
          "[ignored](secret.md)",
          "```",
          "````",
          "```",
          "[inner-fence](ignored.md)",
          "```",
          "[four-fence](also-ignored.md)",
          "````",
          "    [indented-code](also-ignored.md)",
          "``[inline-code](also-ignored.md)``",
          "[real](after-code.md)",
        ].join("\n"),
      ),
    ).toEqual([
      { kind: "wikilink", target: "Alpha" },
      { kind: "wikilink", target: "attachment.pdf" },
      { kind: "markdown", target: "docs/beta.md" },
      { kind: "markdown", target: "attachments/brief.pdf" },
      { kind: "markdown", target: "data/table.csv" },
      { kind: "markdown", target: "Daily%20Note" },
      { kind: "markdown", target: "docs/ADR(draft).md" },
      { kind: "markdown", target: "after-code.md" },
    ]);
  });

  it("closes fenced code blocks when markdown uses CRLF line endings", () => {
    expect(
      extractMarkdownGraphLinks(
        ["```", "[ignored](secret.md)", "```", "[real](after-code.md)"].join(
          "\r\n",
        ),
      ),
    ).toEqual([{ kind: "markdown", target: "after-code.md" }]);
  });
});

describe("buildMarkdownGraph", () => {
  it("resolves wikilinks by title stem and markdown links relative to the source file", () => {
    const graph = buildMarkdownGraph([
      {
        path: "notes/alpha.md",
        text: "# Alpha\n[[Beta]]\n[Gamma](../refs/gamma.md)\n[external](https://example.com)\n",
      },
      { path: "notes/beta.md", text: "# Beta\n[[Missing]]\n" },
      { path: "refs/gamma.md", text: "# Gamma\n[Alpha](../notes/alpha.md)\n" },
    ]);

    expect(graph.nodes).toMatchObject([
      { path: "notes/alpha.md", title: "Alpha", outgoing: 2, incoming: 1 },
      { path: "notes/beta.md", title: "Beta", outgoing: 0, incoming: 1 },
      { path: "refs/gamma.md", title: "Gamma", outgoing: 1, incoming: 1 },
    ]);
    expect(graph.edges).toEqual([
      { source: "notes/alpha.md", target: "notes/beta.md", kind: "wikilink" },
      { source: "notes/alpha.md", target: "refs/gamma.md", kind: "markdown" },
      { source: "refs/gamma.md", target: "notes/alpha.md", kind: "markdown" },
    ]);
    expect(graph.unresolvedLinks).toBe(1);
  });

  it("treats dotted extensionless note links as local markdown targets", () => {
    const graph = buildMarkdownGraph([
      { path: "v1.0.md", text: "# Release Notes\n" },
      { path: "docs/release.v1.0.md", text: "# Docs Release\n" },
      { path: "source.md", text: "# Source\n[[v1.0]]\n[Release](docs/release.v1.0)\n" },
    ]);

    expect(graph.edges).toEqual([
      { source: "source.md", target: "docs/release.v1.0.md", kind: "markdown" },
      { source: "source.md", target: "v1.0.md", kind: "wikilink" },
    ]);
    expect(graph.unresolvedLinks).toBe(0);
  });

  it("resolves markdown links to files with balanced parentheses in the name", () => {
    const graph = buildMarkdownGraph([
      { path: "docs/ADR(draft).md", text: "# Draft ADR\n" },
      { path: "source.md", text: "# Source\n[Spec](docs/ADR(draft).md)\n" },
    ]);

    expect(graph.edges).toEqual([
      { source: "source.md", target: "docs/ADR(draft).md", kind: "markdown" },
    ]);
    expect(graph.unresolvedLinks).toBe(0);
  });

  it("resolves markdown links with escaped spaces and parentheses", () => {
    const graph = buildMarkdownGraph([
      { path: "Project Plan.md", text: "# Plan\n" },
      { path: "docs/ADR(draft).md", text: "# Draft ADR\n" },
      {
        path: "source.md",
        text: "# Source\n[Plan](Project\\ Plan.md)\n[ADR](docs/ADR\\(draft\\).md)\n",
      },
    ]);

    expect(graph.edges).toEqual([
      { source: "source.md", target: "docs/ADR(draft).md", kind: "markdown" },
      { source: "source.md", target: "Project Plan.md", kind: "markdown" },
    ]);
    expect(graph.unresolvedLinks).toBe(0);
  });

  it("includes non-markdown files as nodes and resolves links to them", () => {
    const graph = buildMarkdownGraph(
      [
        {
          path: "notes/source.md",
          text: "# Source\n[Table](../data/table.csv)\n[[Plain]]\n",
        },
      ],
      {
        allPaths: [
          "data/table.csv",
          "notes/plain.txt",
          "notes/source.md",
        ],
      },
    );

    expect(graph.nodes).toMatchObject([
      { path: "data/table.csv", title: "table.csv", outgoing: 0, incoming: 1 },
      { path: "notes/plain.txt", title: "plain.txt", outgoing: 0, incoming: 1 },
      { path: "notes/source.md", title: "Source", outgoing: 2, incoming: 0 },
    ]);
    expect(graph.edges).toEqual([
      { source: "notes/source.md", target: "data/table.csv", kind: "markdown" },
      { source: "notes/source.md", target: "notes/plain.txt", kind: "wikilink" },
    ]);
  });

  it("treats ambiguous basename wikilinks as unresolved instead of guessing", () => {
    const graph = buildMarkdownGraph([
      { path: "a/shared.md", text: "# Shared A\n" },
      { path: "b/shared.md", text: "# Shared B\n" },
      { path: "index.md", text: "[[Shared]]\n" },
    ]);

    expect(graph.edges).toEqual([]);
    expect(graph.unresolvedLinks).toBe(1);
  });

  it("keeps ambiguous root fallback wikilinks unresolved instead of guessing", () => {
    const graph = buildMarkdownGraph([
      { path: "shared.md", text: "# Root Shared\n" },
      { path: "archive/shared.md", text: "# Archived Shared\n" },
      { path: "notes/source.md", text: "[[Shared]]\n" },
    ]);

    expect(graph.edges).toEqual([]);
    expect(graph.unresolvedLinks).toBe(1);
  });

  it("prefers workspace-root targets for root-relative markdown links", () => {
    const graph = buildMarkdownGraph([
      { path: "root.md", text: "# Root\n" },
      { path: "notes/root.md", text: "# Nested Root\n" },
      { path: "notes/source.md", text: "# Source\n[Root](/root.md)\n" },
    ]);

    expect(graph.edges).toEqual([
      { source: "notes/source.md", target: "root.md", kind: "markdown" },
    ]);
  });

  it("does not fall back to the workspace root for source-relative markdown links", () => {
    const graph = buildMarkdownGraph([
      { path: "todo.md", text: "# Root Todo\n" },
      { path: "notes/source.md", text: "# Source\n[Todo](todo.md)\n" },
    ]);

    expect(graph.edges).toEqual([]);
    expect(graph.unresolvedLinks).toBe(1);
  });

  it("hides valid self-links without reporting them as unresolved", () => {
    const graph = buildMarkdownGraph([
      { path: "notes/this.md", text: "# This\n[This](./this.md)\n[[This]]\n" },
    ]);

    expect(graph.edges).toEqual([]);
    expect(graph.unresolvedLinks).toBe(0);
  });

  it("caps dense resolved links before the IPC result validator rejects them", () => {
    const docs = Array.from({ length: 102 }, (_, index) => {
      const name = `doc-${String(index).padStart(3, "0")}`;
      const links = Array.from({ length: 102 }, (_, target) =>
        target === index ? "" : `[[doc-${String(target).padStart(3, "0")}]]`,
      )
        .filter(Boolean)
        .join("\n");
      return {
        path: `${name}.md`,
        text: `# ${name}\n${links}\n`,
      };
    });

    const graph = buildMarkdownGraph(docs);
    expect(graph.edges).toHaveLength(10000);
  });

  it("caps unresolved link processing across the whole workspace graph", () => {
    const docs = Array.from({ length: 30 }, (_, index) => ({
      path: `source-${String(index).padStart(2, "0")}.md`,
      text: Array.from(
        { length: 1000 },
        (_, linkIndex) => `[[missing-${index}-${linkIndex}]]`,
      ).join("\n"),
    }));

    const graph = buildMarkdownGraph(docs);
    expect(graph.edges).toEqual([]);
    expect(graph.unresolvedLinks).toBe(20000);
  });
});

describe("readWorkspaceGraph", () => {
  it("includes all real files from the workspace listing", async () => {
    await mkdir(join(root, ".dohc"), { recursive: true });
    await mkdir(join(root, "notes"), { recursive: true });
    await writeFile(join(root, ".dohc", "hidden.md"), "[[Visible]]");
    await writeFile(join(root, "index.md"), "[[Visible]]\n");
    await writeFile(join(root, "notes", "visible.md"), "# Visible\n");
    await writeFile(join(root, "notes", "data.txt"), "[[Visible]]");

    const outside = await mkdtemp(join(tmpdir(), "dohc-graph-outside-"));
    await writeFile(join(outside, "secret.md"), "# Secret\n");
    await symlink(join(outside, "secret.md"), join(root, "secret.md"), "file");

    const graph = await readWorkspaceGraph(root);
    expect(graph.nodes.map((node) => node.path)).toEqual([
      "index.md",
      "notes/data.txt",
      "notes/visible.md",
    ]);
    expect(graph.edges).toEqual([
      { source: "index.md", target: "notes/visible.md", kind: "wikilink" },
    ]);
  });

  it("bounds graph text reads before buffering large markdown workspaces", async () => {
    const largeBody = `# Large\n${"x".repeat(600 * 1024)}\n`;
    for (let index = 0; index < 70; index++) {
      await writeFile(
        join(root, `large-${String(index).padStart(2, "0")}.md`),
        largeBody,
      );
    }

    const graph = await readWorkspaceGraph(root);
    expect(graph.nodes).toHaveLength(70);
    expect(graph.scannedFileCount).toBe(70);
    expect(graph.omittedFileCount).toBeGreaterThan(0);
  });
});
