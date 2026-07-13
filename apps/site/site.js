// dohc marketing site — theme toggle + scroll reveals. No build step.

const root = document.documentElement;

document.querySelector('.theme-toggle').addEventListener('click', () => {
  const next = root.dataset.theme === 'dark' ? 'light' : 'dark';
  root.dataset.theme = next;
  localStorage.setItem('dohc-theme', next);
});

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

const demo = document.querySelector('[data-demo]');

if (demo) {
  const wysiwyg = demo.querySelector('[data-demo-wysiwyg]');
  const titleInput = demo.querySelector('[data-demo-title]');
  const sourceEditor = demo.querySelector('[data-demo-source-editor]');
  const documentEditor = demo.querySelector('[data-demo-document]');
  const dialog = demo.querySelector('[data-demo-dialog]');
  const newFileInput = demo.querySelector('[data-demo-new-file-input]');
  const newFileError = demo.querySelector('[data-demo-new-file-error]');
  const bubbleMenu = demo.querySelector('[data-demo-bubble-menu]');
  const blockGutter = demo.querySelector('[data-demo-block-gutter]');
  const slashMenu = demo.querySelector('[data-demo-slash-menu]');
  const saveState = demo.querySelector('[data-demo-save-state]');
  const initialBody = wysiwyg.innerHTML.trim();
  const files = new Map();
  const folders = new Set(['.context', 'data', 'notes', 'research', 'shared-with-me']);
  const expandedFolders = new Set(['notes']);
  const openPaths = ['notes/product-plan.md'];
  let activePath = 'notes/product-plan.md';
  let activeMode = 'document';
  let selectedFolder = 'notes';
  let editorsExpanded = true;
  let filesExpanded = true;
  let explorerVisible = true;
  let inlineCreate = null;
  let saving = false;
  let saveTimer;
  let savedFormattingRange;
  let slashState = { open: false, query: '', selected: 0, range: null };
  let slashDismissed = false;

  const slashCommands = [
    { id: 'wikilink', label: 'Link', hint: 'Link another page', glyph: '[[', aliases: ['link', 'page', 'wiki', 'wikilink'] },
    { id: 'heading-1', label: 'Heading 1', hint: 'Large section heading', glyph: 'H1', aliases: ['h1', 'heading', 'title'] },
    { id: 'heading-2', label: 'Heading 2', hint: 'Medium section heading', glyph: 'H2', aliases: ['h2', 'subheading', 'subtitle'] },
    { id: 'heading-3', label: 'Heading 3', hint: 'Small section heading', glyph: 'H3', aliases: ['h3', 'heading', 'subheading'] },
    { id: 'bulleted-list', label: 'Bulleted list', hint: 'Start a simple list', glyph: '-', aliases: ['bullet', 'bulleted', 'list', 'ul'] },
    { id: 'numbered-list', label: 'Numbered list', hint: 'Start an ordered list', glyph: '1.', aliases: ['number', 'numbered', 'ordered', 'ol'] },
    { id: 'task-list', label: 'Todo list', hint: 'Track checkable work', glyph: '[]', aliases: ['todo', 'task', 'checklist', 'checkbox'] },
    { id: 'quote', label: 'Quote', hint: 'Call out a thought', glyph: '>', aliases: ['blockquote', 'quote'] },
    { id: 'callout', label: 'Callout', hint: 'Highlighted info box', glyph: '!', aliases: ['callout', 'note', 'tip', 'info', 'warning', 'danger', 'admonition', 'aside'] },
    { id: 'toggle', label: 'Toggle', hint: 'Collapsible callout', glyph: '▸', aliases: ['toggle', 'fold', 'collapse', 'details', 'accordion'] },
    { id: 'code-block', label: 'Code block', hint: 'Write code or raw text', glyph: '</>', aliases: ['code', 'fence', 'pre'] },
    { id: 'mermaid', label: 'Mermaid diagram', hint: 'Flowchart, sequence & more', glyph: 'dgm', aliases: ['mermaid', 'diagram', 'flowchart', 'chart', 'graph'] },
    { id: 'math', label: 'Math block', hint: 'TeX equation with $$', glyph: '∑', aliases: ['math', 'equation', 'tex', 'latex', 'katex', 'formula'] },
    { id: 'divider', label: 'Divider', hint: 'Separate sections', glyph: '-', aliases: ['divider', 'line', 'rule', 'separator', 'hr'] },
    { id: 'table', label: 'Table', hint: 'Insert a simple grid', glyph: 'tbl', aliases: ['table', 'grid', 'rows', 'columns'] },
    { id: 'image', label: 'Image', hint: 'Upload a picture', glyph: 'img', aliases: ['image', 'img', 'picture', 'photo', 'upload'] },
  ];

  function escapeHtml(value) {
    return value
      .replaceAll('&', '&amp;')
      .replaceAll('<', '&lt;')
      .replaceAll('>', '&gt;')
      .replaceAll('"', '&quot;')
      .replaceAll("'", '&#039;');
  }

  function inlineToMarkdown(node) {
    if (node.nodeType === Node.TEXT_NODE) return node.nodeValue ?? '';
    if (node.nodeType !== Node.ELEMENT_NODE) return '';
    const content = Array.from(node.childNodes).map(inlineToMarkdown).join('');
    switch (node.tagName.toLowerCase()) {
      case 'strong': case 'b': return `**${content}**`;
      case 'em': case 'i': return `_${content}_`;
      case 'code': return `\`${content}\``;
      case 'mark': return `==${content}==`;
      case 'br': return '\n';
      default: return content;
    }
  }

  function htmlToMarkdown(element) {
    const blocks = [];
    Array.from(element.childNodes).forEach((node) => {
      if (node.nodeType === Node.TEXT_NODE) {
        const text = node.nodeValue?.trim();
        if (text) blocks.push(text);
        return;
      }
      if (node.nodeType !== Node.ELEMENT_NODE) return;
      const tag = node.tagName.toLowerCase();
      const content = inlineToMarkdown(node).trim();
      if (tag === 'h1') blocks.push(`# ${content}`);
      else if (tag === 'h2') blocks.push(`## ${content}`);
      else if (tag === 'h3') blocks.push(`### ${content}`);
      else if (tag === 'blockquote') blocks.push(`> ${content}`);
      else if (tag === 'ul' || tag === 'ol') {
        const items = Array.from(node.children).map((item, index) => {
          const marker = tag === 'ol' ? `${index + 1}.` : '-';
          return `${marker} ${inlineToMarkdown(item).trim()}`;
        });
        blocks.push(items.join('\n'));
      } else if (tag === 'pre') blocks.push(`\`\`\`\n${node.textContent}\n\`\`\``);
      else if (tag === 'hr') blocks.push('---');
      else if (tag === 'table') {
        const rows = Array.from(node.querySelectorAll('tr')).map((row) =>
          Array.from(row.children).map((cell) => inlineToMarkdown(cell).trim()));
        if (rows.length) {
          const header = `| ${rows[0].join(' | ')} |`;
          const divider = `| ${rows[0].map(() => '---').join(' | ')} |`;
          const body = rows.slice(1).map((row) => `| ${row.join(' | ')} |`);
          blocks.push([header, divider, ...body].join('\n'));
        }
      }
      else if (content) blocks.push(content);
    });
    return blocks.join('\n\n').trim();
  }

  function inlineMarkdown(value) {
    return escapeHtml(value)
      .replace(/`([^`]+)`/g, '<code>$1</code>')
      .replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>')
      .replace(/_([^_]+)_/g, '<em>$1</em>')
      .replace(/==([^=]+)==/g, '<mark>$1</mark>');
  }

  function markdownToDocument(markdown, fallbackTitle) {
    const lines = markdown.replace(/\r\n?/g, '\n').split('\n');
    let title = fallbackTitle;
    if (lines[0] === '---') {
      const end = lines.indexOf('---', 1);
      if (end > 0) {
        const titleLine = lines.slice(1, end).find((line) => /^title:\s*/.test(line));
        if (titleLine) title = titleLine.replace(/^title:\s*/, '').trim() || fallbackTitle;
        lines.splice(0, end + 1);
      }
    }
    while (lines[0] === '') lines.shift();

    const html = [];
    for (let index = 0; index < lines.length;) {
      const line = lines[index];
      if (!line.trim()) { index += 1; continue; }
      if (/^```/.test(line)) {
        const code = [];
        index += 1;
        while (index < lines.length && !/^```/.test(lines[index])) code.push(lines[index++]);
        index += 1;
        html.push(`<pre><code>${escapeHtml(code.join('\n'))}</code></pre>`);
        continue;
      }
      if (/^\s*(?:---|\*\*\*|___)\s*$/.test(line)) {
        html.push('<hr>');
        index += 1;
        continue;
      }
      const heading = line.match(/^(#{1,3})\s+(.+)$/);
      if (heading) {
        const level = heading[1].length;
        html.push(`<h${level}>${inlineMarkdown(heading[2])}</h${level}>`);
        index += 1;
        continue;
      }
      if (/^>\s?/.test(line)) {
        html.push(`<blockquote>${inlineMarkdown(line.replace(/^>\s?/, ''))}</blockquote>`);
        index += 1;
        continue;
      }
      if (/^[-*]\s+/.test(line) || /^\d+\.\s+/.test(line)) {
        const ordered = /^\d+\./.test(line);
        const items = [];
        const pattern = ordered ? /^\d+\.\s+(.+)$/ : /^[-*]\s+(.+)$/;
        while (index < lines.length && pattern.test(lines[index])) {
          items.push(`<li>${inlineMarkdown(lines[index].match(pattern)[1])}</li>`);
          index += 1;
        }
        html.push(`<${ordered ? 'ol' : 'ul'}>${items.join('')}</${ordered ? 'ol' : 'ul'}>`);
        continue;
      }
      if (/^\|.+\|$/.test(line) && /^\|(?:\s*:?-+:?\s*\|)+$/.test(lines[index + 1] ?? '')) {
        const cells = (row) => row.slice(1, -1).split('|').map((cell) => cell.trim());
        const headers = cells(line);
        index += 2;
        const rows = [];
        while (index < lines.length && /^\|.+\|$/.test(lines[index])) rows.push(cells(lines[index++]));
        html.push(`<table><thead><tr>${headers.map((cell) => `<th>${inlineMarkdown(cell)}</th>`).join('')}</tr></thead><tbody>${rows.map((row) => `<tr>${row.map((cell) => `<td>${inlineMarkdown(cell)}</td>`).join('')}</tr>`).join('')}</tbody></table>`);
        continue;
      }
      const paragraph = [line];
      index += 1;
      while (index < lines.length && lines[index].trim() && !/^(#{1,3})\s|^>|^[-*]\s+|^\d+\.\s+|^```|^\|/.test(lines[index])) {
        paragraph.push(lines[index++]);
      }
      html.push(`<p>${inlineMarkdown(paragraph.join(' '))}</p>`);
    }
    return { title, html: html.join('') };
  }

  function documentToMarkdown(file) {
    const body = htmlToMarkdown(wysiwyg);
    return `---\ntitle: ${file.title}\n---${body ? `\n\n${body}` : '\n'}`;
  }

  files.set(activePath, { path: activePath, title: 'product-plan', html: initialBody, source: '' });
  files.set('notes/meeting-2026-07-08.md', {
    path: 'notes/meeting-2026-07-08.md',
    title: 'meeting-2026-07-08',
    html: '<p><strong>Monday, July 13</strong> · Ice + agent</p><h2>Decisions</h2><ol><li>Keep the workspace local-first.</li><li>Make agent changes inspectable.</li><li>Start with one person and their work.</li></ol>',
    source: '',
  });
  files.set('research/agent-workspaces.md', {
    path: 'research/agent-workspaces.md',
    title: 'Agent workspaces',
    html: '<p>Agents become more useful when their context lives beside the work, not inside a disposable chat.</p><h2>What they need</h2><ul><li>Readable files</li><li>Clear permissions</li><li>Visible history</li></ul>',
    source: '',
  });
  files.set('README.md', {
    path: 'README.md',
    title: 'Welcome to dohc',
    html: '<p>This folder is your workspace. Write here, then let your agents help you shape it.</p>',
    source: '',
  });
  files.set('AGENTS.md', {
    path: 'AGENTS.md',
    title: 'AGENTS',
    html: '<h1>Workspace instructions</h1><p>Agents read this file before working in this workspace.</p>',
    source: '',
  });
  files.set('.context/workspace.md', {
    path: '.context/workspace.md',
    title: 'workspace',
    html: '<h1>Workspace context</h1><p>Shared context that helps your agents understand how this workspace is organized.</p>',
    source: '',
  });
  files.set('data/launch-metrics.md', {
    path: 'data/launch-metrics.md',
    title: 'launch-metrics',
    html: '<h1>Launch metrics</h1><ul><li>Time to first document</li><li>Weekly active workspaces</li><li>Agent changes reviewed</li></ul>',
    source: '',
  });
  files.set('shared-with-me/research-brief.md', {
    path: 'shared-with-me/research-brief.md',
    title: 'research-brief',
    html: '<h1>Research brief</h1><p>A shared note stays readable beside the rest of your workspace.</p>',
    source: '',
  });

  function filename(path) {
    return path.split('/').at(-1);
  }

  function fileButton(file, depth = 0) {
    const button = document.createElement('button');
    button.type = 'button';
    button.className = `demo-file-row${file.path === activePath ? ' is-active' : ''}`;
    button.dataset.path = file.path;
    button.dataset.depth = String(depth);
    button.title = file.path;
    button.style.paddingLeft = `${24 + depth * 16}px`;
    button.innerHTML = '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M6 22a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h8a2.4 2.4 0 0 1 1.704.706l3.588 3.588A2.4 2.4 0 0 1 20 8v12a2 2 0 0 1-2 2z"/><path d="M14 2v5a1 1 0 0 0 1 1h5M10 9H8M16 13H8M16 17H8"/></svg><span></span>';
    button.querySelector('span').textContent = filename(file.path);
    button.addEventListener('click', () => {
      const separator = file.path.lastIndexOf('/');
      selectedFolder = separator < 0 ? null : file.path.slice(0, separator);
      openFile(file.path);
    });
    return button;
  }

  function openEditorRow(path) {
    const row = document.createElement('div');
    row.className = `demo-open-editor-row${path === activePath ? ' is-active' : ''}`;
    const activate = document.createElement('button');
    activate.type = 'button';
    activate.title = path;
    activate.innerHTML = '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M6 22a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h8a2.4 2.4 0 0 1 1.704.706l3.588 3.588A2.4 2.4 0 0 1 20 8v12a2 2 0 0 1-2 2z"/><path d="M14 2v5a1 1 0 0 0 1 1h5M10 9H8M16 13H8M16 17H8"/></svg><span></span>';
    activate.querySelector('span').textContent = filename(path);
    activate.addEventListener('click', () => openFile(path));
    const close = document.createElement('button');
    close.type = 'button';
    close.className = 'demo-open-editor-close';
    close.setAttribute('aria-label', `Close ${filename(path)}`);
    close.textContent = '×';
    close.addEventListener('click', () => closeFile(path));
    row.append(activate, close);
    return row;
  }

  function renderTabs() {
    const list = demo.querySelector('[data-demo-tab-list]');
    list.replaceChildren();
    openPaths.forEach((path) => {
      const tab = document.createElement('div');
      tab.className = `demo-tab${path === activePath ? ' is-active' : ''}`;
      tab.dataset.path = path;
      tab.setAttribute('role', 'tab');
      tab.tabIndex = 0;
      tab.title = path;
      tab.innerHTML = '<i></i><span data-demo-tab-name></span><button class="demo-tab-close" type="button" aria-label="Close file">×</button>';
      tab.querySelector('[data-demo-tab-name]').textContent = filename(path);
      tab.querySelector('i').classList.toggle('is-dirty', path === activePath && saving);
      tab.addEventListener('click', () => openFile(path));
      tab.addEventListener('keydown', (event) => {
        if (event.key === 'Enter' || event.key === ' ') openFile(path);
      });
      tab.querySelector('.demo-tab-close').addEventListener('click', (event) => {
        event.stopPropagation();
        closeFile(path);
      });
      list.append(tab);
    });
  }

  function renderFiles() {
    const openFileSlot = demo.querySelector('[data-demo-open-file]');
    const tree = demo.querySelector('[data-demo-file-tree]');
    openFileSlot.replaceChildren();
    if (editorsExpanded) {
      if (openPaths.length) openPaths.forEach((path) => openFileSlot.append(openEditorRow(path)));
      else {
        const empty = document.createElement('div');
        empty.className = 'demo-empty-tree';
        empty.textContent = 'No open editors';
        openFileSlot.append(empty);
      }
    }
    openFileSlot.hidden = !editorsExpanded;
    demo.querySelector('[data-demo-open-count]').textContent = String(openPaths.length);
    const editorToggle = demo.querySelector('[data-demo-toggle-editors]');
    editorToggle.setAttribute('aria-expanded', String(editorsExpanded));

    tree.replaceChildren();
    tree.hidden = !filesExpanded;
    const filesToggle = demo.querySelector('[data-demo-toggle-files]');
    filesToggle.setAttribute('aria-expanded', String(filesExpanded));
    if (!filesExpanded) {
      renderTabs();
      return;
    }

    const filesByParent = new Map();
    files.forEach((file) => {
      const parts = file.path.split('/');
      const parent = parts.slice(0, -1).join('/');
      if (!filesByParent.has(parent)) filesByParent.set(parent, []);
      filesByParent.get(parent).push(file);
      for (let index = 1; index < parts.length; index += 1) {
        folders.add(parts.slice(0, index).join('/'));
      }
    });

    function directFolders(parent) {
      return Array.from(folders)
        .filter((folder) => {
          const separator = folder.lastIndexOf('/');
          return (separator < 0 ? '' : folder.slice(0, separator)) === parent;
        })
        .sort((a, b) => filename(a).localeCompare(filename(b)));
    }

    function appendInlineEditor(parent, depth) {
      if (!inlineCreate || inlineCreate.parent !== parent) return;
      const row = document.createElement('div');
      row.className = 'demo-tree-edit';
      row.style.paddingLeft = `${24 + depth * 16}px`;
      row.innerHTML = inlineCreate.kind === 'folder'
        ? '<svg viewBox="0 0 24 24"><path d="M20 20a2 2 0 0 0 2-2V8a2 2 0 0 0-2-2h-7.9a2 2 0 0 1-1.69-.9L9.6 3.9A2 2 0 0 0 7.93 3H4a2 2 0 0 0-2 2v13a2 2 0 0 0 2 2Z"/></svg><input aria-label="New folder name" spellcheck="false">'
        : '<svg viewBox="0 0 24 24"><path d="M6 22a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h8a2.4 2.4 0 0 1 1.704.706l3.588 3.588A2.4 2.4 0 0 1 20 8v12a2 2 0 0 1-2 2z"/><path d="M14 2v5a1 1 0 0 0 1 1h5"/></svg><input aria-label="New file name" spellcheck="false">';
      const input = row.querySelector('input');
      let finished = false;
      const finish = (commit) => {
        if (finished) return;
        finished = true;
        finishInlineCreate(input.value, commit);
      };
      input.addEventListener('keydown', (event) => {
        event.stopPropagation();
        if (event.key === 'Enter') finish(true);
        else if (event.key === 'Escape') finish(false);
      });
      input.addEventListener('blur', () => finish(true));
      tree.append(row);
      requestAnimationFrame(() => input.focus());
    }

    function appendFolder(folder, depth) {
      const expanded = expandedFolders.has(folder);
      const row = document.createElement('button');
      row.type = 'button';
      row.className = `demo-folder-row${folder === selectedFolder ? ' is-focused' : ''}`;
      row.dataset.folder = folder;
      row.style.paddingLeft = `${8 + depth * 16}px`;
      row.setAttribute('aria-expanded', String(expanded));
      row.innerHTML = `<svg class="demo-tree-chevron" viewBox="0 0 24 24" aria-hidden="true"><path d="m9 18 6-6-6-6"/></svg><svg viewBox="0 0 24 24" aria-hidden="true"><path d="M20 20a2 2 0 0 0 2-2V8a2 2 0 0 0-2-2h-7.9a2 2 0 0 1-1.69-.9L9.6 3.9A2 2 0 0 0 7.93 3H4a2 2 0 0 0-2 2v13a2 2 0 0 0 2 2Z"/></svg><span></span>`;
      row.lastElementChild.textContent = filename(folder);
      row.addEventListener('click', () => {
        selectedFolder = folder;
        if (expanded) expandedFolders.delete(folder);
        else expandedFolders.add(folder);
        renderFiles();
      });
      tree.append(row);
      if (!expanded) return;
      appendInlineEditor(folder, depth + 1);
      directFolders(folder).forEach((child) => appendFolder(child, depth + 1));
      (filesByParent.get(folder) ?? [])
        .sort((a, b) => filename(a.path).localeCompare(filename(b.path)))
        .forEach((file) => tree.append(fileButton(file, depth + 1)));
    }

    appendInlineEditor('', 0);
    directFolders('').forEach((folder) => appendFolder(folder, 0));
    (filesByParent.get('') ?? [])
      .sort((a, b) => filename(a.path).localeCompare(filename(b.path)))
      .forEach((file) => tree.append(fileButton(file)));
    renderTabs();
  }

  function beginInlineCreate(kind) {
    filesExpanded = true;
    const parent = selectedFolder && folders.has(selectedFolder) ? selectedFolder : '';
    if (parent) expandedFolders.add(parent);
    inlineCreate = { kind, parent };
    renderFiles();
  }

  function finishInlineCreate(rawName, commit) {
    const pending = inlineCreate;
    inlineCreate = null;
    if (!pending || !commit || !rawName.trim()) {
      renderFiles();
      return;
    }
    let name = rawName.trim().replaceAll('\\', '/').replaceAll('/', '-');
    if (pending.kind === 'folder') {
      const path = pending.parent ? `${pending.parent}/${name}` : name;
      if (!folders.has(path)) {
        folders.add(path);
        selectedFolder = path;
        expandedFolders.add(path);
      }
      renderFiles();
      return;
    }
    if (!/\.[^/]+$/.test(name)) name += '.md';
    if (!/\.md$/i.test(name)) name += '.md';
    let path = pending.parent ? `${pending.parent}/${name}` : name;
    if (files.has(path)) {
      let index = 2;
      const stem = name.replace(/\.md$/i, '');
      while (files.has(pending.parent ? `${pending.parent}/${stem}-${index}.md` : `${stem}-${index}.md`)) index += 1;
      path = pending.parent ? `${pending.parent}/${stem}-${index}.md` : `${stem}-${index}.md`;
    }
    const title = filename(path).replace(/\.md$/i, '');
    files.set(path, { path, title, html: '', source: `---\ntitle: ${title}\n---\n` });
    openFile(path, true);
    addHistory(`Created ${filename(path)}`, pending.parent ? `In ${pending.parent}` : 'In workspace');
  }

  function addHistory(label, detail = 'Just now') {
    const history = demo.querySelector('[data-demo-history]');
    const event = document.createElement('div');
    event.className = 'demo-event';
    event.innerHTML = '<i></i><div><strong></strong><small></small></div>';
    event.querySelector('strong').textContent = label;
    event.querySelector('small').textContent = detail;
    history.querySelector('.demo-inspector-date').after(event);
    history.querySelectorAll('.demo-event').forEach((item, index) => {
      if (index > 5) item.remove();
    });
  }

  function setSaveState(isSaving) {
    window.clearTimeout(saveTimer);
    saving = isSaving;
    saveState.innerHTML = `<i></i>Local · ${isSaving ? 'saving…' : 'saved'}`;
    demo.querySelector('[data-demo-toolbar-save]').textContent = isSaving ? 'Saving…' : 'Saved';
    demo.querySelectorAll('.demo-tab').forEach((tab) => {
      tab.querySelector('i')?.classList.toggle('is-dirty', isSaving && tab.dataset.path === activePath);
    });
  }

  function queueSave(kind = 'Edited') {
    setSaveState(true);
    saveTimer = setTimeout(() => {
      setSaveState(false);
      if (activePath) addHistory(`${kind} ${filename(activePath)}`, 'Local file edit · just now');
    }, 650);
  }

  function syncDocumentToFile() {
    if (!activePath || !files.has(activePath)) return;
    const file = files.get(activePath);
    file.title = titleInput.value.trim() || filename(activePath).replace(/\.md$/i, '');
    file.html = wysiwyg.innerHTML;
    file.source = documentToMarkdown(file);
  }

  function openFile(path, focusEditor = false) {
    if (!files.has(path)) return;
    closeSlashMenu();
    if (activePath && activeMode === 'document') syncDocumentToFile();
    else if (activePath && files.has(activePath)) {
      const current = files.get(activePath);
      current.source = sourceEditor.value;
      Object.assign(current, markdownToDocument(current.source, current.title));
    }
    if (!openPaths.includes(path)) openPaths.push(path);
    activePath = path;
    const file = files.get(activePath);
    titleInput.value = file.title;
    wysiwyg.innerHTML = file.html;
    file.source ||= documentToMarkdown(file);
    sourceEditor.value = file.source;
    const parts = path.split('/');
    demo.querySelector('[data-demo-path-folder]').textContent = parts.length > 1 ? `${parts.slice(0, -1).join('/')}/` : '';
    demo.querySelector('[data-demo-path-name]').textContent = filename(path);
    demo.querySelector('[data-demo-editor-scroll]').scrollTop = 0;
    demo.querySelector('[data-demo-empty-editor]').hidden = true;
    documentEditor.hidden = activeMode !== 'document';
    sourceEditor.hidden = activeMode !== 'source';
    setSaveState(false);
    renderFiles();
    if (focusEditor) requestAnimationFrame(() => wysiwyg.focus());
  }

  function showEmptyEditor() {
    closeSlashMenu();
    activePath = null;
    documentEditor.hidden = true;
    sourceEditor.hidden = true;
    demo.querySelector('[data-demo-empty-editor]').hidden = false;
    demo.querySelector('[data-demo-path-folder]').textContent = '';
    demo.querySelector('[data-demo-path-name]').textContent = '';
    setSaveState(false);
    renderFiles();
  }

  function closeFile(path) {
    const index = openPaths.indexOf(path);
    if (index < 0) return;
    if (path === activePath) syncDocumentToFile();
    openPaths.splice(index, 1);
    if (path !== activePath) {
      renderFiles();
      return;
    }
    const next = openPaths[Math.min(index, openPaths.length - 1)];
    activePath = null;
    if (next) openFile(next);
    else showEmptyEditor();
  }

  function setMode(mode) {
    if (!activePath) return;
    if (mode === activeMode) return;
    closeSlashMenu();
    const file = files.get(activePath);
    if (mode === 'source') {
      syncDocumentToFile();
      sourceEditor.value = file.source;
    } else {
      file.source = sourceEditor.value;
      Object.assign(file, markdownToDocument(file.source, file.title));
      titleInput.value = file.title;
      wysiwyg.innerHTML = file.html;
    }
    activeMode = mode;
    documentEditor.hidden = mode !== 'document';
    sourceEditor.hidden = mode !== 'source';
    demo.querySelectorAll('[data-demo-mode]').forEach((button) => {
      const isActive = button.dataset.demoMode === mode;
      button.classList.toggle('is-active', isActive);
      button.setAttribute('aria-pressed', String(isActive));
    });
    requestAnimationFrame(() => (mode === 'source' ? sourceEditor : wysiwyg).focus());
  }

  function openNewFileDialog() {
    dialog.hidden = false;
    newFileInput.value = '';
    newFileError.textContent = '';
    requestAnimationFrame(() => newFileInput.focus());
  }

  function closeNewFileDialog() {
    dialog.hidden = true;
    newFileError.textContent = '';
  }

  function createFile(rawPath) {
    let path = rawPath.trim().replaceAll('\\', '/').replace(/^\/+/, '').replace(/\/+/g, '/');
    if (!path || path.endsWith('/')) return { error: 'Enter a file name.' };
    if (path.split('/').some((part) => part === '.' || part === '..' || part === '')) return { error: 'Use a path inside this workspace.' };
    if (!/\.[^/]+$/.test(path)) path += '.md';
    if (!/\.md$/i.test(path)) return { error: 'This slice creates Markdown (.md) files.' };
    if (files.has(path)) return { error: 'A file already exists at that path.' };
    const stem = filename(path).replace(/\.md$/i, '');
    const title = stem;
    files.set(path, { path, title, html: '', source: `---\ntitle: ${title}\n---\n` });
    openFile(path, true);
    addHistory(`Created ${filename(path)}`, path.includes('/') ? `In ${path.slice(0, path.lastIndexOf('/'))}` : 'In demo workspace');
    return { path };
  }

  function filterSlashCommands(query) {
    const normalized = query.trim().toLowerCase();
    if (!normalized) return slashCommands;
    return slashCommands.filter((command) =>
      command.label.toLowerCase().includes(normalized)
      || command.aliases.some((alias) => alias.includes(normalized)));
  }

  function textRange(rootNode, start, end) {
    const walker = document.createTreeWalker(rootNode, NodeFilter.SHOW_TEXT);
    const range = document.createRange();
    let offset = 0;
    let startSet = false;
    let node;
    while ((node = walker.nextNode())) {
      const next = offset + node.nodeValue.length;
      if (!startSet && start >= offset && start <= next) {
        range.setStart(node, Math.min(start - offset, node.nodeValue.length));
        startSet = true;
      }
      if (startSet && end >= offset && end <= next) {
        range.setEnd(node, Math.min(end - offset, node.nodeValue.length));
        return range;
      }
      offset = next;
    }
    return null;
  }

  function currentSlashMatch() {
    const selection = window.getSelection();
    if (activeMode !== 'document' || !selection?.rangeCount || !selection.isCollapsed) return null;
    if (!wysiwyg.contains(selection.anchorNode)) return null;
    const caret = selection.getRangeAt(0);
    const anchorElement = caret.startContainer.nodeType === Node.ELEMENT_NODE
      ? caret.startContainer
      : caret.startContainer.parentElement;
    const block = anchorElement?.closest('p, h1, h2, h3, li, blockquote, pre, td, th, summary, div');
    if (!block || !wysiwyg.contains(block)) return null;
    if (block === wysiwyg && caret.startContainer.nodeType === Node.TEXT_NODE) {
      const textBeforeCaret = caret.startContainer.nodeValue.slice(0, caret.startOffset);
      const match = /(?:^|\s)\/([A-Za-z0-9_-]{0,40})$/.exec(textBeforeCaret);
      if (!match) return null;
      const matchedText = match[0] ?? '';
      const slashOffset = match.index + matchedText.lastIndexOf('/');
      const range = document.createRange();
      range.setStart(caret.startContainer, slashOffset);
      range.setEnd(caret.startContainer, caret.startOffset);
      return { query: (match[1] ?? '').toLowerCase(), range };
    }
    if (block === wysiwyg) return null;
    const before = document.createRange();
    before.selectNodeContents(block);
    try {
      before.setEnd(caret.startContainer, caret.startOffset);
    } catch {
      return null;
    }
    const textBeforeCaret = before.toString();
    const match = /(?:^|\s)\/([A-Za-z0-9_-]{0,40})$/.exec(textBeforeCaret);
    if (!match) return null;
    const matchedText = match[0] ?? '';
    const slashOffset = match.index + matchedText.lastIndexOf('/');
    const range = textRange(block, slashOffset, textBeforeCaret.length);
    if (!range) return null;
    return { query: (match[1] ?? '').toLowerCase(), range };
  }

  function closeSlashMenu(dismiss = false) {
    slashState = { open: false, query: '', selected: 0, range: null };
    slashMenu.hidden = true;
    wysiwyg.removeAttribute('aria-activedescendant');
    if (dismiss) slashDismissed = true;
  }

  function positionSlashMenu(range) {
    const pageRect = documentEditor.getBoundingClientRect();
    const scrollRect = demo.querySelector('[data-demo-editor-scroll]').getBoundingClientRect();
    const cursor = range.cloneRange();
    cursor.collapse(true);
    const rect = cursor.getClientRects()[0] ?? range.getBoundingClientRect();
    const width = slashMenu.offsetWidth;
    const height = Math.min(slashMenu.scrollHeight, 320);
    const minTop = Math.max(6, scrollRect.top - pageRect.top + 6);
    const maxBottom = scrollRect.bottom - pageRect.top - 6;
    const below = rect.bottom - pageRect.top + 7;
    const above = rect.top - pageRect.top - height - 7;
    const top = below + height <= maxBottom ? below : Math.max(minTop, above);
    const left = Math.max(6, Math.min(pageRect.width - width - 6, rect.left - pageRect.left));
    slashMenu.style.left = `${left}px`;
    slashMenu.style.top = `${top}px`;
  }

  function renderSlashMenu() {
    if (!slashState.open) return closeSlashMenu();
    const items = filterSlashCommands(slashState.query);
    slashMenu.replaceChildren();
    if (!items.length) {
      const empty = document.createElement('div');
      empty.className = 'demo-slash-empty';
      empty.textContent = 'No commands';
      slashMenu.append(empty);
    } else {
      slashState.selected = Math.min(slashState.selected, items.length - 1);
      items.forEach((command, index) => {
        const button = document.createElement('button');
        button.type = 'button';
        button.id = `demo-slash-${command.id}`;
        button.dataset.demoSlashCommand = command.id;
        button.setAttribute('role', 'option');
        button.setAttribute('aria-selected', String(index === slashState.selected));
        button.classList.toggle('is-selected', index === slashState.selected);
        button.innerHTML = `<span>${escapeHtml(command.glyph)}</span><i><strong>${escapeHtml(command.label)}</strong><small>${escapeHtml(command.hint)}</small></i>`;
        button.addEventListener('mouseenter', () => {
          if (slashState.selected === index) return;
          slashState.selected = index;
          renderSlashMenu();
        });
        button.addEventListener('click', () => runSlashCommand(command.id));
        slashMenu.append(button);
      });
      wysiwyg.setAttribute('aria-activedescendant', items[slashState.selected] ? `demo-slash-${items[slashState.selected].id}` : '');
    }
    slashMenu.hidden = false;
    positionSlashMenu(slashState.range);
    slashMenu.querySelector('.is-selected')?.scrollIntoView({ block: 'nearest' });
  }

  function refreshSlashMenu() {
    if (slashDismissed) return;
    const match = currentSlashMatch();
    if (!match) return closeSlashMenu();
    const queryChanged = !slashState.open || slashState.query !== match.query;
    slashState = {
      open: true,
      query: match.query,
      selected: queryChanged ? 0 : slashState.selected,
      range: match.range.cloneRange(),
    };
    renderSlashMenu();
  }

  function insertTextAtSelection(text, caretOffset = text.length) {
    const selection = window.getSelection();
    if (!selection?.rangeCount) return;
    const range = selection.getRangeAt(0);
    const node = document.createTextNode(text);
    range.insertNode(node);
    range.setStart(node, caretOffset);
    range.collapse(true);
    selection.removeAllRanges();
    selection.addRange(range);
  }

  function runSlashCommand(id) {
    if (!slashState.open || !slashState.range) return;
    const range = slashState.range.cloneRange();
    if (range.startContainer.nodeType === Node.TEXT_NODE && range.startContainer.parentNode === wysiwyg) {
      const paragraph = document.createElement('p');
      wysiwyg.insertBefore(paragraph, range.startContainer);
      paragraph.append(range.startContainer);
    }
    const selection = window.getSelection();
    wysiwyg.focus();
    selection.removeAllRanges();
    selection.addRange(range);
    range.deleteContents();
    range.collapse(true);
    selection.removeAllRanges();
    selection.addRange(range);
    closeSlashMenu();

    if (id === 'wikilink') insertTextAtSelection('[[]]', 2);
    else if (id === 'heading-1') document.execCommand('formatBlock', false, 'h1');
    else if (id === 'heading-2') document.execCommand('formatBlock', false, 'h2');
    else if (id === 'heading-3') document.execCommand('formatBlock', false, 'h3');
    else if (id === 'bulleted-list') document.execCommand('insertUnorderedList');
    else if (id === 'numbered-list') document.execCommand('insertOrderedList');
    else if (id === 'task-list') {
      document.execCommand('insertUnorderedList');
      document.execCommand('insertText', false, '☐ ');
    } else if (id === 'quote') document.execCommand('formatBlock', false, 'blockquote');
    else if (id === 'callout') document.execCommand('insertHTML', false, '<blockquote><strong>Note</strong><br></blockquote><p><br></p>');
    else if (id === 'toggle') document.execCommand('insertHTML', false, '<details open><summary>Toggle</summary><p><br></p></details><p><br></p>');
    else if (id === 'code-block') document.execCommand('formatBlock', false, 'pre');
    else if (id === 'mermaid') document.execCommand('insertHTML', false, '<pre>flowchart TD\n  A[Start] --&gt; B[Next]</pre><p><br></p>');
    else if (id === 'math') document.execCommand('insertHTML', false, '<pre>$$\n\n$$</pre><p><br></p>');
    else if (id === 'divider') document.execCommand('insertHorizontalRule');
    else if (id === 'table') document.execCommand('insertHTML', false, '<table><thead><tr><th>Column 1</th><th>Column 2</th><th>Column 3</th></tr></thead><tbody><tr><td><br></td><td><br></td><td><br></td></tr><tr><td><br></td><td><br></td><td><br></td></tr></tbody></table><p><br></p>');
    else if (id === 'image') {
      const imageRange = window.getSelection()?.rangeCount ? window.getSelection().getRangeAt(0).cloneRange() : null;
      const picker = document.createElement('input');
      picker.type = 'file';
      picker.accept = 'image/*';
      picker.addEventListener('change', () => {
        const file = picker.files?.[0];
        if (!file || !imageRange) return;
        const reader = new FileReader();
        reader.addEventListener('load', () => {
          const current = window.getSelection();
          current.removeAllRanges();
          current.addRange(imageRange);
          document.execCommand('insertHTML', false, `<img src="${reader.result}" alt="${escapeHtml(file.name)}"><p><br></p>`);
          syncDocumentToFile();
          queueSave();
        });
        reader.readAsDataURL(file);
      }, { once: true });
      picker.click();
    }
    syncDocumentToFile();
    queueSave();
    wysiwyg.focus();
  }

  function updateBubbleMenu() {
    if (activeMode !== 'document' || !wysiwyg.contains(document.activeElement)) {
      bubbleMenu.hidden = true;
      blockGutter.hidden = true;
      return;
    }
    const selection = window.getSelection();
    if (!selection?.rangeCount || selection.isCollapsed || !wysiwyg.contains(selection.anchorNode)) {
      bubbleMenu.hidden = true;
      blockGutter.hidden = true;
      return;
    }
    const rect = selection.getRangeAt(0).getBoundingClientRect();
    savedFormattingRange = selection.getRangeAt(0).cloneRange();
    const pageRect = documentEditor.getBoundingClientRect();
    bubbleMenu.hidden = false;
    blockGutter.hidden = false;
    const width = bubbleMenu.offsetWidth;
    bubbleMenu.style.left = `${Math.max(6, Math.min(pageRect.width - width - 6, rect.left - pageRect.left + rect.width / 2 - width / 2))}px`;
    bubbleMenu.style.top = `${Math.max(6, rect.top - pageRect.top - bubbleMenu.offsetHeight - 8)}px`;
    blockGutter.style.top = `${Math.max(0, rect.top - pageRect.top)}px`;
  }

  demo.querySelectorAll('[data-demo-new-file]').forEach((button) => button.addEventListener('click', openNewFileDialog));
  demo.querySelector('[data-demo-toggle-explorer]').addEventListener('click', (event) => {
    explorerVisible = !explorerVisible;
    demo.classList.toggle('is-explorer-hidden', !explorerVisible);
    event.currentTarget.classList.toggle('is-active', explorerVisible);
    event.currentTarget.setAttribute('aria-current', explorerVisible ? 'page' : 'false');
  });
  demo.querySelector('[data-demo-toggle-editors]').addEventListener('click', () => {
    editorsExpanded = !editorsExpanded;
    renderFiles();
  });
  demo.querySelector('[data-demo-toggle-files]').addEventListener('click', () => {
    filesExpanded = !filesExpanded;
    renderFiles();
  });
  demo.querySelector('[data-demo-inline-new-file]').addEventListener('click', () => beginInlineCreate('file'));
  demo.querySelector('[data-demo-new-folder]').addEventListener('click', () => beginInlineCreate('folder'));
  demo.querySelector('[data-demo-collapse-folders]').addEventListener('click', () => {
    expandedFolders.clear();
    selectedFolder = null;
    renderFiles();
  });
  demo.querySelector('[data-demo-refresh]').addEventListener('click', (event) => {
    event.currentTarget.classList.add('is-refreshing');
    renderFiles();
    setTimeout(() => event.currentTarget.classList.remove('is-refreshing'), 320);
  });
  demo.querySelector('[data-demo-close-all]').addEventListener('click', () => {
    syncDocumentToFile();
    openPaths.splice(0);
    showEmptyEditor();
  });
  demo.querySelector('[data-demo-new-untitled]').addEventListener('click', () => {
    let index = 1;
    let path = 'Untitled.md';
    while (files.has(path)) path = `Untitled-${++index}.md`;
    const title = filename(path).replace(/\.md$/i, '');
    files.set(path, { path, title, html: '', source: `---\ntitle: ${title}\n---\n` });
    selectedFolder = null;
    openFile(path, true);
    addHistory(`Created ${path}`, 'Unsaved text file');
  });
  demo.querySelector('[data-demo-new-file-form]').addEventListener('submit', (event) => {
    event.preventDefault();
    const result = createFile(newFileInput.value);
    if (result.error) newFileError.textContent = result.error;
    else closeNewFileDialog();
  });
  dialog.addEventListener('mousedown', (event) => {
    if (event.target === dialog) closeNewFileDialog();
  });
  demo.querySelectorAll('[data-demo-mode]').forEach((button) => button.addEventListener('click', () => setMode(button.dataset.demoMode)));

  titleInput.addEventListener('input', () => {
    syncDocumentToFile();
    queueSave('Renamed');
  });
  wysiwyg.addEventListener('input', () => {
    syncDocumentToFile();
    queueSave();
    slashDismissed = false;
    refreshSlashMenu();
  });
  sourceEditor.addEventListener('input', () => {
    files.get(activePath).source = sourceEditor.value;
    queueSave();
  });

  document.addEventListener('selectionchange', () => {
    updateBubbleMenu();
    if (!slashDismissed) refreshSlashMenu();
  });
  bubbleMenu.addEventListener('mousedown', (event) => event.preventDefault());
  bubbleMenu.querySelectorAll('[data-demo-command]').forEach((button) => {
    button.addEventListener('click', () => {
      if (savedFormattingRange) {
        wysiwyg.focus();
        const selection = window.getSelection();
        selection.removeAllRanges();
        selection.addRange(savedFormattingRange);
      }
      const command = button.dataset.demoCommand;
      if (command === 'code') {
        const selection = window.getSelection();
        const selected = selection?.toString() ?? '';
        if (selected) document.execCommand('insertHTML', false, `<code>${escapeHtml(selected)}</code>`);
      } else {
        document.execCommand(command, false, button.dataset.demoCommandValue ?? null);
      }
      syncDocumentToFile();
      queueSave();
      bubbleMenu.hidden = true;
      blockGutter.hidden = true;
    });
  });
  slashMenu.addEventListener('mousedown', (event) => event.preventDefault());
  wysiwyg.addEventListener('keydown', (event) => {
    if (!slashState.open) return;
    const items = filterSlashCommands(slashState.query);
    if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
      event.preventDefault();
      if (!items.length) return;
      const direction = event.key === 'ArrowDown' ? 1 : -1;
      slashState.selected = (slashState.selected + direction + items.length) % items.length;
      renderSlashMenu();
    } else if (event.key === 'Enter' || event.key === 'Tab') {
      const command = items[slashState.selected] ?? items[0];
      if (!command) return;
      event.preventDefault();
      runSlashCommand(command.id);
    } else if (event.key === 'Escape') {
      event.preventDefault();
      event.stopPropagation();
      closeSlashMenu(true);
      wysiwyg.focus();
    }
  });

  document.addEventListener('pointerdown', (event) => {
    if (wysiwyg.contains(event.target)) {
      slashDismissed = false;
      return;
    }
    if (slashState.open && !slashMenu.contains(event.target)) closeSlashMenu(true);
  });

  demo.addEventListener('keydown', (event) => {
    if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === 'n') {
      event.preventDefault();
      openNewFileDialog();
    }
    if (event.key === 'Escape') {
      if (!dialog.hidden) closeNewFileDialog();
      closeSlashMenu(true);
      bubbleMenu.hidden = true;
      blockGutter.hidden = true;
    }
  });

  openFile(activePath);
}

const reduced = matchMedia('(prefers-reduced-motion: reduce)').matches;
const targets = document.querySelectorAll('.reveal');

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

document.getElementById('year').textContent = new Date().getFullYear();
