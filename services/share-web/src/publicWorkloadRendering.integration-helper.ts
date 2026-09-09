import * as Y from "yjs";
import {createElement} from "react";
import {createRoot} from "react-dom/client";
import {flushSync} from "react-dom";
import {yDocToMarkdown} from "@dohc/ydoc-projection";
import {mountLiveBodyEditor} from "@dohc/ydoc-projection/browser-editor";
import {MarkdownContent} from "../viewer/src/MarkdownContent.js";
import type {FixtureRenderer} from "./publicWorkloadAdapter.integration-helper.js";

// Preparation witnesses use production components in jsdom. Native proof still checks Chromium DOM.
export const renderPublicFixture: FixtureRenderer = (checkpoint, context) => {
  const doc = new Y.Doc({gc: false}), editorHost = document.createElement("div"), viewHost = document.createElement("div");
  const root = createRoot(viewHost);
  let editor: ReturnType<typeof mountLiveBodyEditor> | undefined;
  document.body.append(editorHost, viewHost);
  function resolver(table: Record<string, string | null>) {
    return (href: string) => {
      if (!Object.hasOwn(table, href)) throw new Error(`Rendering context has no resolution for ${href}`);
      return table[href]!;
    };
  }
  try {
    Y.applyUpdate(doc, checkpoint);
    const markdown = yDocToMarkdown(doc);
    editor = mountLiveBodyEditor(editorHost, {body: doc.getXmlFragment("body"), canEdit: () => false, edit: () => false, label: "Shared file editor"});
    flushSync(() => root.render(createElement(MarkdownContent, {markdown, resolveImage: resolver(context.images), resolveLink: resolver(context.links)})));
    const textbox = editorHost.querySelector('[role="textbox"]'), article = viewHost.querySelector("article.markdown");
    if (!textbox || !article) throw new Error("Production rendering did not mount its witness elements.");
    return {markdown, editorText: textbox.textContent ?? "", viewText: article.textContent ?? ""};
  } finally {editor?.destroy(); root.unmount(); editorHost.remove(); viewHost.remove(); doc.destroy();}
};
