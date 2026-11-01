import type { DetailedHTMLProps, HTMLAttributes } from "react";

// Electron's <webview>. React 19 passes `src` and `partition` through as
// attributes, which main's will-attach-webview guard reads.
declare module "react" {
  namespace JSX {
    interface IntrinsicElements {
      webview: DetailedHTMLProps<HTMLAttributes<Electron.WebviewTag>, Electron.WebviewTag> & {
        src: string;
        partition: string;
      };
    }
  }
}
