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
  vi.stubGlobal('__DOHC_RELEASE_ASSETS__', [
    { name: 'dohc-arm64.dmg', browser_download_url: 'https://example.com/arm64.dmg' },
    { name: 'dohc-x64.dmg', browser_download_url: 'https://example.com/x64.dmg' },
  ]);
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
    expect(card.href).toBe(href);
    expect(card.classList.contains('is-preferred')).toBe(preferred);
    expect(Boolean(card.querySelector('.download-card-match'))).toBe(preferred);
  });
});

it('hands sync autoplay to keyboard input while its typing animation is active', async () => {
  await mount('#sync');
  const editor = document.querySelector('[data-sync-editor="a"]');
  const other = document.querySelector('[data-sync-editor="b"]');
  const initial = editor.value;
  intersections.find(io => io.target.matches('[data-sync-demo]')).callback([{ isIntersecting: true }]);
  await vi.advanceTimersByTimeAsync(1500);
  expect(editor.value.length).toBeGreaterThan(initial.length);
  editor.focus();
  editor.value += 'X';
  editor.dispatchEvent(new Event('input', { bubbles: true }));
  const typed = editor.value;
  expect(document.querySelector('[data-sync-hint]').textContent).toContain('your turn');
  await vi.advanceTimersByTimeAsync(12000);
  expect(editor.value).toBe(typed);
  expect(other.value).toBe(typed);
  expect(document.querySelector('[data-sync-toggle]').checked).toBe(true);
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
