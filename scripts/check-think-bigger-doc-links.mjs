#!/usr/bin/env node

import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import GithubSlugger from 'github-slugger'

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const canonicalRepoRoot = fs.realpathSync(repoRoot)
const escapesRepoRoot = (relativePath) => (
  relativePath === '..'
  || relativePath.startsWith(`..${path.sep}`)
  || path.isAbsolute(relativePath)
)
const manifestPath = path.resolve(
  repoRoot,
  'docs/superpowers/plans/2026-06-23-think-bigger-docs.manifest.json',
)

let manifest
try {
  manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'))
} catch (error) {
  console.error(`Unable to read Think Bigger docs manifest at ${manifestPath}: ${error.message}`)
  process.exit(1)
}
const expectedThinkBiggerDocs = manifest?.thinkBiggerDocs

if (
  !Array.isArray(expectedThinkBiggerDocs)
  || expectedThinkBiggerDocs.some((file) => typeof file !== 'string')
  || new Set(expectedThinkBiggerDocs).size !== expectedThinkBiggerDocs.length
) {
  console.error('Think Bigger docs manifest must contain a unique thinkBiggerDocs string array')
  process.exit(1)
}

const discoverThinkBiggerDocs = () => {
  const repoRelativePath = (...segments) => path.posix.join(...segments)
  const expectedSpecDocs = new Set(expectedThinkBiggerDocs
    .filter((file) => file.startsWith('docs/superpowers/specs/')))
  const thinkBiggerCohortPattern =
    /^Cohort:\s*(?:Think Bigger planning and design documentation|Think Bigger documentation and tooling|Think Bigger dohc documentation and link-check tooling|Core Architecture Specs|Architecture Specifications|Design specs and mega plan|Design specs for versioning, chats, and filesystem|Architecture specs and mega-plan|Architecture specifications and mega-plan|Think Bigger documentation suite|Think Bigger dohc Workspace Engine(?: Documentation and CI| docs and CI enforcement)?|dohc Workspace Engine documentation and CI infrastructure|dohc\s+Think Bigger Workspace Engine|dohc Workspace Engine Docs, Specs, and CI)$/im
  const hasThinkBiggerCohortMetadata = (dir, name) => {
    const candidatePath = path.resolve(repoRoot, dir, name)
    let canonicalCandidatePath
    try {
      canonicalCandidatePath = fs.realpathSync(candidatePath)
      const relativeCandidate = path.relative(canonicalRepoRoot, canonicalCandidatePath)
      if (escapesRepoRoot(relativeCandidate)) {
        return false
      }
      if (!fs.statSync(canonicalCandidatePath).isFile()) {
        return false
      }
    } catch {
      return false
    }

    const raw = fs.readFileSync(canonicalCandidatePath, 'utf8')
    return thinkBiggerCohortPattern.test(raw)
  }
  const discoveryRoots = [
    {
      dir: 'docs/superpowers/plans',
      include: (name) => /^\d{4}-\d{2}-\d{2}-think-bigger-.*\.md$/.test(name),
    },
    {
      dir: 'docs/superpowers/specs',
      include: (name) => {
        const file = repoRelativePath('docs/superpowers/specs', name)
        return expectedSpecDocs.has(file) || hasThinkBiggerCohortMetadata('docs/superpowers/specs', name)
      },
    },
  ]
  const safeReadDir = (dir) => {
    try {
      return fs.readdirSync(path.resolve(repoRoot, dir))
    } catch {
      return []
    }
  }

  return discoveryRoots
    .flatMap(({ dir, include }) => safeReadDir(dir)
      .filter((name) => name.endsWith('.md') && include(name))
      .map((name) => repoRelativePath(dir, name)))
    .sort()
}

const discoveredThinkBiggerDocs = discoverThinkBiggerDocs()
const missingExpectedDocs = expectedThinkBiggerDocs.filter((file) => !discoveredThinkBiggerDocs.includes(file))
const unexpectedDiscoveredDocs = discoveredThinkBiggerDocs.filter((file) => !expectedThinkBiggerDocs.includes(file))

