// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import html from '../index.html?raw';

const fixture = new DOMParser().parseFromString(html, 'text/html');
let intersections;
beforeEach(() => {
  vi.resetModules();
  vi.useFakeTimers();
  intersections = [];
  vi.stubGlobal('matchMedia', () => ({ matches: false, addEventListener() {} }));
  vi.stubGlobal('IntersectionObserver', class {
    constructor(callback) { this.callback = callback; intersections.push(this); }
    observe(target) { this.target = target; }
    disconnect() {}
    unobserve() {}
  });
  vi.stubGlobal('fetch', vi.fn(async () => Response.json([{ draft: false, prerelease: false, assets: [
    { name: 'dohc-arm64.dmg', browser_download_url: 'https://example.com/arm64.dmg' },
    { name: 'dohc-x64.dmg', browser_download_url: 'https://example.com/x64.dmg' },
  ] }])));
  document.body.innerHTML = '';
});
afterEach(() => { vi.clearAllTimers(); vi.useRealTimers(); vi.unstubAllGlobals(); });

const mount = async (selector) => {
  document.body.append(fixture.querySelector(selector).cloneNode(true));
  await import('../site.js');
  await Promise.resolve();
};

describe('receipt split', () => {
  it('keeps the final participant assigned and allows reassignment through another person', async () => {
    await mount('[data-agent-demo]');
    const choose = (who) => document.querySelector(`[data-person="${who}"]`).click();
    const iceCream = () => Array.from(document.querySelectorAll('.app-item')).find(row => row.textContent.includes('ice cream')).querySelector('input');
    choose('sam');
    expect(iceCream().checked).toBe(true);
    expect(iceCream().disabled).toBe(true);
    iceCream().click();
    expect(iceCream().checked).toBe(true);
    choose('you');
    iceCream().click();
    choose('sam');
    expect(iceCream().disabled).toBe(false);
    iceCream().click();
    choose('you');
    expect(iceCream().checked).toBe(true);
    expect(iceCream().disabled).toBe(true);
  });

  it('can undo each settled transfer without changing receipt shares', async () => {
    await mount('[data-agent-demo]');
    const button = document.querySelector('[data-settle="you>maya"]');
    const originalAmount = document.querySelector('[data-split-amount]').textContent;
    button.click();
    const undo = document.querySelector('[data-settle="you>maya"]');
    expect(undo.textContent).toBe('Undo');
    expect(undo.getAttribute('aria-label')).toBe('Undo settlement from you to Maya');
    undo.click();
    expect(document.querySelector('[data-split-amount]').textContent).toBe(originalAmount);
    expect(document.querySelector('[data-settle="you>maya"]').textContent).toBe('Settle');
  });
});

describe('download architecture', () => {
  it.each([
    [undefined, 'mac', 'https://github.com/dohc-ai/dohc/releases', false],
    ['arm', 'mac-arm64', 'https://example.com/arm64.dmg', true],
    ['x86', 'mac-x64', 'https://example.com/x64.dmg', true],
  ])('uses only positively reported Mac architecture (%s)', async (architecture, key, href, preferred) => {
    vi.stubGlobal('navigator', {
      userAgent: 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7)',
      platform: 'MacIntel', maxTouchPoints: 0,
      userAgentData: { getHighEntropyValues: async () => ({ architecture }) },
    });
    await mount('#downloads');
    const card = document.querySelector(`[data-download-card="${key}"]`);
    expect(fetch).not.toHaveBeenCalled();
    expect(card.href).toBe('https://github.com/dohc-ai/dohc/releases');
    card.dispatchEvent(new Event('pointerenter'));
    await vi.waitFor(() => expect(fetch).toHaveBeenCalledOnce());
    await vi.waitFor(() => expect(card.href).toBe(href));
    expect(card.href).toBe(href);
    expect(card.classList.contains('is-preferred')).toBe(preferred);
    expect(Boolean(card.querySelector('.download-card-match'))).toBe(preferred);
  });
});

it('resolves current release assets on first activation before navigating', async () => {
  const navigate = vi.fn();
  vi.stubGlobal('window', { IntersectionObserver, location: { assign: navigate } });
  vi.mocked(fetch).mockImplementation(async () => Response.json([{ draft: false, prerelease: false, assets: [
    { name: 'dohc-x64.exe', browser_download_url: 'https://example.com/new-release.exe' },
  ] }]));
  await mount('#downloads');
  const card = document.querySelector('[data-download-card="windows-x64"]');
  expect(fetch).not.toHaveBeenCalled();
  const click = new MouseEvent('click', { bubbles: true, cancelable: true, button: 0 });
  card.dispatchEvent(click);
  expect(click.defaultPrevented).toBe(true);
  expect(navigate).not.toHaveBeenCalled();
  await vi.waitFor(() => expect(navigate).toHaveBeenCalledWith('https://example.com/new-release.exe'));
  card.dispatchEvent(new Event('pointerenter'));
  card.dispatchEvent(new Event('focus'));
  expect(fetch).toHaveBeenCalledOnce();
});

