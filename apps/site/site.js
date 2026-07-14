// dohc marketing site — downloads, theme toggle, and scroll reveals.

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
  localStorage.setItem('dohc-theme', next);
  syncThemeToggle();
});

syncThemeToggle();

const RELEASES_URL = 'https://github.com/dohc-ai/dohc/releases';
const downloadBuilds = {
  'windows-x64': {
    platform: 'windows', label: 'Windows', detail: '.exe · x64', icon: 'windows',
    matches: (name) => name.toLowerCase().endsWith('.exe') && /(?:^|[-_])x64(?:[-_.]|$)/i.test(name),
  },
  'mac-arm64': {
    platform: 'mac', label: 'macOS', detail: 'Apple silicon · .dmg', icon: 'apple',
    matches: (name) => name.toLowerCase().endsWith('.dmg') && /(?:^|[-_])arm64(?:[-_.]|$)/i.test(name),
  },
  'mac-x64': {
    platform: 'mac', label: 'macOS', detail: 'Intel · .dmg', icon: 'apple',
    matches: (name) => name.toLowerCase().endsWith('.dmg') && /(?:^|[-_])x64(?:[-_.]|$)/i.test(name),
  },
  'linux-x64': {
    platform: 'linux', label: 'Linux', detail: 'AppImage · x64', icon: 'linux',
    matches: (name) => name.toLowerCase().endsWith('.appimage') && /(?:^|[-_])x64(?:[-_.]|$)/i.test(name),
  },
};

Object.values(downloadBuilds).forEach((build) => { build.url = RELEASES_URL; });

function detectedDesktopPlatform() {
  const fingerprint = `${navigator.userAgentData?.platform ?? ''} ${navigator.platform ?? ''} ${navigator.userAgent ?? ''}`;
  if (/Android|iPhone|iPad|iPod|Mobile|CrOS/i.test(fingerprint)) return 'unknown';
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

function configureDownloadControl(control, preferredKey) {
  const primary = control.querySelector('[data-download-primary]');
  const primaryLabel = control.querySelector('[data-download-primary-label]');
  const primaryIcon = control.querySelector('[data-download-primary-icon]');
  const toggle = control.querySelector('[data-platform-toggle]');
  const menu = control.querySelector('[data-platform-menu]');
  const buildLinks = Array.from(menu.querySelectorAll('[data-download-build]'));
  let selectedKey = preferredKey;

  const updatePrimary = () => {
    const build = selectedKey ? downloadBuilds[selectedKey] : null;
    primary.href = build?.url ?? RELEASES_URL;
    primaryLabel.textContent = build ? `Download for ${build.label}` : 'Download dohc';
    primaryIcon.setAttribute('href', `#os-${build?.icon ?? 'download'}`);
    primary.closest('[data-download-control]').dataset.detectedPlatform = build?.platform ?? 'unknown';
    primary.setAttribute('aria-label', build ? `Download dohc for ${build.label}, ${build.detail}` : 'View dohc downloads');
    buildLinks.forEach((link) => {
      link.href = downloadBuilds[link.dataset.downloadBuild].url;
      link.hidden = link.dataset.downloadBuild === selectedKey;
    });
  };

  const closeMenu = (restoreFocus = false) => {
    menu.hidden = true;
    toggle.setAttribute('aria-expanded', 'false');
    if (restoreFocus) toggle.focus();
  };

  const openMenu = () => {
    menu.hidden = false;
    toggle.setAttribute('aria-expanded', 'true');
  };

  toggle.addEventListener('click', () => {
    if (menu.hidden) openMenu();
    else closeMenu();
  });
  toggle.addEventListener('keydown', (event) => {
    if (event.key === 'Escape' && !menu.hidden) {
      event.preventDefault();
      closeMenu(true);
    } else if (event.key === 'ArrowDown') {
      event.preventDefault();
      openMenu();
      menu.querySelector('a:not([hidden])')?.focus();
    }
  });
  menu.addEventListener('keydown', (event) => {
    const links = Array.from(menu.querySelectorAll('a:not([hidden])'));
    const current = links.indexOf(document.activeElement);
    if (event.key === 'Escape') {
      event.preventDefault();
      closeMenu(true);
    } else if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
      event.preventDefault();
      const direction = event.key === 'ArrowDown' ? 1 : -1;
      links[(current + direction + links.length) % links.length]?.focus();
    }
  });
  menu.addEventListener('click', () => closeMenu());
  document.addEventListener('pointerdown', (event) => {
    if (!control.contains(event.target)) closeMenu();
  });

  control.updateResolvedDownloads = () => {
    buildLinks.forEach((link) => {
      const build = downloadBuilds[link.dataset.downloadBuild];
      link.href = build.url;
    });
    updatePrimary();
  };
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

document.getElementById('year').textContent = new Date().getFullYear();
