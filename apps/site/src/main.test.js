// @vitest-environment jsdom
import { expect, it, vi } from 'vitest';
import html from '../index.html?raw';

const state = vi.hoisted(() => ({ fail: true }));
vi.mock('./ProductDemo', async () => {
  const { createElement } = await import('react');
  return { ProductDemo: () => {
    if (state.fail) throw new Error('Demo render failed');
    return createElement('p', null, 'Workspace ready');
  } };
});
vi.mock('./demoDesktopBridge', () => ({ hydrateDemoWorkspaceAssets: vi.fn(async () => {}) }));

it('restores an operable loader after a React render error and retries with a fresh root', async () => {
  const fixture = new DOMParser().parseFromString(html, 'text/html');
  const host = fixture.querySelector('#desktop-demo').cloneNode(true);
  document.body.append(host);
  let appear;
  vi.stubGlobal('IntersectionObserver', class {
    constructor(callback) { appear = callback; }
    observe() {}
    disconnect() {}
  });
  const errors = vi.spyOn(console, 'error').mockImplementation(() => {});
  try {
    await import('./main.tsx');
    appear([{ isIntersecting: true }]);
    const retry = host.querySelector('[data-demo-retry]');
    await vi.waitFor(() => expect(retry.hidden).toBe(false));
    expect(host.querySelector('[data-demo-status]').textContent).toContain('could not load');
    expect(host.shadowRoot.querySelector('slot').assignedElements()).toContain(host.querySelector('.demo-loading'));
    expect(errors).toHaveBeenCalledWith('Unable to load the interactive dohc demo', expect.objectContaining({ message: 'Demo render failed' }));
    state.fail = false;
    retry.click();
    await vi.waitFor(() => expect(host.shadowRoot.querySelector('#root')?.textContent).toBe('Workspace ready'));
    expect(host.shadowRoot.querySelector('slot')).toBeNull();
  } finally {
    errors.mockRestore();
    vi.unstubAllGlobals();
    host.remove();
  }
});
