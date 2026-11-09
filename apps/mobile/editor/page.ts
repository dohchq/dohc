// The page script the app's web views load, bundled by scripts/build-editor.mjs. The app injects the page as
// `__dohcPage` before the script runs; the hidden warm web view gets `__dohcWarm` instead and shows nothing.
import { post } from "./bridge";
import { mountDocument, type PageConfig } from "./document";

const host = window as Window & { __dohcPage?: PageConfig; __dohcWarm?: boolean };
// When the script starts running, to split the time to first text into the web view's start and the render.
post("started", { at: Date.now() });
// Inter loads before the page draws, so its text never swaps or hides: all three faces, so every property, line and
// letter typed later has its face (the warm web view loads them at launch). If they can't load within 5 seconds, the
// page doesn't draw, and the app shows "dohc could not open this file." with Try again. A large file's text is monospace only,
// so it doesn't wait.
const fontsLoaded = Promise.race([
  document.fonts.load('1rem "Inter Variable"', "aĀạ").then(faces => faces.length === 3),
  new Promise<boolean>(done => setTimeout(() => done(false), 5000)),
]).catch(() => false);
if (!host.__dohcWarm && host.__dohcPage) {
  const page = host.__dohcPage;
  if (page.large) mountDocument(page);
  else void fontsLoaded.then(loaded => {
    if (!loaded) { post("fontsFailed", { at: Date.now() }); return; }
    post("fonts", { at: Date.now() });
    mountDocument(page);
  });
}
