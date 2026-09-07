import { createSyncDemo } from './src/sync-demo.js';
import { createReaderFlip } from './src/reader-flip.js';
import { createGraphFlow } from './src/graph-flow.js';
import { releaseAssets } from './release-assets.ts';

// dohc marketing site: downloads, theme toggle, and scroll reveals.

const root = document.documentElement;
const themeToggle = document.querySelector('.theme-toggle');

function syncThemeToggle() {
  if (!themeToggle) return;
  const dark = root.dataset.theme === 'dark';
  themeToggle.setAttribute('aria-pressed', String(dark));
  themeToggle.setAttribute('aria-label', dark ? 'Switch to light theme' : 'Switch to dark theme');
  themeToggle.title = themeToggle.getAttribute('aria-label');
}

themeToggle?.addEventListener('click', () => {
  const next = root.dataset.theme === 'dark' ? 'light' : 'dark';
  root.dataset.theme = next;
  try {
    localStorage.setItem('dohc-theme', next);
  } catch {
    // Privacy modes can disable storage; the visual and accessible state must
    // still follow the theme selected for this page view.
  } finally {
    syncThemeToggle();
  }
});

syncThemeToggle();

const RELEASES_URL = 'https://github.com/dohc-ai/dohc/releases';

function matchesBuild(extension, architecture) {
  const architecturePattern = new RegExp(`(?:^|[-_])${architecture}(?:[-_.]|$)`, 'i');
  return (name) => name.toLowerCase().endsWith(extension) && architecturePattern.test(name);
}

const downloadBuilds = {
  'windows-x64': {
    platform: 'windows', label: 'Windows', detail: 'x64, .exe', icon: 'windows',
    matches: matchesBuild('.exe', 'x64'),
  },
  'mac-arm64': {
    platform: 'mac', label: 'macOS', detail: 'Apple silicon, .dmg', icon: 'apple',
    matches: matchesBuild('.dmg', 'arm64'),
  },
  'mac-x64': {
    platform: 'mac', label: 'macOS', detail: 'Intel, .dmg', icon: 'apple',
    matches: matchesBuild('.dmg', 'x64'),
  },
  'linux-x64': {
    platform: 'linux', label: 'Linux', detail: 'x64, AppImage', icon: 'linux',
    matches: matchesBuild('.appimage', 'x64'),
  },
};

Object.values(downloadBuilds).forEach((build) => { build.url = RELEASES_URL; });

function detectedDesktopPlatform() {
  const fingerprint = `${navigator.userAgentData?.platform ?? ''} ${navigator.platform ?? ''} ${navigator.userAgent ?? ''}`;
  if (/Android|iPhone|iPad|iPod|Mobile|CrOS/i.test(fingerprint)) return 'unknown';
  if (/Macintosh|MacIntel|Mac OS/i.test(fingerprint) && navigator.maxTouchPoints > 1) return 'unknown';
  if (/Windows|Win32|Win64/i.test(fingerprint)) return 'windows';
  if (/Macintosh|MacIntel|Mac OS/i.test(fingerprint)) return 'mac';
  if (/Linux|X11/i.test(fingerprint)) return 'linux';
  return 'unknown';
}

async function preferredDownloadKey() {
  const platform = detectedDesktopPlatform();
  if (platform === 'windows') return 'windows-x64';
  if (platform === 'linux') return 'linux-x64';
  if (platform !== 'mac') return null;

  const reportedArchitecture = `${navigator.userAgent ?? ''}`;
  if (/arm64|aarch64/i.test(reportedArchitecture)) return 'mac-arm64';
  try {
    const values = await navigator.userAgentData?.getHighEntropyValues?.(['architecture']);
    if (/arm/i.test(values?.architecture ?? '')) return 'mac-arm64';
    if (/x86/i.test(values?.architecture ?? '')) return 'mac-x64';
  } catch {
    // Safari and privacy-hardened browsers do not expose architecture.
  }
  return null;
}

const downloadControls = Array.from(document.querySelectorAll('[data-download-control]'));
const standaloneDownloadLinks = Array.from(document.querySelectorAll('[data-download-card]'));

function updateStandaloneDownloadLinks() {
  standaloneDownloadLinks.forEach((link) => {
    const build = downloadBuilds[link.dataset.downloadCard];
    if (build) link.href = build.url;
  });
}

updateStandaloneDownloadLinks();

