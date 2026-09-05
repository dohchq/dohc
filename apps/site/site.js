// dohc marketing site: downloads, theme toggle, and scroll reveals.

const root = document.documentElement;
const themeToggle = document.querySelector('.theme-toggle');

function syncThemeToggle() {
  if (!themeToggle) return;
  const dark = root.dataset.theme === 'dark';
  themeToggle.setAttribute('aria-pressed', String(dark));
  themeToggle.setAttribute('aria-label', dark ? 'Switch to light theme' : 'Switch to dark theme');
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
  // Apple silicon is the current default; Intel remains one click away.
  return 'mac-arm64';
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
    primary.href = build?.url ?? RELEASES_URL;
    primaryLabel.textContent = build ? `Download for ${build.label}` : 'Download dohc';
    primaryIcon.setAttribute('href', `#os-${build?.icon ?? 'download'}`);
    primary.closest('[data-download-control]').dataset.detectedPlatform = build?.platform ?? 'unknown';
    primary.setAttribute('aria-label', build ? `Download dohc for ${build.label}, ${build.detail}` : 'View dohc downloads');
  };

  control.updateResolvedDownloads = updatePrimary;
  updatePrimary();
}

preferredDownloadKey().then((key) => {
  downloadControls.forEach((control) => configureDownloadControl(control, key));
});