it('keeps a usable releases link when fresh asset resolution fails', async () => {
  const navigate = vi.fn();
  vi.stubGlobal('window', { IntersectionObserver, location: { assign: navigate } });
  vi.mocked(fetch).mockRejectedValue(new Error('offline'));
  await mount('#downloads');
  document.querySelector('[data-download-card="windows-x64"]').click();
  await vi.waitFor(() => expect(navigate).toHaveBeenCalledWith('https://github.com/dohc-ai/dohc/releases'));
});

it('hands sync autoplay to keyboard input while its typing animation is active', async () => {
  await mount('#sync');
  const editor = document.querySelector('[data-sync-editor="a"]');
  const other = document.querySelector('[data-sync-editor="b"]');
  const initial = editor.value;
  intersections.find(io => io.target.matches('[data-sync-demo]')).callback([{ isIntersecting: true }]);
  await vi.advanceTimersByTimeAsync(1500);
  expect(editor.value.length).toBeGreaterThan(initial.length);
  expect(other.value).not.toBe(editor.value);
  editor.focus();
  editor.value += 'X';
  const typed = editor.value;
  editor.dispatchEvent(new Event('input', { bubbles: true }));
  expect(editor.value).toBe(typed);
  expect(document.querySelector('[data-sync-hint]').textContent).toContain('your turn');
  await vi.advanceTimersByTimeAsync(12000);
  expect(editor.value).toBe(typed);
  expect(other.value).toBe(typed);
  expect(document.querySelector('[data-sync-toggle]').checked).toBe(true);
});

it.each(['pointerdown', 'disconnect'])('takes over partial connected copies without merging them (%s)', async (action) => {
  await mount('#sync');
  const editor = document.querySelector('[data-sync-editor="a"]');
  const other = document.querySelector('[data-sync-editor="b"]');
  const toggle = document.querySelector('[data-sync-toggle]');
  intersections.find(io => io.target.matches('[data-sync-demo]')).callback([{ isIntersecting: true }]);
  await vi.advanceTimersByTimeAsync(1500);
  const canonical = editor.value;
  expect(other.value).not.toBe(canonical);
  if (action === 'pointerdown') other.dispatchEvent(new Event('pointerdown'));
  else { toggle.checked = false; toggle.dispatchEvent(new Event('change')); }
  expect(editor.value).toBe(canonical);
  expect(other.value).toBe(canonical);
  await vi.advanceTimersByTimeAsync(5000);
  expect(editor.value).toBe(canonical);
  expect(other.value).toBe(canonical);
});

it('preserves both completed offline edits when reconnecting', async () => {
  await mount('#sync');
  const editor = document.querySelector('[data-sync-editor="a"]');
  const other = document.querySelector('[data-sync-editor="b"]');
  const toggle = document.querySelector('[data-sync-toggle]');
  toggle.checked = false;
  toggle.dispatchEvent(new Event('change'));
  const initial = editor.value;
  editor.value += ' Local edit.';
  editor.dispatchEvent(new Event('input'));
  other.value += ' Phone edit.';
  other.dispatchEvent(new Event('input'));
  toggle.checked = true;
  toggle.dispatchEvent(new Event('change'));
  await vi.advanceTimersByTimeAsync(2000);
  expect(editor.value).toBe(`${initial} Local edit. Phone edit.`);
  expect(other.value).toBe(editor.value);
});

it('settles a manual receive animation before disconnecting', async () => {
  await mount('#sync');
  const editor = document.querySelector('[data-sync-editor="a"]');
  const other = document.querySelector('[data-sync-editor="b"]');
  const toggle = document.querySelector('[data-sync-toggle]');
  editor.dispatchEvent(new Event('pointerdown'));
  editor.value += ' A complete new sentence.';
  const intended = editor.value;
  editor.dispatchEvent(new Event('input'));
  await vi.advanceTimersByTimeAsync(50);
  expect(other.value).not.toBe(intended);
  toggle.checked = false;
  toggle.dispatchEvent(new Event('change'));
  expect(editor.value).toBe(intended);
  expect(other.value).toBe(intended);
  toggle.checked = true;
  toggle.dispatchEvent(new Event('change'));
  await vi.advanceTimersByTimeAsync(2000);
  expect(editor.value).toBe(intended);
  expect(other.value).toBe(intended);
});

