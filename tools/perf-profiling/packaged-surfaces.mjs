import { createHash } from 'node:crypto';

// observeSurface and observeSearchSubmit are serialized by Playwright into the renderer.
// Keep them self-contained: no module-scope references.

// Resolves two animation frames after `target` has `minCount` matches, the first one
// visible, optionally focused or holding `value`. `trigger` records the first keydown or
// mousedown (`triggerKey` filters keydown) seen after installation so a duration can start
// at the renderer's receipt of trusted input instead of at the harness clock.
export function observeSurface({ trigger = null, triggerKey = null, target, minCount = 1, focused = null, value = null, countSelector = null, timeoutMs = 60000 }) {
  const installedMs = performance.now();
  return new Promise((resolve, reject) => {
    const eventName = { keydown: 'keydown', click: 'mousedown', null: null }[trigger];
    if (eventName === undefined) { reject(Error(`Unknown trigger: ${trigger}`)); return; }
    let poll, finished = false, triggerMs = null, triggerTrusted = null;
    const frames = new Set();
    const onTrigger = event => {
      if (triggerMs !== null || (triggerKey !== null && event.key?.toLowerCase() !== triggerKey.toLowerCase())) return;
      triggerMs = performance.now(); triggerTrusted = event.isTrusted;
    };
    if (eventName) window.addEventListener(eventName, onTrigger, true);
    const observer = new MutationObserver(() => check());
    const finish = (error, result) => {
      if (finished) return;
      finished = true;
      clearTimeout(deadline); clearTimeout(poll); observer.disconnect();
      for (const frame of frames) cancelAnimationFrame(frame);
      if (eventName) window.removeEventListener(eventName, onTrigger, true);
      error ? reject(error) : resolve(result);
    };
    const deadline = setTimeout(() => finish(Error(`Surface did not render within ${timeoutMs}ms: ${target}`)), timeoutMs);
    const visible = element => {
      if (!element || !element.isConnected || element.closest('[hidden], [inert], [aria-hidden="true"]')) return false;
      for (let node = element; node; node = node.parentElement) {
        const style = getComputedStyle(node);
        if (style.display === 'none' || style.visibility === 'hidden' || style.visibility === 'collapse' || style.opacity === '0' || style.contentVisibility === 'hidden') return false;
      }
      const rect = element.getBoundingClientRect();
      return rect.width > 0 && rect.height > 0 && rect.bottom > 0 && rect.right > 0 && rect.top < innerHeight && rect.left < innerWidth;
    };
    const matches = () => {
      if (document.visibilityState !== 'visible' || (eventName && triggerMs === null)) return null;
      const found = document.querySelectorAll(target);
      if (found.length < minCount || !visible(found[0])) return null;
      if (focused !== null && !document.activeElement?.matches(focused)) return null;
      if (value !== null && found[0].value !== value) return null;
      return found;
    };
    const check = () => {
      if (finished) return;
      try {
        const found = matches();
        if (!found) return;
        observer.disconnect(); clearTimeout(poll);
        const matchedMs = performance.now();
        const afterFrame = remaining => {
          const frame = requestAnimationFrame(() => {
            frames.delete(frame);
            try {
              if (!matches()) { observer.observe(document.documentElement, { subtree: true, childList: true, attributes: true, characterData: true }); tick(); return; }
              if (remaining > 1) { afterFrame(remaining - 1); return; }
              finish(null, { timeOrigin: performance.timeOrigin, installedMs, triggerMs, triggerTrusted, matchedMs, paintedMs: performance.now(),
                matchedCount: found.length, count: countSelector ? document.querySelectorAll(countSelector).length : found.length,
                text: (found[0].textContent ?? '').trim().slice(0, 200) });
            } catch (error) { finish(error); }
          });
          frames.add(frame);
        };
        afterFrame(2);
      } catch (error) { finish(error); }
    };
    const tick = () => { if (finished) return; check(); if (!finished) poll = setTimeout(tick, 50); };
    observer.observe(document.documentElement, { subtree: true, childList: true, attributes: true, characterData: true });
    tick();
  });
}