function configureDownloadControl(control, preferredKey) {
  const primary = control.querySelector('[data-download-primary]');
  const primaryLabel = control.querySelector('[data-download-primary-label]');
  const primaryIcon = control.querySelector('[data-download-primary-icon]');
  if (!primary || !primaryLabel || !primaryIcon) return;

  const updatePrimary = () => {
    const build = preferredKey ? downloadBuilds[preferredKey] : null;
    primary.dataset.downloadBuild = preferredKey ?? '';
    primary.href = build?.url ?? RELEASES_URL;
    primaryLabel.textContent = build ? `Download for ${build.label}` : 'Download dohc';
    primaryIcon.setAttribute('href', `#os-${build?.icon ?? 'download'}`);
    primary.closest('[data-download-control]').dataset.detectedPlatform = build?.platform ?? 'unknown';
    primary.setAttribute('aria-label', build ? `Download for ${build.label}, ${build.detail}` : 'Download dohc');
  };

  control.updateResolvedDownloads = updatePrimary;
  updatePrimary();
}

preferredDownloadKey().then((key) => {
  downloadControls.forEach((control) => configureDownloadControl(control, key));
  const platform = key ? downloadBuilds[key].platform : null;
  standaloneDownloadLinks.forEach((link) => {
    const cardPlatform = link.dataset.downloadCard === 'mac' ? 'mac' : downloadBuilds[link.dataset.downloadCard]?.platform;
    const matches = platform !== null && cardPlatform === platform;
    link.classList.toggle('is-preferred', matches);
    if (matches) {
      link.dataset.downloadCard = key;
      const badge = document.createElement('span');
      badge.className = 'download-card-match';
      badge.textContent = 'For your device';
      link.appendChild(badge);
    }
  });
  updateStandaloneDownloadLinks();
});

let resolvingDownloads;
let downloadPending = false;
const resolveDownloads = () => resolvingDownloads ??= releaseAssets().then((assets) => {
  Object.values(downloadBuilds).forEach((build) => {
    const asset = assets.find((candidate) => build.matches(candidate.name));
    if (asset?.browser_download_url) build.url = asset.browser_download_url;
  });
  updateStandaloneDownloadLinks();
  downloadControls.forEach(control => control.updateResolvedDownloads?.());
});
for (const link of document.querySelectorAll('[data-download-primary], [data-download-card]')) {
  const canResolve = () => Boolean(downloadBuilds[link.dataset.downloadCard ?? link.dataset.downloadBuild]);
  const prepare = () => { if (canResolve()) void resolveDownloads(); };
  link.addEventListener('pointerenter', prepare, { once: true });
  link.addEventListener('focus', prepare, { once: true });
  link.addEventListener('click', async event => {
    if (event.button !== 0 || event.metaKey || event.ctrlKey || event.shiftKey || event.altKey || link.target === '_blank') return;
    event.preventDefault();
    if (downloadPending) return;
    if (!canResolve()) { location.assign(RELEASES_URL); return; }
    downloadPending = true;
    const label = link.querySelector('[data-download-primary-label], .download-card-action');
    const originalText = label?.firstChild?.textContent;
    const status = document.createElement('span');
    status.className = 'visually-hidden';
    status.setAttribute('role', 'status');
    link.after(status);
    link.setAttribute('aria-busy', 'true');
    link.setAttribute('aria-disabled', 'true');
    if (label?.firstChild) label.firstChild.textContent = 'Checking release…';
    status.textContent = 'Checking the latest release…';
    try {
      await resolveDownloads();
    } catch {
      link.href = RELEASES_URL;
    } finally {
      link.removeAttribute('aria-busy');
      link.removeAttribute('aria-disabled');
      if (label?.firstChild) label.firstChild.textContent = originalText;
      status.remove();
      downloadPending = false;
    }
    location.assign(link.href);
  });
}

const reduced = matchMedia('(prefers-reduced-motion: reduce)').matches;
const targets = document.querySelectorAll('.reveal');

if (targets.length) {
  // Reveal effects are progressive enhancement. Content stays visible when
  // this script is blocked or fails to load.
  try {
    root.classList.add('reveal-enabled');
    if (reduced || !('IntersectionObserver' in window)) {
      targets.forEach((el) => el.classList.add('in'));
    } else {
      const io = new IntersectionObserver(
        (entries) => {
          for (const entry of entries) {
            if (entry.isIntersecting) {
              entry.target.classList.add('in');
              io.unobserve(entry.target);
            }
          }
        },
        { threshold: 0.12, rootMargin: '0px 0px -8% 0px' },
      );
      targets.forEach((el) => io.observe(el));
    }
  } catch {
    root.classList.remove('reveal-enabled');
  }
}

const principlesGraph = document.querySelector('[data-principles-graph]');

