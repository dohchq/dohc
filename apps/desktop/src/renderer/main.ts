// Minimal first-run shell. Phase 3 replaces this with the real desktop
// workspace shell (driven by the component reuse map + design review loop).

declare global {
  interface Window {
    dohcDesktopInternal?: { firstPaint(): void };
  }
}

const root = document.getElementById("root");
if (root) {
  const main = document.createElement("main");
  main.style.cssText =
    "display:flex;flex-direction:column;align-items:center;justify-content:center;height:100vh;gap:8px;";

  const heading = document.createElement("h1");
  heading.textContent = "dohc";
  heading.style.cssText =
    "font-size:28px;font-weight:600;letter-spacing:-0.02em;margin:0;";

  const subtitle = document.createElement("p");
  subtitle.textContent = "Your workspace is a folder.";
  subtitle.style.cssText = "font-size:14px;opacity:0.65;margin:0;";

  main.append(heading, subtitle);
  root.append(main);
}

requestAnimationFrame(() => {
  window.dohcDesktopInternal?.firstPaint();
});

export {};
