import type { AnyExtension } from '@tiptap/core'
import {
  DohcImage,
  DohcMathBlock,
  DohcMathInline,
  dohcMarkdownExtensions,
} from '@dohc/ydoc-projection/markdown-extensions'
import { makeImageNodeView, type ImageSrcContext } from './imageSrc'
import { makeMathNodeView } from './mathRender'

// Per-editor storage for the image node view. `resolveContext` is set by the
// desktop editor (MarkdownEditor's onBeforeCreate) to the live workspace +
// document folder, so a render-time src can be rewritten to the privileged
// dohc-file:// scheme. It stays null in non-desktop consumers (jsdom tests) —
// the node view then paints the raw stored path.
export interface DohcImageStorage {
  resolveContext: (() => ImageSrcContext | null) | null
}

// Type `editor.storage.image` as DohcImageStorage via TipTap's documented
// storage augmentation, so consumers (MarkdownEditor's onBeforeCreate) reach it
// without an untyped double cast. Runtime guards still apply for consumers where
// the desktop image extension isn't registered.
declare module '@tiptap/core' {
  interface Storage {
    image: DohcImageStorage
  }
}

// TipTap 3.x ignores editorProps.nodeViews (the extension-manager node views
// overwrite it), so the node views are registered on the extensions. Each adds
// only a view: the schema, tokenizers, and conversions stay the projection's.
const DesktopImage = DohcImage.extend<Record<string, never>, DohcImageStorage>({
  addStorage() {
    return { resolveContext: null }
  },

  // The context is read lazily from per-editor storage so the shared extension
  // instance still resolves against whichever document each editor is showing.
  addNodeView() {
    const factory = makeImageNodeView(() => this.storage.resolveContext?.() ?? null)
    return ({ node }) => factory(node)
  },
})

const DesktopMathInline = DohcMathInline.extend({
  addNodeView() {
    const factory = makeMathNodeView(false)
    return ({ node, view, getPos }) =>
      factory(node, view, () => (typeof getPos === 'function' ? getPos() : undefined))
  },
})

const DesktopMathBlock = DohcMathBlock.extend({
  addNodeView() {
    const factory = makeMathNodeView(true)
    return ({ node, view, getPos }) =>
      factory(node, view, () => (typeof getPos === 'function' ? getPos() : undefined))
  },
})

/** The projection's Markdown extensions, with the desktop's image and math views. */
export const desktopMarkdownExtensions: AnyExtension[] = dohcMarkdownExtensions.map(
  (extension) =>
    extension === DohcImage
      ? DesktopImage
      : extension === DohcMathInline
        ? DesktopMathInline
        : extension === DohcMathBlock
          ? DesktopMathBlock
          : extension,
)
