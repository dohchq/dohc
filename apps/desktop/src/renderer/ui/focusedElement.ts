// The focused element in the tree that holds `node`. In a shadow root, as in
// the site's demo, document.activeElement names only the shadow host.
export function focusedElementIn(node: Node | null | undefined): Element | null {
  const root = node?.getRootNode();
  return root instanceof Document || root instanceof ShadowRoot
    ? root.activeElement
    : document.activeElement;
}