if (principlesGraph) {
  const principleNodes = Array.from(principlesGraph.querySelectorAll('[data-principle]'));
  const principleEdges = Array.from(principlesGraph.querySelectorAll('[data-connects]'));
  const principleTitle = principlesGraph.querySelector('[data-principle-title]');
  const principleCopy = principlesGraph.querySelector('[data-principle-copy]');
  const principleAgent = principlesGraph.querySelector('[data-principle-agent]');
  const principleCanvas = principlesGraph.querySelector('.principles-graph-canvas');
  const principleSvg = principlesGraph.querySelector('.principles-edges');
  const principleCore = principlesGraph.querySelector('.principle-core');
  const reducedGraphMotion = window.matchMedia('(prefers-reduced-motion: reduce)');
  let restartPhysics = () => {};
  let activePrincipleIndex = 0;
  let selectionTimer = null;
  let selectionVisible = false;
  let selectionPaused = false;

  const stopSelectionRotation = () => {
    if (selectionTimer !== null) window.clearInterval(selectionTimer);
    selectionTimer = null;
  };

  const startSelectionRotation = () => {
    stopSelectionRotation();
    if (
      reducedGraphMotion.matches ||
      selectionPaused ||
      !selectionVisible ||
      document.hidden ||
      principleNodes.length < 2
    ) return;
    selectionTimer = window.setInterval(() => {
      activePrincipleIndex = (activePrincipleIndex + 1) % principleNodes.length;
      selectPrinciple(principleNodes[activePrincipleIndex]);
    }, 6000);
  };

  const selectPrinciple = (node) => {
    const id = node.dataset.principle;
    activePrincipleIndex = principleNodes.indexOf(node);
    principleNodes.forEach((candidate) => {
      candidate.setAttribute('aria-pressed', String(candidate === node));
    });
    principleEdges.forEach((edge) => {
      const connected = edge.dataset.connects.split(' ').includes(id);
      edge.classList.toggle('is-active', connected);
      edge.classList.toggle('is-muted', !connected);
    });
    if (principleTitle) principleTitle.textContent = node.dataset.title;
    if (principleCopy) principleCopy.textContent = node.dataset.copy;
    if (principleAgent) principleAgent.textContent = node.dataset.agent;
    restartPhysics(0.16);
  };

  principleNodes.forEach((node) => {
    node.addEventListener('focus', () => selectPrinciple(node));
    node.addEventListener('pointerenter', () => selectPrinciple(node));
  });

  principlesGraph.addEventListener('pointerenter', () => {
    selectionPaused = true;
    stopSelectionRotation();
  });
  principlesGraph.addEventListener('pointerleave', () => {
    selectionPaused = false;
    startSelectionRotation();
  });
  principlesGraph.addEventListener('focusin', () => {
    selectionPaused = true;
    stopSelectionRotation();
  });
  principlesGraph.addEventListener('focusout', (event) => {
    if (principlesGraph.contains(event.relatedTarget)) return;
    selectionPaused = false;
    startSelectionRotation();
  });
  document.addEventListener('visibilitychange', startSelectionRotation);

  if (principleCanvas && principleSvg && principleCore) {
    const graphFlow = createGraphFlow(principlesGraph);
    const percent = (element, property) =>
      Number.parseFloat(element.style.getPropertyValue(property)) / 100;
    const scatter = [
      { x: 34, y: -26 },
      { x: -31, y: 24 },
      { x: 28, y: 27 },
      { x: -35, y: -20 },
    ];
    const points = principleNodes.map((element, index) => ({
      id: element.dataset.principle,
      element,
      anchorX: percent(element, '--node-x'),
      anchorY: percent(element, '--node-y'),
      x: 0,
      y: 0,
      vx: 0,
      vy: 0,
      radius: 38,
      dragging: false,
      scatter: scatter[index % scatter.length],
      phase: index * 1.37 + 0.4,
      driftX: 24 + index * 3,
      driftY: 18 + (index % 2) * 6,
      driftSpeed: 0.00036 + index * 0.000028,
    }));
    const pointById = new Map(points.map((point) => [point.id, point]));
    const edgeModels = principleEdges.map((element) => {
      const [source, target] = element.dataset.connects.split(' ');
      return { element, source, target, restLength: 0 };
    });
    const core = {
      id: 'core',
      element: principleCore,
      anchorX: percent(principleCore, '--node-x'),
      anchorY: percent(principleCore, '--node-y'),
      x: 0,
      y: 0,
      vx: 0,
      vy: 0,
      radius: 34,
      dragging: false,
      phase: 5.1,
      driftX: 34,
      driftY: 26,
      driftSpeed: 0.00032,
    };
    const floatingPoints = [...points, core];
    let width = 0;
    let height = 0;
    let frame = null;
    let alpha = 0;
    let laidOut = false;
    let hasEntered = false;
    let graphIsVisible = false;
    let drag = null;
    let suppressClickUntil = 0;

    const endpoint = (id) => (id === 'core' ? core : pointById.get(id));
    const clampPoint = (point) => {
      const horizontalPadding = width <= 720 ? 72 : 104;
      const verticalPadding = width <= 720 ? 58 : 68;
      point.x = Math.min(width - horizontalPadding, Math.max(horizontalPadding, point.x));
      point.y = Math.min(height - verticalPadding, Math.max(verticalPadding, point.y));
    };

    const renderGraph = () => {
      principleSvg.setAttribute('viewBox', `0 0 ${width} ${height}`);
      core.element.style.setProperty('--node-px', `${core.x}px`);
      core.element.style.setProperty('--node-py', `${core.y}px`);
      points.forEach((point) => {
        point.element.style.setProperty('--node-px', `${point.x}px`);
        point.element.style.setProperty('--node-py', `${point.y}px`);
      });
      edgeModels.forEach((edge) => {
        const source = endpoint(edge.source);
        const target = endpoint(edge.target);
        if (!source || !target) return;
        edge.element.setAttribute('x1', source.x);
        edge.element.setAttribute('y1', source.y);
        edge.element.setAttribute('x2', target.x);
        edge.element.setAttribute('y2', target.y);
      });
      graphFlow.render();
    };

    const settleAtAnchors = () => {
      floatingPoints.forEach((point) => {
        point.x = point.anchorX * width;
        point.y = point.anchorY * height;
        point.vx = 0;
        point.vy = 0;
        clampPoint(point);
      });
      renderGraph();
    };

    let lastStep = 0;
    const step = (time) => {
      if (document.hidden || !graphIsVisible) { frame = null; return; }
      if (time - lastStep < 1000 / 60 - 1) { frame = requestAnimationFrame(step); return; }
      lastStep = time;
      const activeAlpha = points.some((point) => point.dragging)
        ? Math.max(alpha, 0.22)
        : Math.max(alpha, 0.06);
      const viewportDriftScale = width <= 720 ? 0.68 : 1;
      const interactionDriftScale = selectionPaused ? 0.25 : 1;
      const driftScale = viewportDriftScale * interactionDriftScale;

      floatingPoints.forEach((point) => {
        if (point.dragging) return;
        const anchorX =
          point.anchorX * width +
          Math.sin(time * point.driftSpeed + point.phase) * point.driftX * driftScale;
        const anchorY =
          point.anchorY * height +
          Math.cos(time * point.driftSpeed * 0.83 + point.phase * 1.7) *
            point.driftY *
            driftScale;
        point.vx += (anchorX - point.x) * 0.0042;
        point.vy += (anchorY - point.y) * 0.0042;
      });

      edgeModels.forEach((edge) => {
        const source = endpoint(edge.source);
        const target = endpoint(edge.target);
        if (!source || !target) return;
        const dx = target.x - source.x;
        const dy = target.y - source.y;
        const distance = Math.max(1, Math.hypot(dx, dy));
        const force = (distance - edge.restLength) * 0.018 * activeAlpha;
        const fx = (dx / distance) * force;
        const fy = (dy / distance) * force;
        if (!source.dragging) {
          source.vx += fx;
          source.vy += fy;
        }
        if (!target.dragging) {
          target.vx -= fx;
          target.vy -= fy;
        }
      });

      for (let index = 0; index < floatingPoints.length; index += 1) {
        const a = floatingPoints[index];
        for (let otherIndex = index + 1; otherIndex < floatingPoints.length; otherIndex += 1) {
          const b = floatingPoints[otherIndex];
          let dx = b.x - a.x;
          let dy = b.y - a.y;
          let distance = Math.hypot(dx, dy);
          if (distance < 0.1) {
            dx = otherIndex + 0.25;
            dy = index + 0.5;
            distance = Math.hypot(dx, dy);
          }
          const nx = dx / distance;
          const ny = dy / distance;
          const charge = (2600 * activeAlpha) / Math.max(90, distance * distance);
          if (!a.dragging) {
            a.vx -= nx * charge;
            a.vy -= ny * charge;
          }
          if (!b.dragging) {
            b.vx += nx * charge;
            b.vy += ny * charge;
          }
          const minimumDistance = a.radius + b.radius + 28;
          if (distance < minimumDistance) {
            const push = ((minimumDistance - distance) / distance) * 0.38 * activeAlpha;
            if (!a.dragging) {
              a.vx -= dx * push;
              a.vy -= dy * push;
            }
            if (!b.dragging) {
              b.vx += dx * push;
              b.vy += dy * push;
            }
          }
        }
      }

      floatingPoints.forEach((point) => {
        if (point.dragging) {
          point.vx = 0;
          point.vy = 0;
          return;
        }
        point.vx *= 0.88;
        point.vy *= 0.88;
        point.x += point.vx;
        point.y += point.vy;
        clampPoint(point);
      });

      renderGraph();
      alpha = points.some((point) => point.dragging) ? 0.28 : Math.max(0.06, alpha * 0.982);
      if (graphIsVisible && !reducedGraphMotion.matches) {
        frame = requestAnimationFrame(step);
      } else {
        frame = null;
      }
    };

    restartPhysics = (boost = 0.7) => {
      if (reducedGraphMotion.matches || !hasEntered || !graphIsVisible) return;
      alpha = Math.max(alpha, boost);
      if (frame === null) frame = requestAnimationFrame(step);
    };

    const layoutGraph = () => {
      const bounds = principleCanvas.getBoundingClientRect();
      const previousWidth = width;
      const previousHeight = height;
      width = Math.max(1, bounds.width);
      height = Math.max(1, bounds.height);
      floatingPoints.forEach((point) => {
        point.radius = width <= 720 ? 32 : 38;
        if (laidOut && previousWidth > 0 && previousHeight > 0) {
          point.x = (point.x / previousWidth) * width;
          point.y = (point.y / previousHeight) * height;
        } else {
          point.x = point.anchorX * width;
          point.y = point.anchorY * height;
        }
        clampPoint(point);
      });
      edgeModels.forEach((edge) => {
        const source = endpoint(edge.source);
        const target = endpoint(edge.target);
        edge.restLength = Math.hypot(target.x - source.x, target.y - source.y);
      });
      laidOut = true;
      principleCanvas.classList.add('is-physics-ready');
      renderGraph();
      restartPhysics(0.28);
    };

    const launchGraph = () => {
      if (hasEntered) return;
      hasEntered = true;
      if (reducedGraphMotion.matches) {
        settleAtAnchors();
        return;
      }
      const scatterScale = width <= 720 ? 0.62 : 1;
      points.forEach((point) => {
        point.x += point.scatter.x * scatterScale;
        point.y += point.scatter.y * scatterScale;
        clampPoint(point);
      });
      core.x += 18 * scatterScale;
      core.y -= 14 * scatterScale;
      clampPoint(core);
      renderGraph();
      restartPhysics(0.9);
    };

    points.forEach((point) => {
      point.element.addEventListener('click', (event) => {
        if (performance.now() < suppressClickUntil) {
          event.preventDefault();
          return;
        }
        selectPrinciple(point.element);
      });
      point.element.addEventListener('pointerdown', (event) => {
        if (event.button !== 0) return;
        const bounds = principleCanvas.getBoundingClientRect();
        drag = {
          point,
          startX: event.clientX,
          startY: event.clientY,
          moved: false,
          bounds,
        };
        point.dragging = true;
        point.element.setPointerCapture(event.pointerId);
        point.element.classList.add('is-dragging');
        restartPhysics(0.55);
      });
      point.element.addEventListener('pointermove', (event) => {
        if (!drag || drag.point !== point) return;
        drag.moved ||=
          Math.abs(event.clientX - drag.startX) > 3 ||
          Math.abs(event.clientY - drag.startY) > 3;
        point.x = event.clientX - drag.bounds.left;
        point.y = event.clientY - drag.bounds.top;
        point.vx = 0;
        point.vy = 0;
        clampPoint(point);
        renderGraph();
        restartPhysics(0.55);
      });
      const release = (event) => {
        if (!drag || drag.point !== point) return;
        if (drag.moved) suppressClickUntil = performance.now() + 120;
        point.dragging = false;
        point.element.classList.remove('is-dragging');
        if (point.element.hasPointerCapture(event.pointerId)) {
          point.element.releasePointerCapture(event.pointerId);
        }
        drag = null;
        restartPhysics(0.36);
      };
      point.element.addEventListener('pointerup', release);
      point.element.addEventListener('pointercancel', release);
    });

    layoutGraph();
    const graphResizeObserver = new ResizeObserver(layoutGraph);
    graphResizeObserver.observe(principleCanvas);
    document.addEventListener('visibilitychange', () => {
      if (document.hidden) {
        if (frame !== null) cancelAnimationFrame(frame);
        frame = null;
      } else restartPhysics(0.16);
    });

    if ('IntersectionObserver' in window) {
      const graphObserver = new IntersectionObserver(([entry]) => {
        graphIsVisible = entry.isIntersecting;
        graphFlow.setVisible(graphIsVisible);
        selectionVisible = entry.isIntersecting;
        if (graphIsVisible) {
          launchGraph();
          restartPhysics(0.36);
        } else if (frame !== null) {
          cancelAnimationFrame(frame);
          frame = null;
        }
        startSelectionRotation();
      }, { threshold: 0.22 });
      graphObserver.observe(principleCanvas);
    } else {
      graphIsVisible = true;
      graphFlow.setVisible(true);
      selectionVisible = true;
      launchGraph();
      startSelectionRotation();
    }

    reducedGraphMotion.addEventListener('change', () => {
      if (reducedGraphMotion.matches) {
        if (frame !== null) cancelAnimationFrame(frame);
        frame = null;
        alpha = 0;
        settleAtAnchors();
      } else if (hasEntered) {
        restartPhysics(0.7);
      }
      startSelectionRotation();
    });
  }

  const initialPrinciple = principleNodes.find((node) => node.getAttribute('aria-pressed') === 'true');
  if (initialPrinciple) selectPrinciple(initialPrinciple);
}