// Install before the query is submitted with Enter. Records the Enter keydown, then the first
// visible result row and the complete state of the search issued after it, each followed by
// two animation frames. `debounceFiredBeforeSubmit` is true when search-as-you-type already
// replaced the search id between installation and Enter.
export function observeSearchSubmit({ timeoutMs = 120000 } = {}) {
  const installedMs = performance.now();
  return new Promise((resolve, reject) => {
    const view = () => document.querySelector('[data-testid="search-view"]');
    if (!view() || !document.querySelector('[data-testid="search-input"]')) { reject(Error('Search view is not open')); return; }
    const result = { timeOrigin: performance.timeOrigin, installedMs, searchIdAtInstall: view().dataset.searchId ?? '', submitMs: null, submitTrusted: null,
      stateAtSubmit: null, searchIdAtSubmit: null, debounceFiredBeforeSubmit: null, searchId: null, searchIdChanges: 0,
      firstResultMs: null, firstResultPaintedMs: null, settledMs: null, settledPaintedMs: null, rowsRendered: null, summary: null, limitHit: null, emptyState: null };
    let poll, finished = false, settling = false;
    const frames = new Set();
    const observer = new MutationObserver(() => check());
    const finish = (error, value) => {
      if (finished) return;
      finished = true;
      clearTimeout(deadline); clearTimeout(poll); observer.disconnect();
      for (const frame of frames) cancelAnimationFrame(frame);
      window.removeEventListener('keydown', onKeydown, true);
      error ? reject(error) : resolve(value);
    };
    const deadline = setTimeout(() => finish(Error(`Search did not settle within ${timeoutMs}ms`)), timeoutMs);
    const visible = element => {
      if (!element || !element.isConnected || element.closest('[hidden], [inert], [aria-hidden="true"]')) return false;
      for (let node = element; node; node = node.parentElement) {
        const style = getComputedStyle(node);
        if (style.display === 'none' || style.visibility === 'hidden' || style.visibility === 'collapse' || style.opacity === '0' || style.contentVisibility === 'hidden') return false;
      }
      const rect = element.getBoundingClientRect();
      return rect.width > 0 && rect.height > 0 && rect.bottom > 0 && rect.right > 0 && rect.top < innerHeight && rect.left < innerWidth;
    };
    const twoFrames = done => {
      const outer = requestAnimationFrame(() => {
        frames.delete(outer);
        const inner = requestAnimationFrame(() => { frames.delete(inner); try { done(performance.now()); } catch (error) { finish(error); } });
        frames.add(inner);
      });
      frames.add(outer);
    };
    const onKeydown = event => {
      if (event.key !== 'Enter' || result.submitMs !== null || !event.target?.matches?.('[data-testid="search-input"]')) return;
      result.submitMs = performance.now(); result.submitTrusted = event.isTrusted;
      const current = view();
      result.stateAtSubmit = current?.dataset.state ?? null;
      result.searchIdAtSubmit = current?.dataset.searchId ?? '';
      result.debounceFiredBeforeSubmit = result.searchIdAtSubmit !== result.searchIdAtInstall;
    };
    window.addEventListener('keydown', onKeydown, true);
    const check = () => {
      if (finished || settling || result.submitMs === null) return;
      try {
        const current = view();
        if (!current) throw Error('Search view unmounted during the search');
        const id = current.dataset.searchId ?? '';
        if (!id || id === result.searchIdAtSubmit) return;
        if (result.searchId !== id) { if (result.searchId !== null) result.searchIdChanges++; result.searchId = id; }
        if (result.firstResultMs === null) {
          const row = current.querySelector('[data-testid="search-result-row"]');
          if (row && visible(row)) { result.firstResultMs = performance.now(); twoFrames(now => { result.firstResultPaintedMs ??= now; }); }
        }
        if (current.dataset.state !== 'complete') return;
        settling = true;
        result.settledMs = performance.now();
        twoFrames(now => {
          const settled = view();
          result.settledPaintedMs = now;
          result.rowsRendered = settled?.querySelectorAll('[data-testid="search-result-row"]').length ?? null;
          result.summary = settled?.querySelector('[data-testid="search-summary"]')?.textContent?.trim() ?? null;
          result.limitHit = Boolean(settled?.querySelector('[data-testid="search-cap-notice"]'));
          result.emptyState = Boolean(settled?.querySelector('[data-testid="search-empty-state"]'));
          finish(null, result);
        });
      } catch (error) { finish(error); }
    };
    const tick = () => { if (finished) return; check(); if (!finished) poll = setTimeout(tick, 50); };
    observer.observe(document.documentElement, { subtree: true, childList: true, attributes: true, characterData: true });
    tick();
  });
}

