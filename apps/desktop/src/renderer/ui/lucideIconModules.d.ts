// One lucide icon's module: its geometry, which kindGlyphs.ts reads so the
// React and DOM kind glyphs draw the same icon. kindGlyphs.ts references this
// file, so every program that compiles it (the desktop app, the site demo)
// has the type.
declare module "lucide-react/dist/esm/icons/*.mjs" {
  export const __iconNode: import("lucide-react").IconNode;
}
