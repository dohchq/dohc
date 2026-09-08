// @vitest-environment jsdom
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { mountEngine } from './engine-scene';

let worker, host, dispose, now, frames, reducedMotion;
beforeEach(() => {
  now = 100;
  frames = new Map();
  reducedMotion = false;
  let nextFrame = 0;
  vi.spyOn(performance, 'now').mockImplementation(() => now);
  vi.stubGlobal('requestAnimationFrame', callback => {
    frames.set(++nextFrame, callback);
    return nextFrame;
  });
  vi.stubGlobal('cancelAnimationFrame', id => frames.delete(id));
  vi.stubGlobal('Worker', class extends EventTarget {
    postMessage = vi.fn();
    terminate = vi.fn();
    constructor() { super(); worker = this; }
  });
  vi.stubGlobal('ResizeObserver', class { observe() {} disconnect() {} });
  vi.stubGlobal('IntersectionObserver', class { observe() {} disconnect() {} });
  vi.stubGlobal('matchMedia', () => ({ get matches() { return reducedMotion; }, addEventListener() {} }));
  vi.spyOn(document, 'hidden', 'get').mockReturnValue(false);
  vi.stubGlobal('devicePixelRatio', 1);
  Object.defineProperty(HTMLCanvasElement.prototype, 'transferControlToOffscreen', { configurable: true, value: () => ({}) });
  host = document.createElement('div');
  Object.defineProperties(host, { clientWidth: { value: 548 }, clientHeight: { value: 510 } });
  document.body.append(host);
});
afterEach(() => {
  dispose?.();
  host.remove();
  delete HTMLCanvasElement.prototype.transferControlToOffscreen;
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});
function tick(time) {
  now = time;
  const pending = [...frames.values()];
  frames.clear();
  pending.forEach(callback => callback(now));
}
function message(type) { worker.dispatchEvent(new MessageEvent('message', { data: { type } })); }
function views() { return worker.postMessage.mock.calls.map(([value]) => value).filter(value => value.type === 'view'); }

it('keeps the initial pose until the first frame is rendered, then rotates without catching up startup time', () => {
  dispose = mountEngine(host);
  expect(views()).toHaveLength(0);
  message('ready');
  tick(5000);
  expect(views()).toHaveLength(1);
  expect(views()[0].view.theta).toBe(Math.atan2(10, 7));
  expect(views()[0].view.phi).toBe(Math.atan2(Math.hypot(10, 7), 6.5));
  expect(frames.size).toBe(0);
  expect(host.classList.contains('engine-loaded')).toBe(false);
  tick(15000);
  message('rendered');
  expect(host.classList.contains('engine-loaded')).toBe(true);
  tick(15020);
  const rotation = views()[0].view.theta - views()[1].view.theta;
  expect(rotation).toBeCloseTo(Math.PI * 2 / 60 * .28 * .02);
  expect(frames.size).toBe(1);
});

it('shows the same stationary pose for reduced motion without running a continuous loop', () => {
  reducedMotion = true;
  dispose = mountEngine(host);
  message('ready');
  tick(5000);
  message('rendered');
  tick(5020);
  expect(views().every(({ view }) => view.theta === Math.atan2(10, 7))).toBe(true);
  expect(frames.size).toBe(0);
});

it('restores the preview and stops animation when the renderer fails after loading', () => {
  vi.spyOn(console, 'error').mockImplementation(() => {});
  dispose = mountEngine(host);
  message('ready');
  tick(5000);
  message('rendered');
  message('error');
  expect(host.classList.contains('engine-loaded')).toBe(false);
  expect(host.querySelector('canvas')).toBeNull();
  expect(worker.terminate).toHaveBeenCalledOnce();
  expect(frames.size).toBe(0);
});
