function createSlabShell(panel) {
  const shell = document.createElement('div');
  shell.className = 'reader-slab-shell';
  shell.setAttribute('aria-hidden', 'true');
  for (const side of ['top', 'right', 'bottom', 'left']) {
    const wall = document.createElement('i');
    wall.className = `reader-slab-wall is-${side}`;
    shell.append(wall);
  }
  const radius = parseFloat(getComputedStyle(panel).getPropertyValue('--slab-radius'));
  const segments = 8;
  const step = Math.PI / (2 * segments);
  // Chords close the rounded perimeter between the two readable faces.
  for (const [corner, start] of [['tl', Math.PI], ['tr', Math.PI * 1.5], ['br', 0], ['bl', Math.PI / 2]]) {
    const arc = document.createElement('div');
    arc.className = `reader-slab-corner is-${corner}`;
    for (let index = 0; index < segments; index++) {
      const theta = start + (index + .5) * step;
      const distance = radius * Math.cos(step / 2);
      const facet = document.createElement('i');
      facet.className = 'reader-slab-facet';
      facet.style.width = `${2 * radius * Math.sin(step / 2) + .15}px`;
      facet.style.left = `${distance * Math.cos(theta)}px`;
      facet.style.top = `${distance * Math.sin(theta)}px`;
      facet.style.transform = `translate(-50%, -50%) rotateZ(${theta * 180 / Math.PI + 90}deg) rotateX(90deg)`;
      facet.style.filter = `brightness(${.78 + .22 * Math.max(0, -.6 * Math.cos(theta) - .8 * Math.sin(theta))})`;
      arc.append(facet);
    }
    shell.append(arc);
  }
  panel.prepend(shell);
  return shell;
}

export function createReaderFlip(showcase) {
  const panel = showcase.querySelector('[data-readers]');
  const shell = createSlabShell(panel);
  const faces = Array.from(panel.querySelectorAll('[data-reader-face]'));
  const selectors = Array.from(showcase.querySelectorAll('[data-reader-side]'));
  const reduced = matchMedia('(prefers-reduced-motion: reduce)');
  const listeners = new AbortController();
  const on = (target, event, handler) => target.addEventListener(event, handler, { signal: listeners.signal });
  let angle = 0;
  let tilt = 0;
  let shownSide = null;
  let drag = null;
  let frame = 0;
  let timer = 0;
  let visible = false;
  let suppressClick = false;
  let clickTimer = 0;

  const nearest = () => Math.round((angle - 8) / 180) * 180;
  const canPlay = () => visible && !document.hidden && !reduced.matches && !drag && !panel.contains(document.activeElement);
  const stop = () => { clearTimeout(timer); cancelAnimationFrame(frame); };
  const paint = () => {
    const yaw = angle - 8;
    panel.style.transform = `rotateX(${tilt + 3}deg) rotateY(${yaw}deg)`;
    showcase.style.setProperty('--slab-shadow-scale', String(1 - Math.abs(Math.sin(yaw * Math.PI / 180)) * .76));
    const side = Math.cos(yaw * Math.PI / 180) >= 0 ? 'human' : 'agent';
    if (side === shownSide) return;
    shownSide = side;
    for (const face of faces) {
      const hidden = face.dataset.readerFace !== side;
      face.inert = hidden;
      face.setAttribute('aria-hidden', String(hidden));
    }
    for (const selector of selectors) selector.setAttribute('aria-pressed', String(selector.dataset.readerSide === side));
  };
  const schedule = () => {
    clearTimeout(timer);
    if (canPlay()) timer = setTimeout(() => {
      if (!canPlay()) return;
      // Alternate directions, so this reads as two sides of one panel.
      turn(Math.cos(angle * Math.PI / 180) >= 0 ? 180 : 0, 1300);
    }, 2000);
  };
  const turn = (target, duration = 750) => {
    stop();
    const from = angle;
    const fromTilt = tilt;
    const start = performance.now();
    const tick = (now) => {
      const progress = reduced.matches ? 1 : Math.min(1, (now - start) / duration);
      const eased = progress * progress * progress * (progress * (progress * 6 - 15) + 10);
      angle = from + (target - from) * eased;
      tilt = fromTilt * (1 - eased);
      paint();
      if (progress < 1) frame = requestAnimationFrame(tick);
      else {
        // Normalize after settling; a long drag must not cause extra autoplay spins.
        angle = ((target % 360) + 360) % 360;
        paint();
        schedule();
      }
    };
    if (reduced.matches) tick(start);
    else frame = requestAnimationFrame(tick);
  };
  const show = (side, focus = false) => {
    const target = side === 'human' ? 0 : 180;
    if (focus) selectors.find(button => button.dataset.readerSide === side).focus({ preventScroll: true });
    const delta = ((target - angle + 540) % 360 + 360) % 360 - 180;
    turn(angle + delta);
  };

  for (const selector of selectors) on(selector, 'click', () => show(selector.dataset.readerSide));
  on(panel, 'pointerdown', event => {
    if (!event.isPrimary || event.button !== 0 || event.target.closest('button, a, input, textarea, select, [contenteditable]')) return;
    stop();
    drag = { id: event.pointerId, x: event.clientX, y: event.clientY, angle, moved: false };
    if (panel.contains(document.activeElement)) document.activeElement.blur();
    panel.setPointerCapture(event.pointerId);
    panel.classList.add('is-dragging');
  });
  on(panel, 'pointermove', event => {
    if (!drag || drag.id !== event.pointerId) return;
    const dx = event.clientX - drag.x;
    const dy = event.clientY - drag.y;
    if (!drag.moved && Math.abs(dx) < 6) return;
    if (event.pointerType === 'touch' && !drag.moved && Math.abs(dy) > Math.abs(dx)) return;
    drag.moved = true;
    angle = drag.angle + dx * 180 / (panel.clientWidth * .7);
    tilt = event.pointerType === 'touch' ? 0 : Math.max(-8, Math.min(8, -dy * .08));
    paint();
  });
  const release = event => {
    if (!drag || drag.id !== event.pointerId) return;
    suppressClick = drag.moved && event.type === 'pointerup';
    clearTimeout(clickTimer);
    clickTimer = setTimeout(() => { suppressClick = false; }, 0);
    drag = null;
    panel.classList.remove('is-dragging');
    if (panel.hasPointerCapture(event.pointerId)) panel.releasePointerCapture(event.pointerId);
    turn(nearest(), 450);
  };
  on(panel, 'pointerup', release);
  on(panel, 'pointercancel', release);
  on(panel, 'lostpointercapture', release);
  panel.addEventListener('click', event => {
    if (!suppressClick) return;
    suppressClick = false;
    event.preventDefault();
    event.stopPropagation();
  }, { capture: true, signal: listeners.signal });
  on(panel, 'focusin', () => { stop(); angle = nearest(); tilt = 0; paint(); });
  on(panel, 'focusout', () => queueMicrotask(schedule));
  const visibility = () => {
    if (document.hidden || !visible) {
      stop();
      angle = nearest();
      tilt = 0;
      paint();
    } else schedule();
  };
  on(document, 'visibilitychange', visibility);
  on(reduced, 'change', () => {
    turn(nearest(), 350);
  });
  const observer = new IntersectionObserver(entries => {
    visible = entries[0].isIntersecting;
    visibility();
  }, { threshold: .2 });
  observer.observe(showcase);
  paint();

  const destroy = () => { stop(); clearTimeout(clickTimer); observer.disconnect(); listeners.abort(); shell.remove(); };
  if (import.meta.hot) import.meta.hot.dispose(destroy);
  return { show, destroy };
}