if (missingExpectedDocs.length > 0) {
  console.error(`Think Bigger docs discovery missed expected files:\n${missingExpectedDocs.join('\n')}`)
  process.exit(1)
}

if (unexpectedDiscoveredDocs.length > 0) {
  console.error(`Think Bigger docs manifest is missing discovered files:\n${unexpectedDiscoveredDocs.join('\n')}`)
  process.exit(1)
}

const files = discoveredThinkBiggerDocs

const visibleHeadingText = (heading) => {
  const codeSpans = []
  const withCodePlaceholders = heading.replace(/`([^`]*)`/g, (_match, code) => {
    const index = codeSpans.push(code) - 1
    return `\u0000${index}\u0000`
  })

  return withCodePlaceholders
    .replace(/!\[([^\]\n]*)\]\([^)]*\)/g, '$1')
    .replace(/\[([^\]\n]+)\]\([^)]*\)/g, '$1')
    .replace(/\[([^\]\n]+)\]\[[^\]\n]*\]/g, '$1')
    .replace(/(^|[^\w])__([^_\n]+)__($|[^\w])/g, '$1$2$3')
    .replace(/(^|[^\w])_([^_\n]+)_($|[^\w])/g, '$1$2$3')
    .replace(/<[^>]+>/g, '')
    .replace(/\u0000(\d+)\u0000/g, (_match, index) => codeSpans[Number(index)] ?? '')
}

const decodeCodePoint = (value, radix, fallback) => {
  const codePoint = Number.parseInt(value, radix)
  return Number.isInteger(codePoint) && codePoint >= 0 && codePoint <= 0x10ffff
    ? String.fromCodePoint(codePoint)
    : fallback
}

const decodeHtmlEntities = (text) => text
  .replace(/&#(\d+);/g, (match, code) => decodeCodePoint(code, 10, match))
  .replace(/&#x([0-9a-f]+);/gi, (match, code) => decodeCodePoint(code, 16, match))
  .replace(/&amp;/g, '&')
  .replace(/&lt;/g, '<')
  .replace(/&gt;/g, '>')
  .replace(/&quot;/g, '"')
  .replace(/&#39;/g, "'")

const slug = (heading, slugger = new GithubSlugger()) => slugger.slug(
  decodeHtmlEntities(visibleHeadingText(heading)).trim(),
)

const splitLocalTarget = (raw) => {
  const hashIndex = raw.indexOf('#')
  const targetWithQueryRaw = hashIndex === -1 ? raw : raw.slice(0, hashIndex)
  const queryIndex = targetWithQueryRaw.indexOf('?')
  return {
    targetRaw: queryIndex === -1 ? targetWithQueryRaw : targetWithQueryRaw.slice(0, queryIndex),
    anchorRaw: hashIndex === -1 ? '' : raw.slice(hashIndex + 1),
  }
}

const rawHtmlAnchorTagPattern = /<a\b[^>]*>/gi
const htmlAttributeValue = (tag, attrName) => {
  const attributePattern = new RegExp(`(?:^|\\s)${attrName}\\s*=\\s*(?:"([^"]*)"|'([^']*)'|([^\\s"'>=]+))`, 'i')
  const match = tag.match(attributePattern)
  const value = match?.[1] ?? match?.[2] ?? match?.[3]
  return value === undefined ? null : decodeHtmlEntities(value)
}

const indentationWidth = (line) => line.match(/^[ \t]*/)[0].replace(/\t/g, '    ').length

