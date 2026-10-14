import { samplePresenceClock, validatePresenceClocks } from './presence-owner.mjs';
import assert from 'node:assert/strict';
import { _electron } from '@playwright/test';
import { createRequire } from 'node:module';
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve, relative, isAbsolute } from 'node:path';
import { createEvidenceDirectory } from './packaged-benchmark-options.mjs';
import { closeElectronApplication } from '../../scripts/verification/close-electron.mjs';
import { startTypingTrace, measureTypingTrace, typingTraceMark } from './presence-typing-trace.mjs';

// A hook smoke, not a packaged benchmark or a performance comparison.
const args = process.argv.slice(2);
if (args.length !== 2 || args[0] !== '--output') throw new Error('Usage: node tools/perf-profiling/presence-typing-trace-smoke.mjs --output <new-directory>');
const output = resolve(args[1]);
await createEvidenceDirectory(output);
const scratch = await mkdtemp(join(tmpdir(), 'dohc-presence-trace-'));
const require = createRequire(new URL('../../apps/desktop/package.json', import.meta.url));
const main = join(scratch, 'main.cjs');
await writeFile(main, `const {app,BrowserWindow}=require('electron');
app.whenReady().then(async()=>{const win=new BrowserWindow({width:900,height:700,webPreferences:{backgroundThrottling:false}});
await win.loadURL('data:text/html,<div contenteditable="true" style="height:500px">typing</div>');});
app.on('window-all-closed',()=>app.quit());`);
const env = { ...process.env }; delete env.ELECTRON_RUN_AS_NODE;
let app, trace;
try {
  app = await _electron.launch({ executablePath: require('electron'), args: [main, '--user-data-dir=' + join(scratch, 'profile')], env, timeout: 120_000 });
  await writeFile(join(output, 'instance.json'), JSON.stringify({ pid: app.process().pid, main, profile: join(scratch, 'profile') }, null, 2));
  const page = await app.firstWindow();
  await page.locator('[contenteditable]').click();
  await page.evaluate(() => {
    window.timing = { keys: [], events: [] };
    window.observer = new PerformanceObserver(list => window.timing.events.push(...list.getEntries().map(event => event.toJSON())));
    window.observer.observe({ type: 'event', durationThreshold: 16 });
    document.addEventListener('keydown', event => {
      window.timing.keys.push({ timestamp: performance.now(), eventTimestamp: event.timeStamp, trusted: event.isTrusted, key: event.key });
      // Alternate fast keys with a 25 ms handler so the rounding cross-check has
      // reported Event Timing entries even on a fast desktop. This is fixture code.
      if (window.slow) { const end = performance.now() + 25; while (performance.now() < end) {} }
    }, true);
  });
  const retryAfterPaint = () => page.evaluate(() => new Promise(done => requestAnimationFrame(() => requestAnimationFrame(done))));
  const clockBefore = await samplePresenceClock(page, { retryAfterPaint });
  trace = await startTypingTrace(page);
  const samples = [];
  for (let index = 0; index < 8; index++) {
    const start = await page.evaluate(({ mark, index }) => { window.slow = index % 2 === 1; performance.mark(mark); return performance.now(); }, { mark: typingTraceMark(index, 'before'), index });
    await page.keyboard.press('x');
    await page.evaluate(() => new Promise(done => requestAnimationFrame(() => requestAnimationFrame(done))));
    const end = await page.evaluate(mark => { performance.mark(mark); return performance.now(); }, typingTraceMark(index, 'after'));
    samples.push({ index, start, end });
  }
  const clockSync = validatePresenceClocks(clockBefore, await samplePresenceClock(page, { retryAfterPaint }));
  // The final fixture key has a 25 ms handler, so Event Timing must report it.
  // Two animation callbacks can precede compositor presentation. Keep tracing
  // until that key's presentation report arrives instead of ending mid-frame.
  await page.waitForFunction(() => {
    window.timing.events.push(...window.observer.takeRecords().map(event => event.toJSON()));
    const last = window.timing.keys.at(-1);
    return window.timing.events.some(event => event.name === 'keydown' && event.interactionId > 0 && Math.abs(event.startTime - last.eventTimestamp) <= 1);
  }, null, { timeout: 120_000 });
  const captured = await trace.stop();
  await writeFile(join(output, 'trace.json'), captured.raw);
  const timing = await page.evaluate(() => { window.timing.events.push(...window.observer.takeRecords().map(event => event.toJSON())); window.observer.disconnect(); return window.timing; });
  const measured = measureTypingTrace(captured.events, samples, timing);
  const result = { ...measured, browser: captured.browser, categories: captured.categories, clockSync, timing };
  await writeFile(join(output, 'result.json'), JSON.stringify(result, null, 2));
  console.log(JSON.stringify({ browser: result.browser, categories: result.categories, clockSync, validation: result.validation }, null, 2));
  assert.equal(result.validation.pass, true);
  assert.ok(result.validation.eventTimingChecked > 0, 'Smoke must exercise the Event Timing cross-check');
} finally {
  try { if (trace) await trace.stop(); }
  finally {
    if (app) await closeElectronApplication(app, app.process());
    const owned = relative(resolve(tmpdir()), resolve(scratch));
    assert.ok(!isAbsolute(owned) && !owned.startsWith('..') && owned.startsWith('dohc-presence-trace-'));
    await rm(scratch, { recursive: true, force: true });
  }
}
