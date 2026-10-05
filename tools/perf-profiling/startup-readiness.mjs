// Serialized by Playwright into the renderer. Keep this function self-contained.
export function observeStartupReadiness({ workspaceName, path, content, timeoutMs = 30000, trigger = null }) {
  const installedMs = performance.now();
  return new Promise((resolve, reject) => {
    let frame, finished = false, alreadyReady, matchedEditor, triggeredGroup, triggerMs, triggerEventTimestampMs;
    const finish = (error, value) => {
      if (finished) return;
      finished = true;
      clearTimeout(deadline);
      cancelAnimationFrame(frame);
      mutations.disconnect();
      document.removeEventListener('pointerdown', pointerdown, true);
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
      if (triggeredGroup && group !== triggeredGroup) return null;
      const tab = group?.querySelector('[role="tab"][aria-selected="true"]');
      if (tab?.getAttribute('data-testid') !== `tab-${path}`) return null;
      return [...group.querySelectorAll('[data-testid="view-markdown"] .tiptap[contenteditable="true"]')]
        .find(editor => editor.textContent.includes(content) && visible(editor)) ?? null;
    };
    const check = () => {
      if (finished) return;
      try {
        if (trigger && triggerMs === undefined) return;
        const refused = [...document.querySelectorAll('[data-testid="engine-may-hold-document-notice"]')]
          .some(notice => notice.textContent.includes('dohc could not open this document for editing.') && visible(notice));
        if (refused) {
          throw Error('Actual packaged app refused document editing: dohc could not open this document for editing.');
        }
        const editor = surface();
        alreadyReady ??= Boolean(editor);
        if (!editor) {
          matchedEditor = null;
          if (frame === undefined) frame = requestAnimationFrame(() => { frame = undefined; check(); });
          return;
        }
        if (editor === matchedEditor) return;
        cancelAnimationFrame(frame);
        matchedEditor = editor;
        const predicateMatchedMs = performance.now();
        const afterFrame = remaining => {
          frame = requestAnimationFrame(() => {
            frame = undefined;
            try {
              if (surface() !== editor || matchedEditor !== editor) { matchedEditor = null; check(); return; }
              if (remaining > 1) { afterFrame(remaining - 1); return; }
              finish(null, { timeOrigin: performance.timeOrigin, observerInstalledMs: installedMs, alreadyReady,
                predicateMatchedMs, secondAnimationFrameMs: performance.now(), workspaceName, path,
                ...(trigger ? { triggerMs, triggerEventTimestampMs, triggerTrusted: true } : {}) });
            } catch (error) { finish(error); }
          });
        };
        afterFrame(2);
      } catch (error) { finish(error); }
    };
    const pointerdown = event => {
      const tab = event.target?.closest?.('[role="tab"]');
      const group = tab?.closest('[data-editor-group-id][data-active="true"]');
      const shell = group?.closest('[data-testid="workspace-shell"][data-ready="true"]');
      if (triggerMs !== undefined || tab?.getAttribute('data-testid') !== `tab-${path}` || !group ||
        shell?.querySelector('[data-testid="workspace-switcher"]')?.textContent?.trim() !== workspaceName) return;
      if (!event.isTrusted) { finish(Error('Untrusted tab pointerdown observed')); return; }
      triggeredGroup = group;
      triggerMs = performance.now();
      triggerEventTimestampMs = event.timeStamp;
      check();
    };
    const mutations = new MutationObserver(check);
    mutations.observe(document, { subtree: true, childList: true, attributes: true, characterData: true });
    if (trigger) document.addEventListener('pointerdown', pointerdown, true);
    check();
  });
}
export function startupTargetFromRegistry(registry, fixtureWorkspaces) {
  // A new process has no preferredWorkspaceId. DesktopRoot opens the first
  // registry entry; lastOpenedAt and the prior renderer selection do not reorder it.
  const selected = registry?.workspaces?.[0];
  const index = fixtureWorkspaces.findIndex(workspace =>
    workspace.workspaceId === selected?.workspaceId && workspace.rootPath === selected?.rootPath);
  if (registry?.version !== 1 || index < 0) throw Error('Startup registry does not select a known fixture workspace');
  return { workspaceName: `workspace-${index}`, path: 'small.md', content: `Workspace ${index} small` };
}

// Arm in the renderer before automation delivers input. Keep wall brackets separately.
export async function activateTab(page, target, now = () => performance.now()) {
  const observation = { armStartedMs: now() };
  await page.evaluate(`(() => { window.__dohcTabReadiness = (${observeStartupReadiness.toString()})(${JSON.stringify({ ...target, trigger: 'pointerdown' })}); window.__dohcTabReadiness.catch(() => {}); })()`);
  observation.armCompletedMs = now();
  observation.clickStartedMs = now();
  await page.locator('[data-editor-group-id][data-active="true"]')
    .getByTestId(`tab-${target.path}`).click();
  observation.clickCompletedMs = now();
  const rendererReadiness = await page.evaluate(() => window.__dohcTabReadiness);
  observation.readinessReturnedMs = now();
  return { ...target, pointerdownToEditableTwoRafObservedMs: rendererReadiness.secondAnimationFrameMs - rendererReadiness.triggerMs,
    automationClickToReadinessReturnedMs: observation.readinessReturnedMs - observation.clickStartedMs, observation, rendererReadiness };
}
