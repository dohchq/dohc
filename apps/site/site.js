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

const year = document.getElementById('year');
if (year) year.textContent = new Date().getFullYear();