function* contentLines(markdown) {
  let inFence = false
  let fenceChar = null
  let fenceLength = 0
  let inIndentedCode = false
  let activeListIndent = null
  let inHtmlComment = false

  const stripHtmlComments = (line) => {
    let rest = line
    let visible = ''
    while (rest.length > 0) {
      if (inHtmlComment) {
        const end = rest.indexOf('-->')
        if (end === -1) {
          return visible
        }
        rest = rest.slice(end + 3)
        inHtmlComment = false
        continue
      }

      const start = rest.indexOf('<!--')
      if (start === -1) {
        return visible + rest
      }

      visible += rest.slice(0, start)
      rest = rest.slice(start + 4)
      const end = rest.indexOf('-->')
      if (end === -1) {
        inHtmlComment = true
        return visible
      }
      rest = rest.slice(end + 3)
    }
    return visible
  }

  let lineIndex = 0
  for (const rawLine of markdown.split(/\r?\n/)) {
    lineIndex += 1
    const rawVisibleLine = inFence ? rawLine : stripHtmlComments(rawLine)
    const stripBlockquoteMarkers = (value) => value.replace(/^(?: {0,3}>[ \t]?)+/, '')
    const line = inFence ? rawVisibleLine : stripBlockquoteMarkers(rawVisibleLine)
    const fenceLine = stripBlockquoteMarkers(rawVisibleLine)
    const rawFence = fenceLine.match(/^([ \t]*)(```+|~~~+)(.*)$/)
    const listItem = line.match(/^([ \t]*)(?:[-+*]|\d+[.)])([ \t]+)/)
    const indentedListItem = Boolean(listItem)
    const leadingIndent = indentationWidth(line)
    const listContentIndent = listItem ? indentationWidth(listItem[0]) : null
    const fenceIndent = rawFence ? indentationWidth(rawFence[1]) : null
    const fence = rawFence && (
      fenceIndent <= 3
      || (
        activeListIndent !== null
        && fenceIndent >= activeListIndent
        && fenceIndent <= activeListIndent + 3
      )
    )
    const listCodeBlock = activeListIndent !== null
      && line.trim() !== ''
      && leadingIndent >= activeListIndent + 4
      && !indentedListItem
    const listContinuation = activeListIndent !== null
      && line.trim() !== ''
      && leadingIndent >= activeListIndent
      && !listCodeBlock
    const indentedCode = (/^(?: {4}|\t)/.test(line) && !indentedListItem && !listContinuation)
      || listCodeBlock

    if (fence && !inFence) {
      const marker = rawFence[2][0]
      const markerLength = rawFence[2].length
      inFence = true
      fenceChar = marker
      fenceLength = markerLength
      continue
    }

    if (fence && inFence) {
      const marker = rawFence[2][0]
      const markerLength = rawFence[2].length
      const trailing = rawFence[3]
      if (marker === fenceChar && markerLength >= fenceLength && trailing.trim() === '') {
        inFence = false
        fenceChar = null
        fenceLength = 0
      }
      continue
    }

    if (!inFence && indentedCode) {
      inIndentedCode = true
      activeListIndent = null
      continue
    }

    if (inIndentedCode) {
      if (line.trim() === '') {
        continue
      }
      inIndentedCode = false
    }

    if (!inFence) {
      if (indentedListItem) {
        activeListIndent = listContentIndent
      } else if (line.trim() !== '' && activeListIndent !== null && leadingIndent < activeListIndent) {
        activeListIndent = null
      }
      yield { text: line, lineNumber: lineIndex }
    }
  }
}

const collectAnchors = (markdown) => {
  const anchors = new Set()
  const slugger = new GithubSlugger()
  const addAnchor = (headingText) => {
    anchors.add(slug(headingText.replace(/[ \t]+#+[ \t]*$/, ''), slugger))
  }
  let previousLine = null
  const stripCodeSpans = (line) => line.replace(/(`+)(?:(?!\1).)*\1/g, ' ')

  for (const { text: line } of contentLines(markdown)) {
    const prose = stripCodeSpans(line)
    for (const match of prose.matchAll(rawHtmlAnchorTagPattern)) {
      const anchor = htmlAttributeValue(match[0], 'id') ?? htmlAttributeValue(match[0], 'name')
      if (anchor) {
        anchors.add(anchor)
      }
    }

    const heading = line.match(/^\s{0,3}#{1,6}\s+(.*?)\s*$/)
    if (heading) {
      addAnchor(heading[1])
      previousLine = null
      continue
    }

    const setext = line.match(/^\s{0,3}(=+|-+)\s*$/)
    if (setext && previousLine?.trim()) {
      addAnchor(previousLine.trim())
      previousLine = null
      continue
    }

    previousLine = line
  }

  return anchors
}

const collectLinks = (markdown) => {
  const links = []
  const unresolvedReferences = []
  const lines = [...contentLines(markdown)]
  const addLink = (target, lineNumber) => {
    links.push({ target, lineNumber })
  }
  const referenceDefinitions = new Map()
  const normalizeLabel = (label) => label.trim().replace(/\s+/g, ' ').toLowerCase()
  const isFootnoteLabel = (label) => label.trim().startsWith('^')
  const normalizeDestination = (destination) => (
    destination.startsWith('<') && destination.endsWith('>')
      ? destination.slice(1, -1)
      : destination
  )
  const stripCodeSpans = (line) => line.replace(/(`+)(?:(?!\1).)*\1/g, ' ')
  const nestedImageLinkPattern = /\[!\[[^\]\n]*\]\((<[^>\n]*>|(?:[^()\s]|\([^()\n]*\))*)(?:\s+(?:"[^"]*"|'[^']*'|\([^)]*\)))?\)\]\((<[^>\n]*>|(?:[^()\s]|\([^()\n]*\))*)(?:\s+(?:"[^"]*"|'[^']*'|\([^)]*\)))?\)/g
  const linkPattern = /!?\[[^\]\n]*\]\((<[^>\n]*>|(?:[^()\s]|\([^()\n]*\))*)(?:\s+(?:"[^"]*"|'[^']*'|\([^)]*\)))?\)/g
  const referenceDefinitionPattern = /^\s{0,3}\[([^\]\n]+)\]:\s*(<[^>\n]+>|[^\s]+)/
  const footnoteDefinitionPattern = /^\s{0,3}\[\^[^\]\n]+\]:\s*/
  const referenceUsePattern = /!?\[([^\]\n]+)\]\[([^\]\n]*)\]/g
  const shortcutReferencePattern = /!?\[([^\]\n]+)\](?![\[(])/g
  const autolinkPattern = /<([A-Za-z][A-Za-z0-9+.-]*:[^<>\s]*)>/g
  const bracketIndexTokenPattern = /^(?:[A-Za-z_$][A-Za-z0-9_$]*|\d+)$/
  const looksLikeBracketIndexing = (prose, match) => {
    const index = match.index ?? -1
    const before = index > 0 ? prose[index - 1] : ''
    const left = match[1].trim()
    const right = match[2].trim()
    const bothIndexTokens = bracketIndexTokenPattern.test(left) && bracketIndexTokenPattern.test(right)
    const bothNumeric = /^\d+$/.test(left) && /^\d+$/.test(right)
    return bothIndexTokens && (bothNumeric || /[A-Za-z0-9_$)\]]/.test(before))
  }

  for (const { text: line, lineNumber } of lines) {
    const prose = stripCodeSpans(line)
    const definition = prose.match(referenceDefinitionPattern)
    if (definition) {
      if (isFootnoteLabel(definition[1])) {
        continue
      }
      const destination = normalizeDestination(definition[2])
      referenceDefinitions.set(normalizeLabel(definition[1]), destination)
      addLink(destination, lineNumber)
    }
  }

  for (const { text: line, lineNumber } of lines) {
    let prose = stripCodeSpans(line)
    const footnoteDefinition = prose.match(footnoteDefinitionPattern)
    if (footnoteDefinition) {
      prose = prose.slice(footnoteDefinition[0].length)
    } else if (referenceDefinitionPattern.test(prose)) {
      continue
    }
    for (const match of prose.matchAll(rawHtmlAnchorTagPattern)) {
      const href = htmlAttributeValue(match[0], 'href')
      if (href !== null) {
        addLink(href, lineNumber)
      }
    }
    prose = prose.replace(rawHtmlAnchorTagPattern, ' ')
    for (const match of prose.matchAll(nestedImageLinkPattern)) {
      addLink(normalizeDestination(match[1]), lineNumber)
      addLink(normalizeDestination(match[2]), lineNumber)
    }
    prose = prose.replace(nestedImageLinkPattern, '')
    for (const match of prose.matchAll(linkPattern)) {
      addLink(normalizeDestination(match[1]), lineNumber)
    }
    for (const match of prose.matchAll(referenceUsePattern)) {
      const label = normalizeLabel(match[2] === '' ? match[1] : match[2])
      if (isFootnoteLabel(label)) {
        continue
      }
      const destination = referenceDefinitions.get(label)
      if (destination) {
        addLink(destination, lineNumber)
      } else if (looksLikeBracketIndexing(prose, match)) {
        continue
      } else {
        unresolvedReferences.push({ reference: match[0], lineNumber })
      }
    }
    prose = prose.replace(referenceUsePattern, '')
    for (const match of prose.matchAll(shortcutReferencePattern)) {
      if (isFootnoteLabel(match[1])) {
        continue
      }
      const destination = referenceDefinitions.get(normalizeLabel(match[1]))
      if (destination) {
        addLink(destination, lineNumber)
      }
    }
    for (const match of prose.matchAll(autolinkPattern)) {
      if (/^<\/?[A-Za-z][A-Za-z0-9-]*\s*\/?>$/.test(match[0])) {
        continue
      }
      addLink(match[1], lineNumber)
    }
  }

  return { links, unresolvedReferences }
}

const isMarkdownPath = (targetPath) => /\.(?:md|markdown)$/i.test(targetPath)

const assertCheckerFixtures = () => {
  const splitQueryTarget = splitLocalTarget('./diagram.svg?raw=1#overview')
  if (splitQueryTarget.targetRaw !== './diagram.svg' || splitQueryTarget.anchorRaw !== 'overview') {
    throw new Error('local query fixture should strip query strings while preserving anchors')
  }

  const relativeAutolink = collectLinks('<./foo.md> and <foo/bar>')
  if (relativeAutolink.links.length > 0) {
    throw new Error('relative angle-bracket paths should not be treated as autolinks')
  }
  const schemeAutolink = collectLinks('<app://workspace/thread>')
  if (!schemeAutolink.links.some((link) => link.target === 'app://workspace/thread')) {
    throw new Error('app autolink fixture should still collect supported URI schemes')
  }
  const disallowedAutolink = collectLinks('<ftp://example.com/file>')
  if (!disallowedAutolink.links.some((link) => link.target === 'ftp://example.com/file')) {
    throw new Error('disallowed URI scheme fixture should still reach validation')
  }

  const commented = collectLinks('<!-- [hidden](./missing.md) -->\nVisible')
  if (commented.links.length > 0) {
    throw new Error('HTML comment fixture should not produce links')
  }
  if (collectAnchors('<!-- # Hidden -->').has('hidden')) {
    throw new Error('HTML comment fixture should not produce anchors')
  }
  if (!collectAnchors('## `WriteResult<T>`').has('writeresultt')) {
    throw new Error('generic code-span heading fixture should preserve type text in anchors')
  }
  const duplicateWhitespaceAnchors = collectAnchors('## Duplicate   Space\n## Duplicate Space')
  if (!duplicateWhitespaceAnchors.has('duplicate---space') || !duplicateWhitespaceAnchors.has('duplicate-space')) {
    throw new Error('GitHub slugger fixture should preserve GitHub-style whitespace behavior')
  }
  if (!collectAnchors('## Ship it 🚀').has('ship-it-')) {
    throw new Error('GitHub slugger fixture should match emoji heading behavior')
  }
  const rawHtmlAnchors = collectAnchors('<a id="custom-anchor"></a>\n<a name=\'legacy-anchor\'></a>')
  if (!rawHtmlAnchors.has('custom-anchor') || !rawHtmlAnchors.has('legacy-anchor')) {
    throw new Error('raw HTML anchor fixture should collect id and name anchors')
  }
  const rawHtmlLink = collectLinks('<a href="./target.md#custom-anchor">target</a>')
  if (!rawHtmlLink.links.some((link) => link.target === './target.md#custom-anchor')) {
    throw new Error('raw HTML link fixture should collect href destinations')
  }
  const rawHtmlEmptyHref = collectLinks('<a href="">empty</a>')
  if (!rawHtmlEmptyHref.links.some((link) => link.target === '')) {
    throw new Error('raw HTML empty href fixture should reach empty-target validation')
  }
  if (collectAnchors('`<a id="fake"></a>`').has('fake')) {
    throw new Error('raw HTML anchor fixture should ignore inline code spans')
  }
  const rawHtmlDataAttributes = collectLinks('<a data-href="./hidden.md" data-id="hidden-anchor">target</a>')
  if (rawHtmlDataAttributes.links.length > 0 || collectAnchors('<a data-id="hidden-anchor"></a>').has('hidden-anchor')) {
    throw new Error('raw HTML data-* attributes should not count as links or anchors')
  }
  const footnoteBodyLink = collectLinks('[^note]: See [visible](./visible.md)')
  if (!footnoteBodyLink.links.some((link) => link.target === './visible.md')) {
    throw new Error('footnote body fixture should validate visible links')
  }

  const quotedFence = collectLinks('> ```md\n> [hidden](./missing.md)\n> ```')
  if (quotedFence.links.length > 0 || quotedFence.unresolvedReferences.length > 0) {
    throw new Error('blockquote fenced-code fixture should not produce links')
  }
  const quotedProse = collectLinks('> [visible](./visible.md)')
  if (!quotedProse.links.some((link) => link.target === './visible.md') || quotedProse.unresolvedReferences.length > 0) {
    throw new Error('blockquote prose fixture should produce visible links')
  }
  if (!collectAnchors('> ## Visible').has('visible')) {
    throw new Error('blockquote heading fixture should produce visible anchors')
  }
  const quotedIndentedCode = collectLinks('>     [hidden](./missing.md)')
  if (quotedIndentedCode.links.length > 0 || quotedIndentedCode.unresolvedReferences.length > 0) {
    throw new Error('blockquote indented-code fixture should not produce links')
  }
  const indentedBlockquoteMarkerCode = collectLinks('    > [hidden](./missing.md)')
  if (indentedBlockquoteMarkerCode.links.length > 0 || indentedBlockquoteMarkerCode.unresolvedReferences.length > 0) {
    throw new Error('indented code starting with a blockquote marker should not produce links')
  }

  const nested = collectLinks('[![diagram](./inner.png)](./outer.md)')
  if (!nested.links.some((link) => link.target === './inner.png') || !nested.links.some((link) => link.target === './outer.md')) {
    throw new Error('nested image link fixture should include inner and outer destinations')
  }

  const bracketIndexing = collectLinks('Matrix M[i][j] and coordinates [1][2] are notation, not links.')
  if (bracketIndexing.unresolvedReferences.length > 0) {
    throw new Error('bracket-indexing fixture should not produce unresolved reference links')
  }

  const missingReference = collectLinks('[missing][reference]')
  if (!missingReference.unresolvedReferences.some((entry) => entry.reference === '[missing][reference]' && entry.lineNumber === 1)) {
    throw new Error('missing reference fixture should still report unresolved reference links')
  }
  const referenceLinks = collectLinks('[ref]: ./target.md\n[ref]\n[full][ref]')
  const referenceTargetCount = referenceLinks.links.filter((link) => link.target === './target.md').length
  if (referenceTargetCount !== 3) {
    throw new Error('reference fixture should count definition, shortcut, and full reference links exactly once')
  }
  const codeSpanSeparatedLink = collectLinks('[text]`code`(target.md)')
  if (codeSpanSeparatedLink.links.length > 0 || codeSpanSeparatedLink.unresolvedReferences.length > 0) {
    throw new Error('code-span stripping should preserve separators between adjacent Markdown tokens')
  }
  if (!isMarkdownPath('/repo/README.markdown') || isMarkdownPath('/repo/diagram.svg')) {
    throw new Error('Markdown target fixture should not treat asset fragments as heading anchors')
  }
}

assertCheckerFixtures()

const failures = []
const anchorCache = new Map()

const anchorsFor = (targetPath) => {
  let anchors = anchorCache.get(targetPath)
  if (!anchors) {
    anchors = collectAnchors(fs.readFileSync(targetPath, 'utf8'))
    anchorCache.set(targetPath, anchors)
  }
  return anchors
}

for (const file of files) {
  const filePath = path.resolve(repoRoot, file)

  if (!fs.existsSync(filePath)) {
    failures.push(`missing source file ${file}`)
    continue
  }

  let canonicalFilePath
  try {
    canonicalFilePath = fs.realpathSync(filePath)
  } catch {
    failures.push(`missing source file ${file}`)
    continue
  }

  const relativeFile = path.relative(canonicalRepoRoot, canonicalFilePath)
  if (escapesRepoRoot(relativeFile)) {
    failures.push(`source file escapes repository root ${file}`)
    continue
  }

  let sourceStat
  try {
    sourceStat = fs.statSync(canonicalFilePath)
  } catch {
    failures.push(`missing source file ${file}`)
    continue
  }

  if (!sourceStat.isFile()) {
    failures.push(`source path is not a file ${file}`)
    continue
  }

  const text = fs.readFileSync(canonicalFilePath, 'utf8')
  anchorCache.set(canonicalFilePath, collectAnchors(text))
  const { links, unresolvedReferences } = collectLinks(text)
  const formatLocation = (lineNumber) => `${file}:${lineNumber}`
  for (const { reference, lineNumber } of unresolvedReferences) {
    failures.push(`${formatLocation(lineNumber)}: unresolved reference link ${reference}`)
  }
  for (const { target: raw, lineNumber } of links) {
    const location = formatLocation(lineNumber)
    if (raw === '') {
      failures.push(`${location}: empty link target`)
      continue
    }

    const scheme = raw.match(/^([a-z][a-z0-9+.-]*):/i)?.[1]?.toLowerCase()
    if (scheme) {
      if (!['http', 'https', 'mailto', 'app'].includes(scheme)) {
        failures.push(`${location}: disallowed link scheme ${raw}`)
      }
      continue
    }

    const { targetRaw, anchorRaw } = splitLocalTarget(raw)
    let decodedTarget
    let decodedAnchor
    try {
      decodedTarget = targetRaw === '' ? '' : decodeURIComponent(targetRaw)
      decodedAnchor = anchorRaw === '' ? '' : decodeURIComponent(anchorRaw)
    } catch {
      failures.push(`${location}: invalid link target ${raw}`)
      continue
    }

    if (decodedTarget.startsWith('/')) {
      failures.push(`${location}: root-relative link targets are not supported ${raw}`)
      continue
    }

    const targetPath = path.normalize(
      decodedTarget === ''
        ? path.resolve(filePath)
        : path.resolve(path.dirname(filePath), decodedTarget),
    )
    let canonicalTargetPath
    try {
      canonicalTargetPath = fs.realpathSync(targetPath)
    } catch {
      failures.push(`${location}: missing link target ${raw}`)
      continue
    }

    const relativeTarget = path.relative(canonicalRepoRoot, canonicalTargetPath)
    if (escapesRepoRoot(relativeTarget)) {
      failures.push(`${location}: link target escapes repository root ${raw}`)
      continue
    }

    let targetStat
    try {
      targetStat = fs.statSync(canonicalTargetPath)
    } catch {
      failures.push(`${location}: missing link target ${raw}`)
      continue
    }

    if (!targetStat.isFile()) {
      failures.push(`${location}: link target is not a file ${raw}`)
      continue
    }

    if (!decodedAnchor) {
      continue
    }

    if (!isMarkdownPath(canonicalTargetPath)) {
      continue
    }

    if (!anchorsFor(canonicalTargetPath).has(decodedAnchor)) {
      failures.push(`${location}: missing anchor ${raw}`)
    }
  }
}

if (failures.length > 0) {
  console.error(failures.join('\n'))
  process.exit(1)
}

console.log(`docs link/anchor check passed for ${files.length} files`)
