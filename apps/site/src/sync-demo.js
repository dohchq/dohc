export function mergeSyncEdits(basis, left, right) {
  if (left === right) return left;
  if (left === basis) return right;
  if (right === basis) return left;
  const original = Array.from(basis);
  const unchanged = (start, end) => original.slice(start, end).join('');
  const edit = (value) => {
    const characters = Array.from(value);
    let start = 0;
    while (start < original.length && start < characters.length && original[start] === characters[start]) start++;
    let end = original.length;
    let valueEnd = characters.length;
    while (end > start && valueEnd > start && original[end - 1] === characters[valueEnd - 1]) { end--; valueEnd--; }
    return { start, end, text: characters.slice(start, valueEnd).join('') };
  };
  const a = edit(left);
  const b = edit(right);
  const [first, second] = a.start <= b.start ? [a, b] : [b, a];
  if (first.end <= second.start) {
    return unchanged(0, first.start) + first.text + unchanged(first.end, second.start) + second.text + unchanged(second.end);
  }
  // Overlapping replacements keep both insertions, in laptop/phone order.
  return unchanged(0, first.start) + a.text + b.text + unchanged(Math.max(a.end, b.end));
}

export function createSyncDemo(syncDemo) {
  const motion = matchMedia('(prefers-reduced-motion: reduce)');
  let reduced = motion.matches;
  const a = syncDemo.querySelector('[data-sync-editor="a"]');
  const b = syncDemo.querySelector('[data-sync-editor="b"]');
  const toggle = document.querySelector('[data-sync-toggle]');
  const hint = document.querySelector('[data-sync-hint]');
  const link = syncDemo.querySelector('[data-sync-link]');
  const linkLabel = syncDemo.querySelector('[data-sync-link-label]');
  const signal = syncDemo.querySelector('[data-sync-signal]');
  const clock = syncDemo.querySelector('[data-sync-clock]');
  const state = { a: syncDemo.querySelector('[data-sync-state="a"]'), b: syncDemo.querySelector('[data-sync-state="b"]') };
  const foot = { a: syncDemo.querySelector('[data-sync-foot="a"]'), b: syncDemo.querySelector('[data-sync-foot="b"]') };
  const START = a.value;
  let base = START;
  let manual = false;
  // The checkbox has already changed when its change event reaches takeover.
  let connected = toggle.checked;
  let timers = [];

  if (clock) {
    const now = new Date();
    clock.textContent = `${now.getHours() % 12 || 12}:${String(now.getMinutes()).padStart(2, '0')}`;
  }

  // Schedule fn on the next frame, but no later than 50ms, so streams keep
  // moving in a hidden or throttled tab. Returns a handle for cancelTick.
  const tick = (fn) => {
    const handle = { done: false };
    const run = (now) => {
      if (handle.done) return;
      handle.done = true;
      cancelAnimationFrame(handle.raf);
      clearTimeout(handle.timer);
      fn(now || performance.now());
    };
    handle.raf = requestAnimationFrame(run);
    handle.timer = setTimeout(run, 50);
    return handle;
  };
  const cancelTick = (handle) => {
    if (!handle) return;
    handle.done = true;
    cancelAnimationFrame(handle.raf);
    clearTimeout(handle.timer);
  };

  // One pending swap per label, so a fast pair of changes can't land out
  // of order and leave a stale word on screen.
  const pendingSwap = new WeakMap();
  const swapText = (el, text) => {
    clearTimeout(pendingSwap.get(el));
    if (el.textContent === text) { el.classList.remove('is-swapping'); return; }
    if (reduced) { el.textContent = text; return; }
    el.classList.add('is-swapping');
    pendingSwap.set(el, setTimeout(() => { el.textContent = text; el.classList.remove('is-swapping'); }, 180));
  };
  const setStatus = (key, text, footText) => {
    swapText(state[key], text);
    swapText(foot[key], footText);
  };
  const savedOn = (key) => (key === 'a' ? 'saved on this laptop' : 'saved on this phone');

  // Stream an editor toward a target value from where they diverge.
  const receiving = { a: null, b: null };
  const keyOf = (el) => (el === a ? 'a' : 'b');
  const stopReceiving = (el) => {
    cancelTick(receiving[keyOf(el)]);
    receiving[keyOf(el)] = null;
    el.classList.remove('is-receiving');
  };
  const receive = (el, target) => {
    const key = keyOf(el);
    stopReceiving(el);
    if (reduced || el.value === target) { el.value = target; return; }
    let start = 0;
    while (start < el.value.length && start < target.length && el.value[start] === target[start]) start += 1;
    const remaining = target.length - start;
    const duration = Math.min(1400, Math.max(240, remaining * 16));
    const t0 = performance.now();
    el.value = target.slice(0, start);
    el.classList.add('is-receiving');
    const frame = (now) => {
      const p = Math.min(1, (now - t0) / duration);
      const eased = 1 - (1 - p) * (1 - p);
      el.value = target.slice(0, start + Math.round(remaining * eased));
      if (p < 1) receiving[key] = tick(frame);
      else { receiving[key] = null; el.value = target; el.classList.remove('is-receiving'); }
    };
    receiving[key] = tick(frame);
  };

  const onInput = (from) => {
    stopReceiving(from);
    const other = from === a ? b : a;
    const key = keyOf(from);
    const otherKey = keyOf(other);
    if (toggle.checked) {
      receive(other, from.value);
      base = from.value;
      setStatus(key, 'in sync', savedOn(key));
      setStatus(otherKey, 'in sync', 'just updated');
    } else {
      setStatus(key, 'offline', 'saved here · will sync later');
    }
  };

  const setConnection = (on) => {
    connected = on;
    toggle.checked = on;
    link.classList.toggle('is-off', !on);
    if (signal) signal.classList.toggle('is-off', !on);
    if (on) {
      const merged = mergeSyncEdits(base, a.value, b.value);
      const changed = merged !== a.value || merged !== b.value;
      base = merged;
      receive(a, merged);
      receive(b, merged);
      swapText(linkLabel, 'connected');
      setStatus('a', 'in sync', changed ? 'changes synced' : savedOn('a'));
      setStatus('b', 'in sync', changed ? 'changes synced' : savedOn('b'));
      swapText(hint, changed ? 'back online. nothing was lost.' : (manual ? 'try typing on either device' : 'watching. click or type to take over.'));
    } else {
      swapText(linkLabel, 'no connection');
      setStatus('a', 'offline', 'saved here · will sync later');
      setStatus('b', 'offline', 'saved here · will sync later');
      swapText(hint, manual ? 'now type on both, then turn it back on' : 'no signal. both devices keep working.');
    }
  };

  // ---------- autoplay ----------
  let typeFrame = null;
  let autoplayVisible = false;
  const foregroundWaiters = new Set();
  const canAutoplay = () => autoplayVisible && !document.hidden;
  const whenVisible = () => manual || canAutoplay() ? Promise.resolve() : new Promise(resolve => foregroundWaiters.add(resolve));
  const resumeAutoplay = () => {
    syncDemo.classList.toggle('is-autoplay-paused', !manual && !canAutoplay());
    if (manual || canAutoplay()) {
      foregroundWaiters.forEach(resolve => resolve());
      foregroundWaiters.clear();
    }
  };
  const wait = async (ms) => {
    await whenVisible();
    if (manual) return;
    await new Promise((resolve) => {
      const timer = setTimeout(() => { timers = timers.filter(id => id !== timer); resolve(); }, ms);
      timers.push(timer);
    });
    await whenVisible();
  };
  const clearTimers = () => {
    timers.forEach(clearTimeout);
    timers = [];
    cancelTick(typeFrame);
    typeFrame = null;
  };

  const type = (el, text) => new Promise((resolve) => {
    const startValue = el.value;
    let t0 = performance.now();
    let shown = 0;
    const frame = (now) => {
      if (manual) { typeFrame = null; resolve(); return; }
      if (!canAutoplay()) {
        const pausedAt = performance.now();
        typeFrame = null;
        whenVisible().then(() => { t0 += performance.now() - pausedAt; typeFrame = tick(frame); });
        return;
      }
      const want = Math.min(text.length, Math.floor((now - t0) / 42));
      if (want > shown) {
        shown = want;
        el.value = startValue + text.slice(0, shown);
        onInput(el);
      }
      if (shown < text.length) typeFrame = tick(frame);
      else { typeFrame = null; resolve(); }
    };
    typeFrame = tick(frame);
  });

  const resetEditors = async () => {
    if (a.value === START && b.value === START) return;
    a.classList.add('is-fading');
    b.classList.add('is-fading');
    await wait(380);
    if (manual) return;
    a.value = START; b.value = START; base = START;
    a.classList.remove('is-fading');
    b.classList.remove('is-fading');
    await wait(420);
  };

  const play = async () => {
    while (!manual) {
      await resetEditors(); if (manual) break;
      setConnection(true);
      swapText(hint, 'watching. click or type to take over.');
      await wait(1200); if (manual) break;
      await type(a, ' Underline the bit about habits.'); if (manual) break;
      await wait(1400); if (manual) break;
      setConnection(false);
      await wait(1300); if (manual) break;
      await type(b, ' Ask Dana if she has read it.'); if (manual) break;
      await wait(500); if (manual) break;
      await type(a, ' Chapter 4 next week.'); if (manual) break;
      await wait(1400); if (manual) break;
      setConnection(true);
      await wait(5000);
    }
  };

  const takeOver = (edited) => {
    if (manual && edited) return;
    manual = true;
    resumeAutoplay();
    clearTimers();
    [a, b].forEach((el) => { stopReceiving(el); el.classList.remove('is-fading'); });
    if (connected) {
      base = edited ? edited.value : base;
      a.value = base; b.value = base;
    }
    hint.textContent = toggle.checked ? 'your turn. try typing on either device' : 'now type on both, then turn it back on';
  };

  a.addEventListener('input', () => { takeOver(a); onInput(a); });
  b.addEventListener('input', () => { takeOver(b); onInput(b); });
  a.addEventListener('pointerdown', () => takeOver());
  b.addEventListener('pointerdown', () => takeOver());
  toggle.addEventListener('change', () => { takeOver(); setConnection(toggle.checked); });

  motion.addEventListener('change', () => {
    reduced = motion.matches;
    if (reduced) {
      takeOver();
      hint.textContent = 'try typing on either device';
    }
  });

  if (reduced) {
    manual = true;
    hint.textContent = 'try typing on either device';
  } else {
    // Start when the section is close to view so the loop isn't half over
    // by the time anyone sees it.
    let started = false;
    const start = () => { if (!started) { started = true; play(); } };
    document.addEventListener('visibilitychange', resumeAutoplay);
    if ('IntersectionObserver' in window) {
      const io = new IntersectionObserver((entries) => {
        autoplayVisible = entries.some((entry) => entry.isIntersecting);
        resumeAutoplay();
        if (autoplayVisible) start();
      });
      io.observe(syncDemo);
    } else {
      autoplayVisible = true;
      start();
    }
  }
}
