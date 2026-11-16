// Electron runs this file: one window, two painted frames, then quit.
// A cloud worker runs it before its desktop tests. See firstDesktopLaunchCommand in verify.mjs.
const { app, BrowserWindow } = require("electron");

app
  .whenReady()
  .then(async () => {
    const window = new BrowserWindow({ width: 1280, height: 800 });
    await window.loadURL(
      "data:text/html,<h1>dohc</h1><p>The first launch on this computer.</p><button>Open folder</button>",
    );
    await window.webContents.executeJavaScript(
      "new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(() => resolve(true))))",
    );
    app.quit();
  })
  .catch((error) => {
    console.error(error);
    app.exit(1);
  });