// Agent chat demo: friends ask, you @ your own agent, and the split app it
// built sits beside the conversation. The picker swaps which model the
// agent runs on; the split app is a small working calculator.
const agentDemo = document.querySelector('[data-agent-demo]');

if (agentDemo) {
  const AGENTS = {
    claude: {
      name: 'Claude',
      color: '#D97757',
    },
    codex: {
      name: 'Codex',
      color: 'var(--ink)',
    },
    gemini: {
      name: 'Gemini',
      color: '#4285F4',
    },
  };
  const chips = Array.from(agentDemo.querySelectorAll('[data-agent]'));
  const names = Array.from(agentDemo.querySelectorAll('[data-agent-name]'));
  const logos = Array.from(agentDemo.querySelectorAll('[data-agent-logo]'));

  const selectAgent = (chip) => {
    const agent = AGENTS[chip.dataset.agent];
    if (!agent) return;
    chips.forEach((candidate) => {
      candidate.setAttribute('aria-pressed', String(candidate === chip));
    });
    agentDemo.style.setProperty('--agent-color', agent.color);
    names.forEach((el) => { el.textContent = agent.name; });
    logos.forEach((el) => el.setAttribute('href', `#logo-${chip.dataset.agent}`));
  };

  chips.forEach((chip) => chip.addEventListener('click', () => selectAgent(chip)));

  // The Split app: everyone ticks what they had; each item's price divides
  // between whoever ticked it, and the izakaya service charge follows the
  // same shares. Ticks are demo state only.
  const split = agentDemo.querySelector('[data-split]');

  if (split) {
    const PEOPLE = { you: 'you', maya: 'Maya', sam: 'Sam' };
    // Each receipt's total (with service) is what its payer put down.
    const PAID = { you: 4500, maya: 7568, sam: 1080 };
    const RECEIPTS = [
      {
        name: 'izakaya', paidBy: 'maya', service: 0.1,
        items: [
          { name: 'sashimi platter', price: 2400, had: ['you', 'sam'] },
          { name: 'yakitori × 12', price: 1800, had: ['you', 'maya', 'sam'] },
          { name: 'beer × 4', price: 2000, had: ['you', 'maya'] },
          { name: 'karaage', price: 680, had: ['maya', 'sam'] },
        ],
      },
      {
        name: 'ramen', paidBy: 'you',
        items: [
          { name: 'tonkotsu × 3', price: 3300, had: ['you', 'maya', 'sam'] },
          { name: 'gyoza × 2', price: 1200, had: ['you', 'sam'] },
        ],
      },
      {
        name: 'konbini', paidBy: 'sam',
        items: [
          { name: 'onigiri × 4', price: 720, had: ['you', 'maya', 'sam'] },
          { name: 'ice cream', price: 360, had: ['sam'] },
        ],
      },
    ];
    const yen = (amount) => `¥${Math.round(amount).toLocaleString('en-US')}`;
    const list = split.querySelector('[data-split-receipts]');
    const personButtons = Array.from(split.querySelectorAll('[data-person]'));
    const label = split.querySelector('[data-split-label]');
    const amount = split.querySelector('[data-split-amount]');
    const meta = split.querySelector('[data-split-meta]');
    const transfersHost = split.querySelector('[data-split-transfers]');
    // Sam already paid Maya back, so the app opens with one settled row.
    const settled = new Set(['sam>maya']);
    let person = 'you';

    const receiptTotal = (receipt) =>
      receipt.items.reduce((sum, item) => sum + item.price, 0) * (1 + (receipt.service || 0));

    // Render the receipts once, then keep the DOM and only update state.
    RECEIPTS.forEach((receipt, index) => {
      const disclosure = document.createElement('details');
      disclosure.className = 'app-receipt';
      disclosure.open = index === 0;
      const group = document.createElement('summary');
      group.className = 'app-group';
      group.innerHTML = `<span>${receipt.name}</span><span>${PEOPLE[receipt.paidBy]} paid ${yen(receiptTotal(receipt))}</span>`;
      disclosure.appendChild(group);
      list.appendChild(disclosure);
      receipt.items.forEach((item) => {
        const row = document.createElement('label');
        row.className = 'app-item';
        row.innerHTML = `<input type="checkbox" /><span class="app-check" aria-hidden="true"></span><span>${item.name}</span><span class="app-price"><small></small><span></span></span>`;
        item.row = row;
        item.box = row.querySelector('input');
        item.box.addEventListener('change', () => {
          const set = new Set(item.had);
          if (item.box.checked) set.add(person); else set.delete(person);
          item.had = Array.from(set);
          settled.clear();
          render();
        });
        disclosure.appendChild(row);
      });
    });

    const shareOf = (who) => {
      let total = 0;
      RECEIPTS.forEach((receipt) => {
        receipt.items.forEach((item) => {
          if (!item.had.includes(who)) return;
          total += (item.price / item.had.length) * (1 + (receipt.service || 0));
        });
      });
      return total;
    };

    // Pairwise settlement: whoever owes most pays whoever is owed most.
    const settle = () => {
      const nets = Object.keys(PEOPLE).map((who) => ({ who, net: shareOf(who) - PAID[who] }));
      const debtors = nets.filter((n) => n.net > 0.5).sort((a, b) => b.net - a.net);
      const creditors = nets.filter((n) => n.net < -0.5).map((n) => ({ who: n.who, net: -n.net })).sort((a, b) => b.net - a.net);
      const transfers = [];
      let d = 0;
      let k = 0;
      while (d < debtors.length && k < creditors.length) {
        const value = Math.min(debtors[d].net, creditors[k].net);
        transfers.push({ from: debtors[d].who, to: creditors[k].who, value, key: `${debtors[d].who}>${creditors[k].who}` });
        debtors[d].net -= value;
        creditors[k].net -= value;
        if (debtors[d].net < 0.5) d += 1;
        if (creditors[k].net < 0.5) k += 1;
      }
      return transfers;
    };

    transfersHost.addEventListener('click', (event) => {
      const button = event.target.closest('[data-settle]');
      if (!button) return;
      const key = button.dataset.settle;
      if (settled.has(key)) settled.delete(key); else settled.add(key);
      render();
      transfersHost.querySelector(`[data-settle="${key}"]`)?.focus({ preventScroll: true });
    });

    const render = () => {
      personButtons.forEach((button) => {
        button.setAttribute('aria-selected', String(button.dataset.person === person));
      });
      RECEIPTS.forEach((receipt) => {
        receipt.items.forEach((item) => {
          const mine = item.had.includes(person);
          item.box.checked = mine;
          item.box.disabled = mine && item.had.length === 1;
          item.box.setAttribute('aria-label', `${item.name}${item.box.disabled ? '. Assign another person before removing this share.' : ''}`);
          item.row.title = item.box.disabled ? 'Assign another person before removing this share.' : '';
          item.row.classList.toggle('is-mine', mine);
          const shared = mine && item.had.length > 1;
          item.row.querySelector('small').textContent = shared ? `÷${item.had.length}` : '';
          item.row.querySelector('.app-price > span').textContent =
            shared ? yen(item.price / item.had.length) : yen(item.price);
        });
      });

      const name = PEOPLE[person];
      const me = person === 'you';
      const transfers = settle();
      const open = transfers.filter((t) => !settled.has(t.key));
      const outgoing = open.filter((t) => t.from === person);
      const incoming = open.filter((t) => t.to === person);
      const names = (list) => list.map((t) => `<b>${PEOPLE[t.from === person ? t.to : t.from]}</b>`).join(' and ');
      const sum = (list) => list.reduce((acc, t) => acc + t.value, 0);

      const hero = split.querySelector('.app-hero');
      hero.classList.toggle('is-clear', !outgoing.length && !incoming.length);
      if (outgoing.length) {
        label.innerHTML = `${me ? 'you owe' : `${name} owes`} ${names(outgoing)}`;
        amount.textContent = yen(sum(outgoing));
      } else if (incoming.length) {
        label.innerHTML = `${names(incoming)} ${incoming.length > 1 || incoming[0].from === 'you' ? 'owe' : 'owes'} ${me ? 'you' : name}`;
        amount.textContent = yen(sum(incoming));
      } else {
        label.textContent = me ? "you're all settled" : `${name} is all settled`;
        amount.textContent = yen(0);
      }
      meta.textContent = `had ${yen(shareOf(person))} · paid ${yen(PAID[person])}`;

      transfersHost.innerHTML = transfers
        .map((t) => {
          const done = settled.has(t.key);
          const verb = t.from === 'you' ? 'pay' : 'pays';
          const action = done
            ? `<span class="app-settled">settled &#10003;</span><button class="app-settle is-undo" type="button" data-settle="${t.key}" aria-label="Undo settlement from ${PEOPLE[t.from]} to ${PEOPLE[t.to]}">Undo</button>`
            : `<button class="app-settle" type="button" data-settle="${t.key}" aria-label="Settle payment from ${PEOPLE[t.from]} to ${PEOPLE[t.to]}">Settle</button>`;
          return `<div class="app-transfer${done ? ' is-settled' : ''}"><span><b>${PEOPLE[t.from]}</b> ${verb} <b>${PEOPLE[t.to]}</b></span><span class="amt">${yen(t.value)}</span>${action}</div>`;
        })
        .join('');
    };

    personButtons.forEach((button) => {
      button.addEventListener('click', () => {
        person = button.dataset.person;
        render();
      });
    });
    render();
  }

}