if (downloadControls.length) {
  fetch('https://api.github.com/repos/dohc-ai/dohc/releases?per_page=10', {
    headers: { Accept: 'application/vnd.github+json' },
  })
    .then((response) => response.ok ? response.json() : Promise.reject(new Error('No published release')))
    .then((releases) => {
      const available = releases.filter((release) => !release.draft && release.assets?.length);
      const release = available.find((candidate) => !candidate.prerelease) ?? available[0];
      if (!release) return;
      Object.values(downloadBuilds).forEach((build) => {
        const asset = release.assets.find((candidate) => build.matches(candidate.name));
        if (asset?.browser_download_url) build.url = asset.browser_download_url;
      });
      downloadControls.forEach((control) => control.updateResolvedDownloads?.());
      updateStandaloneDownloadLinks();
    })
    .catch(() => {
      // The releases page remains a useful fallback before the first public build.
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

    const step = (time) => {
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

    if ('IntersectionObserver' in window) {
      const graphObserver = new IntersectionObserver(([entry]) => {
        graphIsVisible = entry.isIntersecting;
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
    RECEIPTS.forEach((receipt) => {
      const group = document.createElement('div');
      group.className = 'app-group';
      group.innerHTML = `<span>${receipt.name}</span><span>${PEOPLE[receipt.paidBy]} paid ${yen(receiptTotal(receipt))}</span>`;
      list.appendChild(group);
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
        list.appendChild(row);
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
      settled.add(button.dataset.settle);
      render();
    });

    const render = () => {
      personButtons.forEach((button) => {
        button.setAttribute('aria-selected', String(button.dataset.person === person));
      });
      RECEIPTS.forEach((receipt) => {
        receipt.items.forEach((item) => {
          const mine = item.had.includes(person);
          item.box.checked = mine;
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
            ? '<span class="app-settled">settled &#10003;</span>'
            : `<button class="app-settle" type="button" data-settle="${t.key}">Settle</button>`;
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

// Local-first sync demo: a laptop and a phone hold the same file. It plays
// itself (type, go offline, type on both, reconnect, merge, loop) and hands
// control to the visitor on their first click, keypress, or switch flip.
const syncDemo = document.querySelector('[data-sync-demo]');

if (syncDemo) {
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

  // Three-way merge on sentences: keep what both changed, append what one added.
  const merge = (basis, left, right) => {
    if (left === right) return left;
    if (left === basis) return right;
    if (right === basis) return left;
    const split = (s) => s.split(/(?<=[.!?])\s+/).filter(Boolean);
    const ls = split(left), rs = split(right), bs = split(basis);
    const out = [];
    const seen = new Set();
    ls.concat(rs).forEach((s) => {
      if (seen.has(s)) return;
      const inBase = bs.includes(s);
      if (inBase && !(ls.includes(s) && rs.includes(s))) return;
      seen.add(s);
      out.push(s);
    });
    return out.join(' ');
  };

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
    toggle.checked = on;
    link.classList.toggle('is-off', !on);
    if (signal) signal.classList.toggle('is-off', !on);
    if (on) {
      const merged = merge(base, a.value, b.value);
      const changed = merged !== a.value || merged !== b.value;
      base = merged;
      receive(a, merged);
      receive(b, merged);
      swapText(linkLabel, 'connected');
      setStatus('a', 'in sync', changed ? 'both edits kept' : savedOn('a'));
      setStatus('b', 'in sync', changed ? 'both edits kept' : savedOn('b'));
      swapText(hint, changed ? 'back online. nothing was lost.' : (manual ? 'try typing on either device' : 'watching. click or type to take over.'));
    } else {
      swapText(linkLabel, 'no connection');
      setStatus('a', 'offline', 'saved here · will sync later');
      setStatus('b', 'offline', 'saved here · will sync later');
      swapText(hint, manual ? 'now type on both, then turn it back on' : 'no signal. both devices keep working.');
    }
  };

  // ---------- autoplay ----------
  let typing = false;
  let typeFrame = null;
  const wait = (ms) => new Promise((resolve) => { timers.push(setTimeout(resolve, ms)); });
  const clearTimers = () => {
    timers.forEach(clearTimeout);
    timers = [];
    cancelTick(typeFrame);
    typeFrame = null;
  };

  const type = (el, text) => new Promise((resolve) => {
    const startValue = el.value;
    const t0 = performance.now();
    let shown = 0;
    typing = true;
    const frame = (now) => {
      if (manual) { typing = false; typeFrame = null; resolve(); return; }
      const want = Math.min(text.length, Math.floor((now - t0) / 42));
      if (want > shown) {
        shown = want;
        el.value = startValue + text.slice(0, shown);
        onInput(el);
      }
      if (shown < text.length) typeFrame = tick(frame);
      else { typing = false; typeFrame = null; resolve(); }
    };
    typeFrame = tick(frame);
  });

  const resetEditors = async () => {
    if (a.value === START && b.value === START) return;
    a.classList.add('is-fading');
    b.classList.add('is-fading');
    await wait(380);
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

  const takeOver = () => {
    if (manual) return;
    manual = true;
    clearTimers();
    [a, b].forEach((el) => { stopReceiving(el); el.classList.remove('is-fading'); });
    if (toggle.checked) {
      const m = merge(base, a.value, b.value);
      a.value = m; b.value = m; base = m;
    }
    if (!typing) hint.textContent = toggle.checked ? 'your turn. try typing on either device' : 'now type on both, then turn it back on';
  };

  a.addEventListener('input', () => { if (!typing) { takeOver(); onInput(a); } });
  b.addEventListener('input', () => { if (!typing) { takeOver(); onInput(b); } });
  a.addEventListener('pointerdown', takeOver);
  b.addEventListener('pointerdown', takeOver);
  toggle.addEventListener('change', () => { takeOver(); setConnection(toggle.checked); });

  if (reduced) {
    manual = true;
    hint.textContent = 'try typing on either device';
  } else {
    // Start when the section is close to view so the loop isn't half over
    // by the time anyone sees it.
    let started = false;
    const start = () => { if (!started) { started = true; play(); } };
    if ('IntersectionObserver' in window) {
      const io = new IntersectionObserver((entries) => {
        if (entries.some((entry) => entry.isIntersecting)) { io.disconnect(); start(); }
      }, { rootMargin: '200px 0px' });
      io.observe(syncDemo);
      // Some embedded browsers never deliver observer callbacks; poll as a floor.
      const near = () => syncDemo.getBoundingClientRect().top < innerHeight + 200;
      const poll = setInterval(() => { if (started) clearInterval(poll); else if (near()) { clearInterval(poll); start(); } }, 500);
    } else {
      start();
    }
  }
}

// Two readers: the agent's side is a file tree, yours is the window that
// renders whatever file is picked. Same folder, no second copy.
const readers = document.querySelector('[data-readers]');

if (readers) {
  const AGENT_WHO = '<span class="reader-who is-agent" aria-hidden="true">A</span>';
  const WHO = (letter) => `<span class="reader-who" aria-hidden="true">${letter}</span>`;
  const FILES = {
    plan: {
      name: 'Plan',
      view: '<h3>Launch plan</h3><p>Beta on the 24th. Three things gate it: the pricing page, the payment sandbox, and the invite flow. Maya owns pricing, Sam owns the sandbox.</p><p class="reader-note">a live document · four people in it today</p>',
      foot: 'Markdown on disk. A live document while it\'s open, so edits from both of you merge.',
    },
    tasks: {
      name: 'Tasks',
      view: '<div class="reader-board"><div class="reader-col"><h4>todo <span>2</span></h4><div class="reader-task">Invite flow</div><div class="reader-task">Launch email</div></div><div class="reader-col"><h4>doing <span>3</span></h4><div class="reader-task">Pricing page</div><div class="reader-task">Payment sandbox</div><div class="reader-task">Copy review</div></div><div class="reader-col"><h4>done <span>1</span></h4><div class="reader-task">Beta day</div></div></div><p class="reader-note">a board · also a table, also a calendar</p>',
      foot: 'A folder with a schema. One markdown file per task; the board, table, and calendar are views of the same files.',
    },
    drawing: {
      name: 'Flow sketch',
      view: '<div class="reader-drawing"><svg viewBox="0 0 400 170" aria-hidden="true"><rect x="20" y="60" width="110" height="44" rx="6"/><text x="75" y="86" text-anchor="middle">Sign up</text><rect x="250" y="20" width="130" height="44" rx="6"/><text x="315" y="46" text-anchor="middle">Has account</text><rect x="250" y="106" width="130" height="44" rx="6"/><text x="315" y="132" text-anchor="middle">New user</text><path d="M130 82 C 190 82, 190 42, 250 42"/><path d="M130 82 C 190 82, 190 128, 250 128"/></svg></div><p class="reader-note">a drawing · Maya added the branch at 12:41</p>',
      foot: 'JSON with an id on every shape, so your agent can add a branch or move one without redrawing.',
    },
    chat: {
      name: '#launch',
      view: `<div class="reader-msg">${WHO('S')}<span><b>Sam</b> sandbox is on track for the 19th, so the 24th is fine by me.</span></div><div class="reader-msg">${WHO('M')}<span><b>Maya</b> <span class="chat-mention">@My Agent</span> can you add the three gates as tasks?</span></div><div class="reader-msg">${AGENT_WHO}<span><b>My Agent</b> done. three tasks in tasks/, due the 21st.</span></div>`,
      foot: 'Chat is a file in the workspace too. An @ lands in your agent\'s inbox; its reply lands in the room.',
    },
    app: {
      name: 'Split',
      view: '<div class="reader-app"><div class="reader-app-row"><span>Maya</span><span>owes ¥2,140</span></div><div class="reader-app-row"><span>Sam</span><span class="is-clear">settled</span></div><div class="reader-app-row"><span>you</span><span class="is-clear">paid</span></div></div><p class="reader-note">an app · shared by URL with Maya and Sam</p>',
      foot: 'Source in the folder. The app reads only the data it lists, and your agent can change the source like any other file.',
    },
    history: {
      name: 'History',
      view: `<ul class="reader-history"><li>${WHO('M')}<span><b>Maya</b> moved Pricing page to doing</span><small>12:30</small></li><li>${AGENT_WHO}<span><b>My Agent</b> added 3 tasks</span><small>9:06</small></li><li>${WHO('Y')}<span><b>you</b> edited Plan</span><small>9:04</small></li></ul><p class="reader-note">who changed what · any of it can go back</p>`,
      foot: 'The same list your agent gets from the CLI. Its changes carry its own name.',
    },
  };

  const picks = Array.from(readers.querySelectorAll('[data-reader-pick]'));
  const name = readers.querySelector('[data-reader-name]');
  const view = readers.querySelector('[data-reader-view]');
  const foot = readers.querySelector('[data-reader-foot]');
  const reduced = matchMedia('(prefers-reduced-motion: reduce)').matches;
  let current = 'plan';
  let swapTimer = 0;

  const render = (key) => {
    const file = FILES[key];
    name.textContent = file.name;
    view.innerHTML = file.view;
    foot.textContent = file.foot;
  };

  const show = (key, pick) => {
    picks.forEach((candidate) => {
      candidate.setAttribute('aria-selected', String(candidate.dataset.readerPick === key));
      candidate.tabIndex = candidate === pick ? 0 : -1;
    });
    if (key === current) return;
    current = key;
    clearTimeout(swapTimer);
    if (reduced) { render(key); return; }
    view.classList.add('is-swapping');
    swapTimer = setTimeout(() => { render(key); view.classList.remove('is-swapping'); }, 160);
  };

  // It walks the tree on its own until the visitor touches it. One pick
  // per file, in tree order, then it wraps.
  const hint = document.querySelector('[data-readers-hint]');
  const tour = picks.filter((pick, index) => picks.findIndex((p) => p.dataset.readerPick === pick.dataset.readerPick) === index);
  let step = 0;
  let tourTimer = 0;
  let manual = false;

  const takeOver = () => {
    if (manual) return;
    manual = true;
    clearTimeout(tourTimer);
    if (hint) hint.textContent = 'Pick any file in the tree.';
  };

  const advance = () => {
    step = (step + 1) % tour.length;
    const pick = tour[step];
    show(pick.dataset.readerPick, pick);
    tourTimer = setTimeout(advance, 2600);
  };

  picks.forEach((pick, index) => {
    pick.addEventListener('click', () => { takeOver(); show(pick.dataset.readerPick, pick); });
    pick.addEventListener('pointerenter', (event) => { if (event.pointerType === 'mouse') { takeOver(); show(pick.dataset.readerPick, pick); } });
    pick.addEventListener('keydown', (event) => {
      const dir = event.key === 'ArrowDown' ? 1 : event.key === 'ArrowUp' ? -1 : 0;
      if (!dir) return;
      event.preventDefault();
      takeOver();
      const next = picks[(index + dir + picks.length) % picks.length];
      next.focus();
      show(next.dataset.readerPick, next);
    });
  });

  render(current);
  show(current, picks[0]);

  if (reduced) {
    takeOver();
  } else {
    let started = false;
    const start = () => { if (!started && !manual) { started = true; tourTimer = setTimeout(advance, 1800); } };
    if ('IntersectionObserver' in window) {
      const io = new IntersectionObserver((entries) => {
        if (entries.some((entry) => entry.isIntersecting)) { io.disconnect(); start(); }
      }, { rootMargin: '-80px 0px' });
      io.observe(readers);
      const near = () => { const r = readers.getBoundingClientRect(); return r.top < innerHeight - 80 && r.bottom > 80; };
      const poll = setInterval(() => { if (started || manual) clearInterval(poll); else if (near()) { clearInterval(poll); start(); } }, 500);
    } else {
      start();
    }
  }
}

const year = document.getElementById('year');
if (year) year.textContent = new Date().getFullYear();