it('hands sync to the visitor when reduced motion is enabled during autoplay', async () => {
  const motion = Object.assign(new EventTarget(), { matches: false });
  vi.stubGlobal('matchMedia', () => motion);
  await mount('#sync');
  const editor = document.querySelector('[data-sync-editor="a"]');
  const other = document.querySelector('[data-sync-editor="b"]');
  intersections.find(io => io.target.matches('[data-sync-demo]')).callback([{ isIntersecting: true }]);
  await vi.advanceTimersByTimeAsync(1500);
  const canonical = editor.value;
  expect(other.value).not.toBe(canonical);
  motion.matches = true;
  motion.dispatchEvent(new Event('change'));
  expect(editor.value).toBe(canonical);
  expect(other.value).toBe(canonical);
  await vi.advanceTimersByTimeAsync(12000);
  expect(editor.value).toBe(canonical);
  editor.value += ' My own edit.';
  const intended = editor.value;
  editor.dispatchEvent(new Event('input'));
  motion.matches = false;
  motion.dispatchEvent(new Event('change'));
  await vi.advanceTimersByTimeAsync(12000);
  expect(editor.value).toBe(intended);
  expect(other.value).toBe(intended);
});

it('uses native file buttons and moves focus to the human selector after activation', async () => {
  await mount('[data-reader-showcase]');
  const agentSelector = document.querySelector('[data-reader-side="agent"]');
  agentSelector.focus();
  agentSelector.click();
  await vi.advanceTimersByTimeAsync(1000);
  const files = Array.from(document.querySelectorAll('[data-reader-pick]'));
  expect(document.querySelector('.reader-tree').getAttribute('role')).toBe('group');
  expect(document.querySelector('[role="tab"], [role="tabpanel"], [role="tablist"]')).toBeNull();
  expect(files.every(file => file.tabIndex === 0)).toBe(true);
  const file = files.find(button => button.dataset.readerPick === 'drawing');
  file.focus();
  // Native Enter activation dispatches click; no custom key handler or roving tab index.
  file.click();
  expect(file.getAttribute('aria-pressed')).toBe('true');
  expect(document.activeElement).toBe(document.querySelector('[data-reader-side="human"]'));
  await vi.advanceTimersByTimeAsync(1000);
  expect(document.querySelector('[data-reader-name]').textContent).toBe('Flow sketch');
  expect(document.querySelector('[data-reader-face="agent"]').getAttribute('aria-hidden')).toBe('true');
});

it('reads the current motion preference when changing reader content', async () => {
  const motion = Object.assign(new EventTarget(), { matches: false });
  vi.stubGlobal('matchMedia', () => motion);
  await mount('[data-reader-showcase]');
  motion.matches = true;
  motion.dispatchEvent(new Event('change'));
  document.querySelector('[data-reader-pick="drawing"]').click();
  expect(document.querySelector('[data-reader-name]').textContent).toBe('Flow sketch');
  expect(document.querySelector('[data-reader-view]').classList.contains('is-swapping')).toBe(false);
});

it('uses the graph owner visibility without creating another observer', async () => {
  const motion = Object.assign(new EventTarget(), { matches: false });
  vi.stubGlobal('matchMedia', () => motion);
  document.body.innerHTML = '<div data-graph><div class="principles-graph-canvas"><svg class="principles-edges"></svg></div></div>';
  const { createGraphFlow } = await import('./graph-flow.js');
  const flow = createGraphFlow(document.querySelector('[data-graph]'));
  const layer = document.querySelector('.graph-flow');
  expect(intersections).toHaveLength(0);
  expect(layer.style.display).toBe('none');
  flow.setVisible(true);
  expect(layer.style.display).toBe('');
  motion.matches = true;
  motion.dispatchEvent(new Event('change'));
  expect(layer.style.display).toBe('none');
  motion.matches = false;
  motion.dispatchEvent(new Event('change'));
  expect(layer.style.display).toBe('');
  flow.setVisible(false);
  expect(layer.style.display).toBe('none');
});

it('pauses reader autoplay for external selector focus while finishing the selected turn', async () => {
  document.body.append(fixture.querySelector('[data-reader-showcase]').cloneNode(true));
  const { createReaderFlip } = await import('./reader-flip.js');
  const showcase = document.querySelector('[data-reader-showcase]');
  const flip = createReaderFlip(showcase);
  intersections[0].callback([{ isIntersecting: true }]);
  const selector = showcase.querySelector('[data-reader-side="agent"]');
  const otherSelector = showcase.querySelector('[data-reader-side="human"]');
  selector.focus();
  selector.click();
  await vi.advanceTimersByTimeAsync(250);
  otherSelector.focus();
  await vi.advanceTimersByTimeAsync(750);
  expect(selector.getAttribute('aria-pressed')).toBe('true');
  const transform = showcase.querySelector('[data-readers]').style.transform;
  await vi.advanceTimersByTimeAsync(5000);
  expect(showcase.querySelector('[data-readers]').style.transform).toBe(transform);
  otherSelector.blur();
  await vi.advanceTimersByTimeAsync(3500);
  expect(showcase.querySelector('[data-reader-side="human"]').getAttribute('aria-pressed')).toBe('true');
  flip.destroy();
});
