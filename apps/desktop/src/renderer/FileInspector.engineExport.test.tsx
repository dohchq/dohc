import { createHash } from "node:crypto";
import { markdownToYDoc, yDocToMarkdown } from "@dohc/ydoc-projection";
// @vitest-environment jsdom
import { cleanup, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { forwardRef, useImperativeHandle } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import * as Y from "yjs";
import type { UseEngineDoc } from "./collab/useEngineDoc";
import { FileInspector } from "./FileInspector";
import {
  EDGE_FRONTMATTER,
  EDGE_MARKDOWN,
  receivedYDoc,
} from "./markdown/frontmatter.edge-fixture";

// Finding: in engine mode the DocumentMenu export must serialize the live
// editor (collab-bound to the engine Y.Doc), not the stale props.body that
// serializeDraftRef falls back to whenever the inline properties surface is
// present or the doc opened in read/truncated mode. We prove this with the
// properties rendered (the exact state where the old code returned the stale
// disk body) and assert the exported markdown is the live editor body.
//
// Mocks the full UseEngineDoc contract, not just the fields this file reads —
// a partial mock silently hands undefined to a `!== null` check elsewhere in
// FileInspector.tsx (removalInProgress), which is not the same as null.
const flushPendingLocalUpdates = vi.fn(async () => undefined);
const engineDocState: UseEngineDoc = {
  available: false,
  opening: false,
  doc: null,
  objectId: null,
  versionId: null,
  saveState: { kind: "saved-here" },
  saveError: null,
    authorCapacity: false,
  notInVersion: false,
  documentUnavailable: false,
  liveHostUnavailable: false,
  engineMayHoldDocument: false,
  artifactAssetsInvalid: false,
  deletedWhileEditing: false,
  goneCause: null,
  deletedDraftId: null,
  recoveryAssets: null,
  permanentFailureWhileEditing: false,
  changedOutside: null,
  outsideWriteWaiting: false,
  unsavedEditsPending: () => false,
  readOnlyWhileEditing: false,
  readOnlyDraftId: null,
  readOnlyCause: null,
  retryReplacement: null,
  replacedDraftIds: [],
  removalInProgress: null,
  artifactAssets: [],
  readArtifactAsset: async () => {
    throw new Error("no artifact asset");
  },
  flushPendingLocalUpdates,
};

vi.mock("./collab/useEngineDoc", () => ({
  useEngineDoc: () => engineDocState,
}));

// A stub editor that reports a live body distinct from the disk body, so the
// test can tell whether the menu read the editor or the stale prop.
const editorSerialize=vi.hoisted(()=>vi.fn());
vi.mock('./editor/artifactSource',()=>({prepareArtifactSource:()=>undefined,projectArtifactSource:vi.fn(async(doc:Y.Doc)=>(await import('@dohc/ydoc-projection')).yDocToArtifactMarkdown(doc))}));
import {projectArtifactSource} from './editor/artifactSource';
import {forgedSources} from '../../../../packages/ydoc-projection/src/artifact-witness.fixture.ts';
const LIVE_BODY = "# Live engine body\n";
vi.mock("./editor/MarkdownEditor", () => ({
  MarkdownEditor: forwardRef<{ focus: () => void; getMarkdown: () => string }>(
    function MarkdownEditorStub(_props, ref) {
      useImperativeHandle(ref, () => ({
        focus: () => {},
        getMarkdown: () => {editorSerialize();return LIVE_BODY;},
      }));
      return <div data-testid="editor-stub" />;
    },
  ),
}));

vi.mock("./PropertiesPanel", () => ({
  PropertiesPanel: () => <div data-testid="properties-stub" />,
}));

vi.mock("./PageIdentity", () => ({
  PageIdentity: () => <div data-testid="page-identity-stub" />,
}));

const writeText = vi.fn(async () => {});

describe("engine-mode DocumentMenu exports the live editor body, not stale props.body", () => {
  const bridgeMock = {
    onWorkspaceActivity: vi.fn(() => () => undefined),
    readWorkspaceText: vi.fn(async () => ({
      text: "# Stale disk body\n",
      truncated: false,
      contentHash: "c".repeat(64),
    })),
    writeWorkspaceText: vi.fn(async () => ({ path: "a.md", recorded: true })),
    listWorkspaceFiles: vi.fn(async () => ({
      files: [{ path: "a.md", kind: "file" }],
      folders: [],
    })),
    readWorkspaceDatabase: vi.fn(async () => ({ tables: [] })),
    exportDocumentFile: vi.fn(async () => ({ saved: true })),
  };

  beforeEach(() => {
  vi.mocked(projectArtifactSource).mockImplementation(async doc => (await import('@dohc/ydoc-projection')).yDocToArtifactMarkdown(doc));
    engineDocState.available = true;
    engineDocState.doc = markdownToYDoc(LIVE_BODY);
    engineDocState.saveState = { kind: "saved-here" };
    vi.stubGlobal(
      "ResizeObserver",
      class {
        observe() {}
        unobserve() {}
        disconnect() {}
      },
    );
    vi.stubGlobal("dohcDesktop", bridgeMock);
  });

  afterEach(() => {
    cleanup();
    vi.unstubAllGlobals();
    vi.clearAllMocks();
    engineDocState.available = false;
    engineDocState.doc = null;
  });

  it("copies the witnessed settled artifact from the live Y.Doc", async () => {
    const source = "---\nzebra: last\ntitle: \"Outside\"\nalpha: first\n---\n\n- one\n- two\n\n";
    const doc = markdownToYDoc(source);
    const sha = (text: string) => createHash("sha256").update(text).digest("hex");
    doc.getMap("meta").set("dohcMarkdownSource", source);
    doc.getMap("meta").set("dohcMarkdownSourceSha256", sha(source));
    doc.getMap("meta").set("dohcMarkdownSourceProjectionSha256", sha(yDocToMarkdown(doc)));
    engineDocState.doc = doc;
    const user = userEvent.setup();
    Object.defineProperty(navigator, "clipboard", {value: {writeText}, configurable: true});
    render(<FileInspector workspaceId="ws-1" path="a.md" />);
    await screen.findByTestId("editor-stub");
    await user.click(screen.getByTestId("document-menu-trigger"));
    await user.click(screen.getByTestId("document-menu-item-copy-markdown"));
    await waitFor(() => expect(writeText).toHaveBeenCalledWith(source));

    const remote = new Y.Doc();
    Y.applyUpdate(remote, Y.encodeStateAsUpdate(doc));
    remote.getMap("frontmatter").set("title", "Remote title");
    Y.applyUpdate(doc, Y.encodeStateAsUpdate(remote));
    writeText.mockClear();
    await user.click(screen.getByTestId("document-menu-item-copy-markdown"));
    await waitFor(() => expect(writeText).toHaveBeenCalledWith(yDocToMarkdown(doc)));

    const changeText = (node: Y.XmlFragment | Y.XmlElement): boolean => {
      for (const child of node.toArray()) {
        if (child instanceof Y.XmlText && child.toString().includes("one")) {
          child.insert(0, "Edited ");
          return true;
        }
        if (child instanceof Y.XmlElement && changeText(child)) return true;
      }
      return false;
    };
    expect(changeText(doc.getXmlFragment("body"))).toBe(true);
    writeText.mockClear();
    await user.click(screen.getByTestId("document-menu-item-copy-markdown"));
    await waitFor(() => expect(writeText).toHaveBeenCalledWith(yDocToMarkdown(doc)));
    remote.destroy();
  });

  it("copies the live editor markdown even while the properties panel is open", async () => {
    const user = userEvent.setup();
    // navigator.clipboard is defined after userEvent.setup() so its own stub
    // doesn't shadow ours (same ordering the DocumentMenu unit test relies on).
    Object.defineProperty(navigator, "clipboard", {
      value: { writeText },
      configurable: true,
    });
    render(<FileInspector workspaceId="ws-1" path="a.md" />);

    // Editor mounts once the file text loads (async IPC).
    await screen.findByTestId("editor-stub");

    // Inline properties always render under the title now — the state where
    // serializeDraftRef used to return the stale disk body.
    await screen.findByTestId("properties-stub");

    await user.click(screen.getByTestId("document-menu-trigger"));
    await user.click(screen.getByTestId("document-menu-item-copy-markdown"));

    await waitFor(() => expect(writeText).toHaveBeenCalledWith(LIVE_BODY.trimEnd()));
    expect(writeText).not.toHaveBeenCalledWith("# Stale disk body\n");
  });

  it("flushes pending live edits before the shell starts a path mutation", async () => {
    let registeredFlush: (() => Promise<void>) | null = null;
    render(
      <FileInspector
        workspaceId="ws-1"
        path="a.md"
        registerDraftFlush={(flush) => {
          registeredFlush = flush;
        }}
      />,
    );
    await screen.findByTestId("editor-stub");
    await waitFor(() => expect(registeredFlush).not.toBeNull());

    await registeredFlush!();

    expect(flushPendingLocalUpdates).toHaveBeenCalledOnce();
  });

  it("carries live frontmatter (title/icon) edits, not the mount-time markdown", async () => {
    const user = userEvent.setup();
    Object.defineProperty(navigator, "clipboard", {
      value: { writeText },
      configurable: true,
    });
    // Title / icon edits land in the engine Y.Doc frontmatter MAP (PageIdentity
    // writes there), never in latestDraft.current — so an export must read the
    // live map, not the stale mount-time frontmatter.
    engineDocState.doc!.getMap("frontmatter").set("title", "Live Title");
    engineDocState.doc!.getMap("frontmatter").set("icon", "🚀");

    render(<FileInspector workspaceId="ws-1" path="a.md" />);
    await screen.findByTestId("editor-stub");

    await user.click(screen.getByTestId("document-menu-trigger"));
    await user.click(screen.getByTestId("document-menu-item-copy-markdown"));

    await waitFor(() =>
      expect(writeText).toHaveBeenCalledWith(
        `---\ntitle: Live Title\nicon: 🚀\n---\n\n${LIVE_BODY.trimEnd()}`,
      ),
    );
  });

  // The canonical TypeScript writer keeps a `__proto__` or `constructor` key,
  // and an exact integer beside one, in shared Y types. A copy writes the
  // values, as the file holds them.
  it("copies shared-type frontmatter over the live body", async () => {
    const user = userEvent.setup();
    Object.defineProperty(navigator, "clipboard", {
      value: { writeText },
      configurable: true,
    });
    engineDocState.doc = receivedYDoc(EDGE_MARKDOWN);

    render(<FileInspector workspaceId="ws-1" path="a.md" />);
    await screen.findByTestId("editor-stub");

    await user.click(screen.getByTestId("document-menu-trigger"));
    await user.click(screen.getByTestId("document-menu-item-copy-markdown"));

    await waitFor(() =>
      expect(writeText).toHaveBeenCalledWith(`${EDGE_FRONTMATTER}Body`),
    );
  });

  it("exports shared-type frontmatter over the live body", async () => {
    const user = userEvent.setup();
    engineDocState.doc = receivedYDoc(EDGE_MARKDOWN);

    render(<FileInspector workspaceId="ws-1" path="a.md" />);
    await screen.findByTestId("editor-stub");

    await user.click(screen.getByTestId("document-menu-trigger"));
    await user.click(screen.getByTestId("document-menu-item-export-markdown"));

    await waitFor(() =>
      expect(bridgeMock.exportDocumentFile).toHaveBeenCalledWith(
        expect.objectContaining({
          kind: "markdown",
          content: `${EDGE_FRONTMATTER}Body`,
        }),
      ),
    );
  });

  it.each(forgedSources)('Copy and Export keep markup inert: %s',async source=>{
    const doc=markdownToYDoc(source);const canonical=yDocToMarkdown(doc);const sha=(s:string)=>createHash('sha256').update(s).digest('hex');
    doc.getMap('meta').set('dohcMarkdownSource',source);doc.getMap('meta').set('dohcMarkdownSourceSha256',sha(source));doc.getMap('meta').set('dohcMarkdownSourceProjectionSha256',sha(canonical));engineDocState.doc=doc;
    const user=userEvent.setup();Object.defineProperty(navigator,'clipboard',{value:{writeText},configurable:true});render(<FileInspector workspaceId="ws-1" path="a.md"/>);await screen.findByTestId('editor-stub');
    await user.click(screen.getByTestId('document-menu-trigger'));await user.click(screen.getByTestId('document-menu-item-copy-markdown'));await waitFor(()=>expect(writeText).toHaveBeenCalledWith(canonical));
    await user.click(screen.getByTestId('document-menu-item-export-markdown'));await waitFor(()=>expect(bridgeMock.exportDocumentFile).toHaveBeenCalledWith(expect.objectContaining({content:canonical})));
    expect(editorSerialize).not.toHaveBeenCalled();expect(projectArtifactSource).not.toHaveBeenCalled();doc.destroy();
  });

  it.each(['without witness','worker error'])('Copy and Export use canonical output %s', async kind => {
    const doc=markdownToYDoc('Body\n\n'); engineDocState.doc=doc;
    if(kind==='worker error'){for(const key of ['dohcMarkdownSource','dohcMarkdownSourceSha256','dohcMarkdownSourceProjectionSha256']) doc.getMap('meta').set(key,'plain');}
    vi.mocked(projectArtifactSource).mockRejectedValue(Error('worker failed'));
    const user=userEvent.setup(); Object.defineProperty(navigator,'clipboard',{value:{writeText},configurable:true}); render(<FileInspector workspaceId="ws-1" path="a.md"/>); await screen.findByTestId('editor-stub');
    await user.click(screen.getByTestId('document-menu-trigger'));await user.click(screen.getByTestId('document-menu-item-copy-markdown'));await waitFor(()=>expect(writeText).toHaveBeenCalledWith(yDocToMarkdown(doc)));
    await user.click(screen.getByTestId('document-menu-item-export-markdown'));await waitFor(()=>expect(bridgeMock.exportDocumentFile).toHaveBeenCalledWith(expect.objectContaining({content:yDocToMarkdown(doc)})));
    if(kind==='without witness') expect(projectArtifactSource).not.toHaveBeenCalled(); doc.destroy();
  });

  it('reuses worker output without serializing the editor for readiness',async()=>{
    const source='Body\n\n';const doc=markdownToYDoc(source);const sha=(s:string)=>createHash('sha256').update(s).digest('hex');
    doc.getMap('meta').set('dohcMarkdownSource',source);doc.getMap('meta').set('dohcMarkdownSourceSha256',sha(source));doc.getMap('meta').set('dohcMarkdownSourceProjectionSha256',sha(yDocToMarkdown(doc)));engineDocState.doc=doc;
    const user=userEvent.setup();Object.defineProperty(navigator,'clipboard',{value:{writeText},configurable:true});render(<FileInspector workspaceId="ws-1" path="a.md"/>);await screen.findByTestId('editor-stub');
    await user.click(screen.getByTestId('document-menu-trigger'));await user.click(screen.getByTestId('document-menu-item-copy-markdown'));await waitFor(()=>expect(writeText).toHaveBeenCalledWith(source));
    expect(editorSerialize).not.toHaveBeenCalled();expect(projectArtifactSource).toHaveBeenCalledWith(doc);doc.destroy();
  });
});
