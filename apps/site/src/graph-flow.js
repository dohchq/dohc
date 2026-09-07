export function createGraphFlow(graph) {
  const svg = graph.querySelector('.principles-edges');
  const canvas = graph.querySelector('.principles-graph-canvas');
  const reduced = matchMedia('(prefers-reduced-motion: reduce)');
  const compact = matchMedia('(max-width: 720px)');
  const lifetime = new AbortController();
  const layer = document.createElementNS('http://www.w3.org/2000/svg', 'g');
  layer.setAttribute('class', 'graph-flow');
  svg.append(layer);
  const shape = (tag, className) => {
    const element = document.createElementNS(svg.namespaceURI, tag);
    element.setAttribute('class', className);
    layer.append(element);
    return element;
  };
  const arrivals = new Map();
  const routes = [...svg.querySelectorAll('[data-connects]')].map((edge, index) => {
    const [source, target] = edge.dataset.connects.split(' ');
    for (const id of [source, target]) {
      if (!arrivals.has(id)) arrivals.set(id, { ring: shape('circle', 'graph-arrival'), energy: 0, x: 0, y: 0 });
    }
    const trail = shape('line', 'graph-packet-trail');
    const dot = shape('circle', 'graph-packet');
    dot.setAttribute('r', '2.3');
    return { edge, source, target, trail, dot, duration: 5.8 + (index % 4) * .8, phase: index * .618, reverse: index % 2 === 0 };
  });
  const eventLine = shape('line', 'graph-event-line');
  const badge = document.createElement('span');
  badge.className = 'graph-event-badge';
  badge.setAttribute('aria-hidden', 'true');
  canvas.append(badge);
  const events = [
    { label: 'Link shared', kind: 'sharing' },
    { label: 'Version saved', kind: 'history' },
    { label: 'Can edit', kind: 'sharing' },
    { label: 'Version saved', kind: 'history' },
    { label: 'Can view', kind: 'sharing' },
    { label: 'Version saved', kind: 'history' },
    { label: 'Access updated', kind: 'sharing' },
    { label: 'Earlier version restored', kind: 'history', restored: true },
  ].map(event => ({ ...event, routes: routes.filter(route => route.edge.dataset.connectionKind === event.kind) }));
  let lastEvent = -1;
  let visible = false;
  let previous = 0;
  let elapsed = 0;

  function visibility() {
    previous = 0;
    const running = visible && !document.hidden && !reduced.matches;
    layer.style.display = running ? '' : 'none';
    badge.hidden = !running;
  }
  function render() {
    if (!visible || document.hidden || reduced.matches) return;
    const now = performance.now();
    elapsed += previous ? Math.min((now - previous) / 1000, .05) : 0;
    previous = now;
    arrivals.forEach(arrival => { arrival.energy = 0; });
    for (const route of routes) {
      const { edge, dot, trail, source, target } = route;
      const x1 = Number(edge.getAttribute('x1')), y1 = Number(edge.getAttribute('y1'));
      const x2 = Number(edge.getAttribute('x2')), y2 = Number(edge.getAttribute('y2'));
      Object.assign(arrivals.get(source), { x: x1, y: y1 });
      Object.assign(arrivals.get(target), { x: x2, y: y2 });
      const clock = elapsed / route.duration + route.phase;
      const cycle = Math.floor(clock);
      const progress = (clock - cycle) / .68;
      const reverse = route.reverse !== (cycle % 2 === 0);
      const travel = Math.min(progress, 1);
      const t = reverse ? 1 - travel : travel;
      const length = Math.hypot(x2 - x1, y2 - y1);
      const tail = Math.max(0, Math.min(1, t + (reverse ? 1 : -1) * 12 / Math.max(length, 1)));
      const opacity = progress < 1 ? Math.min(1, progress * 10, (1 - progress) * 10) * .7 : 0;
      const x = x1 + (x2 - x1) * t, y = y1 + (y2 - y1) * t;
      dot.setAttribute('cx', x); dot.setAttribute('cy', y); dot.style.opacity = opacity;
      trail.setAttribute('x1', x1 + (x2 - x1) * tail); trail.setAttribute('y1', y1 + (y2 - y1) * tail);
      trail.setAttribute('x2', x); trail.setAttribute('y2', y); trail.style.opacity = opacity * .35;
      // A short ring begins when a packet reaches its destination.
      const arrival = arrivals.get(reverse ? source : target);
      if (progress >= .98 && progress < 1.2) arrival.energy = Math.max(arrival.energy, 1 - (progress - .98) / .22);
    }
    for (const [id, arrival] of arrivals) {
      const base = id === 'core' ? (compact.matches ? 27 : 33) : (compact.matches ? 18 : 21);
      arrival.ring.setAttribute('cx', arrival.x); arrival.ring.setAttribute('cy', arrival.y);
      arrival.ring.setAttribute('r', base + (1 - arrival.energy) * 8);
      arrival.ring.style.opacity = arrival.energy * .28;
    }
    // One brief event at a time, using the graph's existing animation clock.
    const eventTime = Math.max(0, elapsed - 1.4);
    const eventIndex = Math.floor(eventTime / 7.2);
    const age = eventTime % 7.2;
    const event = events[eventIndex % events.length];
    const route = event.routes[Math.floor(eventIndex / 2) % event.routes.length];
    const opacity = elapsed > 1.4 && age < 3 ? Math.max(0, Math.min(1, age / .35, (3 - age) / .5)) : 0;
    badge.style.opacity = opacity;
    eventLine.style.opacity = opacity * .45;
    if (opacity > 0 && route) {
      if (lastEvent !== eventIndex) {
        badge.textContent = event.label;
        lastEvent = eventIndex;
      }
      for (const attribute of ['x1', 'y1', 'x2', 'y2']) eventLine.setAttribute(attribute, route.edge.getAttribute(attribute));
      eventLine.style.strokeDashoffset = String(age * (event.restored ? -12 : 12));
      const middle = axis => (Number(route.edge.getAttribute(`${axis}1`)) + Number(route.edge.getAttribute(`${axis}2`))) / 2;
      const width = svg.viewBox.baseVal.width;
      const inset = event.restored ? 76 : 56;
      badge.style.left = `${Math.max(inset, Math.min(width - inset, middle('x')))}px`;
      badge.style.top = `${middle('y')}px`;
      badge.style.transform = `translate(-50%, calc(-50% + ${(1 - opacity) * 3}px))`;
    }
  }
  document.addEventListener('visibilitychange', visibility, { signal: lifetime.signal });
  reduced.addEventListener('change', visibility, { signal: lifetime.signal });
  visibility();
  if (import.meta.hot) import.meta.hot.dispose(() => { lifetime.abort(); layer.remove(); badge.remove(); });
  return { render, setVisible(value) { visible = value; visibility(); } };
}