const syncDemo = document.querySelector('[data-sync-demo]');
if (syncDemo) createSyncDemo(syncDemo);

// Two readers: the agent's side is a file tree, yours is the window that
// renders whatever file is picked. Same folder, no second copy.
const readers = document.querySelector('[data-readers]');

if (readers) {
  const AGENT_WHO = '<span class="reader-who is-agent" aria-hidden="true">A</span>';
  const WHO = (letter) => `<span class="reader-who" aria-hidden="true">${letter}</span>`;
  const FILES = {
    plan: {
      name: 'Plan',
      view: '<h3>Launch plan</h3><p>Beta on the 24th. Three things gate it: the pricing page, the payment sandbox, and the invite flow. Maya owns pricing, Sam owns the sandbox.</p>',
      foot: 'Markdown on disk. A live document while it\'s open, so edits from both of you merge.',
    },
    tasks: {
      name: 'Tasks',
      view: '<div class="reader-board"><div class="reader-col"><h4>todo <span>2</span></h4><div class="reader-task">Invite flow</div><div class="reader-task">Launch email</div></div><div class="reader-col"><h4>doing <span>3</span></h4><div class="reader-task">Pricing page</div><div class="reader-task">Payment sandbox</div><div class="reader-task">Copy review</div></div><div class="reader-col"><h4>done <span>1</span></h4><div class="reader-task">Beta day</div></div></div>',
      foot: 'A folder with a schema. One markdown file per task; the board, table, and calendar are views of the same files.',
    },
    drawing: {
      name: 'Flow sketch',
      view: '<div class="reader-drawing"><svg viewBox="0 0 400 170" aria-hidden="true"><rect x="20" y="60" width="110" height="44" rx="6"/><text x="75" y="86" text-anchor="middle">Sign up</text><rect x="250" y="20" width="130" height="44" rx="6"/><text x="315" y="46" text-anchor="middle">Has account</text><rect x="250" y="106" width="130" height="44" rx="6"/><text x="315" y="132" text-anchor="middle">New user</text><path d="M130 82 C 190 82, 190 42, 250 42"/><path d="M130 82 C 190 82, 190 128, 250 128"/></svg></div>',
      foot: 'JSON with an id on every shape, so your agent can add a branch or move one without redrawing.',
    },
    chat: {
      name: '#launch',
      view: `<div class="reader-msg">${WHO('S')}<span><b>Sam</b> sandbox is on track for the 19th, so the 24th is fine by me.</span></div><div class="reader-msg">${WHO('M')}<span><b>Maya</b> <span class="chat-mention">@My Agent</span> can you add the three gates as tasks?</span></div><div class="reader-msg">${AGENT_WHO}<span><b>My Agent</b> done. three tasks in tasks/, due the 21st.</span></div>`,
      foot: 'Chat is a file in the workspace too. An @ lands in your agent\'s inbox; its reply lands in the room.',
    },
    app: {
      name: 'Split',
      view: '<div class="reader-app"><div class="reader-app-row"><span>Maya</span><span>owes ¥2,140</span></div><div class="reader-app-row"><span>Sam</span><span class="is-clear">settled</span></div><div class="reader-app-row"><span>you</span><span class="is-clear">paid</span></div></div>',
      foot: 'Source in the folder. The app reads only the data it lists, and your agent can change the source like any other file.',
    },
    history: {
      name: 'History',
      view: `<ul class="reader-history"><li>${WHO('M')}<span><b>Maya</b> moved Pricing page to doing</span><small>12:30</small></li><li>${AGENT_WHO}<span><b>My Agent</b> added 3 tasks</span><small>9:06</small></li><li>${WHO('Y')}<span><b>you</b> edited Plan</span><small>9:04</small></li></ul>`,
      foot: '',
    },
  };

  const picks = Array.from(readers.querySelectorAll('[data-reader-pick]'));
  const name = readers.querySelector('[data-reader-name]');
  const view = readers.querySelector('[data-reader-view]');
  const foot = readers.querySelector('[data-reader-foot]');
  const reduced = matchMedia('(prefers-reduced-motion: reduce)');
  let current = 'plan';
  let swapTimer = 0;

  const render = (key) => {
    const file = FILES[key];
    name.textContent = file.name;
    view.innerHTML = file.view;
    foot.textContent = file.foot;
    foot.hidden = !file.foot;
  };

  const show = (key, pick) => {
    picks.forEach((candidate) => {
      candidate.setAttribute('aria-pressed', String(candidate === pick));
    });
    if (key === current) return;
    current = key;
    clearTimeout(swapTimer);
    if (reduced.matches) { render(key); return; }
    view.classList.add('is-swapping');
    swapTimer = setTimeout(() => { render(key); view.classList.remove('is-swapping'); }, 160);
  };

  const flip = createReaderFlip(readers.closest('[data-reader-showcase]'));
  picks.forEach((pick) => {
    pick.addEventListener('click', () => {
      show(pick.dataset.readerPick, pick);
      flip.show('human', true);
    });
  });
  render(current);
  show(current, picks[0]);
}

const year = document.getElementById('year');
if (year) year.textContent = new Date().getFullYear();
