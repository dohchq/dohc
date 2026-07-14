import { Extension } from "@tiptap/core";
import type { Node as ProseMirrorNode, NodeType } from "@tiptap/pm/model";
import { Fragment } from "@tiptap/pm/model";
import { Plugin, PluginKey } from "@tiptap/pm/state";

const SKIP_TRAILING_NODE_META = "skipTrailingNode";

export function canAppendTrailingNode(
  doc: ProseMirrorNode,
  nodeType: NodeType,
): boolean {
  const trailingNode = nodeType.createAndFill();
  if (!trailingNode) return false;

  // Markdown and Y.Doc updates can briefly expose a structurally incomplete
  // document while an editor is being replaced. ProseMirror's canReplace()
  // assumes the existing document is valid and throws from contentMatchAt()
  // otherwise, which used to tear down the entire React renderer.
  if (!doc.type.validContent(doc.content)) return false;

  try {
    return doc.canReplace(
      doc.childCount,
      doc.childCount,
      Fragment.from(trailingNode),
    );
  } catch {
    return false;
  }
}

export const SafeTrailingNode = Extension.create({
  name: "trailingNode",

  addOptions() {
    return {
      node: "paragraph",
      notAfter: ["paragraph"],
    };
  },

  addProseMirrorPlugins() {
    const pluginKey = new PluginKey<boolean>(this.name);
    const defaultNodeName = this.options.node || "paragraph";
    const defaultNodeType = this.editor.schema.nodes[defaultNodeName];
    const disabledNodeNames = new Set<string>([
      defaultNodeName,
      ...(this.options.notAfter ?? []),
    ]);

    if (!defaultNodeType) return [];

    const needsTrailingNode = (doc: ProseMirrorNode) =>
      !doc.lastChild || !disabledNodeNames.has(doc.lastChild.type.name);

    return [
      new Plugin<boolean>({
        key: pluginKey,
        state: {
          init: (_, state) => needsTrailingNode(state.doc),
          apply: (transaction, previous) => {
            if (!transaction.docChanged) return previous;
            if (transaction.getMeta("__uniqueIDTransaction")) return previous;
            return needsTrailingNode(transaction.doc);
          },
        },
        appendTransaction: (transactions, _oldState, state) => {
          if (
            transactions.some((transaction) =>
              transaction.getMeta(SKIP_TRAILING_NODE_META),
            ) ||
            !pluginKey.getState(state) ||
            !canAppendTrailingNode(state.doc, defaultNodeType)
          ) {
            return undefined;
          }

          try {
            const trailingNode = defaultNodeType.createAndFill();
            return trailingNode
              ? state.tr.insert(state.doc.content.size, trailingNode)
              : undefined;
          } catch {
            // A concurrent teardown/update can invalidate the state between the
            // guard and insert. Skipping one convenience paragraph is always
            // safer than crashing the workspace.
            return undefined;
          }
        },
      }),
    ];
  },
});
