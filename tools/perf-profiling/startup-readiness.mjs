// Serialized by Playwright into the renderer. Keep this function self-contained.
export function observeStartupReadiness({ workspaceName, path, content, timeoutMs = 30000 }) {
  const installedMs = performance.now();
  return new Promise((resolve, reject) => {
    let poll, frame, finished = false, alreadyReady;
    const finish = (error, value) => {
      if (finished) return;
      finished = true;
      clearTimeout(deadline);
      clearTimeout(poll);
      cancelAnimationFrame(frame);
      error ? reject(error) : resolve(value);
    };
    const deadline = setTimeout(() => finish(Error(`Expected visible editable document did not become ready: ${workspaceName}/${path}`)), timeoutMs);
    const visible = element => {
      if (!element || !element.isConnected || element.closest('[hidden], [inert], [aria-hidden="true"]')) return false;
      for (let node = element; node; node = node.parentElement) {
        const style = getComputedStyle(node);
        if (style.display === 'none' || style.visibility === 'hidden' || style.visibility === 'collapse' || style.opacity === '0' || style.contentVisibility === 'hidden') return false;
      }
      const rect = element.getBoundingClientRect();
      return rect.width > 0 && rect.height > 0 && rect.bottom > 0 && rect.right > 0 && rect.top < innerHeight && rect.left < innerWidth;
    };
    const surface = () => {
      if (document.visibilityState !== 'visible') return null;
      const shell = document.querySelector('[data-testid="workspace-shell"][data-ready="true"]');
      if (!shell || shell.querySelector('[data-testid="workspace-switcher"]')?.textContent?.trim() !== workspaceName) return null;
      const group = shell.querySelector('[data-editor-group-id][data-active="true"]');
      const tab = group?.querySelector('[role="tab"][aria-selected="true"]');
      if (tab?.getAttribute('data-testid') !== `tab-${path}`) return null;
      return [...group.querySelectorAll('[data-testid="view-markdown"] .tiptap[contenteditable="true"]')]
        .find(editor => visible(editor) && editor.textContent.includes(content)) ?? null;
    };
    const check = () => {
      if (finished) return;
      try {
        if (document.body.innerText?.includes('dohc could not open this document for editing.')) {
          throw Error('Actual packaged app refused document editing: dohc could not open this document for editing.');
        }
        const editor = surface();
        alreadyReady ??= Boolean(editor);
        if (!editor) { poll = setTimeout(check, 50); return; }
        const predicateMatchedMs = performance.now();
        const afterFrame = remaining => {
          frame = requestAnimationFrame(() => {
            try {
              if (surface() !== editor) { check(); return; }
              if (remaining > 1) { afterFrame(remaining - 1); return; }
              finish(null, { timeOrigin: performance.timeOrigin, observerInstalledMs: installedMs, alreadyReady,
                predicateMatchedMs, secondAnimationFrameMs: performance.now(), workspaceName, path });
            } catch (error) { finish(error); }
          });
        };
        afterFrame(2);
      } catch (error) { finish(error); }
    };
    check();
  });
}
export function startupTargetAfterSwitches(switches = []) {
  const index = switches.at(-1)?.to ?? 0;
  return { workspaceName: `workspace-${index}`, path: 'small.md', content: `Workspace ${index} small` };
}