// Serialized into the renderer. The CLI reports its own `th_` handle for a thread while the
// DOM carries the engine id, so the seeded post is found by the title the DOM shows and the
// harness clicks the id the DOM holds.
export function seededPostThreadId({ title }) {
  const cards = [...document.querySelectorAll('[data-testid="chats-channel-view"] [data-testid="chats-post-card"]')]
    .filter(card => card.querySelector('[data-testid="chats-post-title"]')?.textContent?.trim() === title);
  if (cards.length !== 1) throw Error(`Expected one post titled ${JSON.stringify(title)}, found ${cards.length}`);
  return cards[0].dataset.threadId;
}

const BASE32 = 'abcdefghijklmnopqrstuvwxyz234567';
function base32(bytes) {
  let bits = 0, value = 0, out = '';
  for (const byte of bytes) {
    value = (value << 8) | byte; bits += 8;
    while (bits >= 5) { bits -= 5; out += BASE32[(value >>> bits) & 31]; }
    value &= (1 << bits) - 1;
  }
  return bits > 0 ? out + BASE32[(value << (5 - bits)) & 31] : out;
}
// The engine accepts any `rec_` plus 26 lowercase base32 characters; a pre-minted id keeps
// the fixture bytes stable and spares the engine a write-back per record on first open.
export function recordId(seed) {
  return `rec_${base32(createHash('sha256').update(seed).digest().subarray(0, 16))}`;
}

const STATUSES = ['Todo', 'Doing', 'Done'];
export function collectionFixtureFiles(count, folder = 'records') {
  const files = [{ path: `${folder}/collection.yaml`, content: 'name: Records\nfields:\n  Name:\n    type: text\n  Status:\n    type: select\n    options: [Todo, Doing, Done]\n  Priority:\n    type: number\n  Done:\n    type: checkbox\n  Due:\n    type: date\nviews:\n  - name: Table\n    kind: table\n' }];
  for (let n = 1; n <= count; n++) {
    const due = `2026-${String(1 + (n % 12)).padStart(2, '0')}-${String(1 + (n % 28)).padStart(2, '0')}`;
    files.push({ path: `${folder}/record-${String(n).padStart(6, '0')}.md`,
      content: `---\nid: ${recordId(`${folder}/${n}`)}\nName: Record ${n}\nStatus: ${STATUSES[n % 3]}\nPriority: ${n % 5}\nDone: ${n % 2 === 0}\nDue: "${due}"\n---\n# Record ${n}\n\nPerformance text.\n` });
  }
  return files;
}

export function classifyProcess(process, appPid) {
  const command = process.commandLine ?? '';
  if (process.pid === appPid) return 'main';
  if (/dohc-workspace-engine/i.test(`${process.name ?? ''} ${process.path ?? ''}`)) return 'engine';
  const type = command.match(/--type=([a-z-]+)/)?.[1];
  return type === 'renderer' ? 'renderer' : type === 'gpu-process' ? 'gpu' : type === 'utility' ? 'utility' : type === 'crashpad-handler' ? 'crashpad' : 'other';
}

export function aggregateByKind(snapshot, appPid) {
  const kinds = {};
  for (const process of snapshot.processes) {
    const bucket = kinds[classifyProcess(process, appPid)] ??= { count: 0, workingSetBytes: 0, privateBytes: 0 };
    bucket.count++; bucket.workingSetBytes += process.workingSetBytes; bucket.privateBytes += process.privateBytes;
  }
  return { completedAtMs: snapshot.completedAtMs, processCount: snapshot.processes.length, kinds };
}
