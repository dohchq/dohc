#!/usr/bin/env node

import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import GithubSlugger from 'github-slugger'

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const canonicalRepoRoot = fs.realpathSync(repoRoot)
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

if (!Array.isArray(expectedThinkBiggerDocs) || expectedThinkBiggerDocs.some((file) => typeof file !== 'string')) {
  console.error('Think Bigger docs manifest must contain a thinkBiggerDocs string array')
  process.exit(1)
}

const discoverThinkBiggerDocs = () => {
  const repoRelativePath = (...segments) => path.posix.join(...segments)
  const expectedSpecDocs = new Set(expectedThinkBiggerDocs
    .filter((file) => file.startsWith('docs/superpowers/specs/')))
  const thinkBiggerCohortPattern =
    /^Cohort:\s*(?:Design specs and mega plan|Architecture specs and mega-plan|Architecture specifications and mega-plan|Think Bigger dohc Workspace Engine(?: Documentation and CI| docs and CI enforcement)?|dohc Workspace Engine documentation and CI infrastructure|dohc\s+Think Bigger Workspace Engine|dohc Workspace Engine Docs, Specs, and CI)$/im
  const hasThinkBiggerCohortMetadata = (dir, name) => {
    const candidatePath = path.resolve(repoRoot, dir, name)
    let canonicalCandidatePath
    try {
      canonicalCandidatePath = fs.realpathSync(candidatePath)
      const relativeCandidate = path.relative(canonicalRepoRoot, canonicalCandidatePath)
      if (relativeCandidate.startsWith('..') || path.isAbsolute(relativeCandidate)) {
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

  for (const rawLine of markdown.split(/\r?\n/)) {
    const rawVisibleLine = inFence ? rawLine : stripHtmlComments(rawLine)
    const line = inFence ? rawVisibleLine : rawVisibleLine.replace(/^(?:[ \t]*>[ \t]?)+/, '')
    const fenceLine = rawVisibleLine.replace(/^(?:[ \t]*>[ \t]?)+/, '')
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
      yield line
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

  for (const line of contentLines(markdown)) {
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
  const referenceDefinitions = new Map()
  const normalizeLabel = (label) => label.trim().replace(/\s+/g, ' ').toLowerCase()
  const isFootnoteLabel = (label) => label.trim().startsWith('^')
  const normalizeDestination = (destination) => (
    destination.startsWith('<') && destination.endsWith('>')
      ? destination.slice(1, -1)
      : destination
  )
  const stripCodeSpans = (line) => line.replace(/(`+)(?:(?!\1).)*\1/g, '')
  const nestedImageLinkPattern = /\[!\[[^\]\n]*\]\((<[^>\n]*>|(?:[^()\s]|\([^()\n]*\))*)(?:\s+(?:"[^"]*"|'[^']*'|\([^)]*\)))?\)\]\((<[^>\n]*>|(?:[^()\s]|\([^()\n]*\))*)(?:\s+(?:"[^"]*"|'[^']*'|\([^)]*\)))?\)/g
  const linkPattern = /!?\[[^\]\n]*\]\((<[^>\n]*>|(?:[^()\s]|\([^()\n]*\))*)(?:\s+(?:"[^"]*"|'[^']*'|\([^)]*\)))?\)/g
  const referenceDefinitionPattern = /^\s{0,3}\[([^\]\n]+)\]:\s*(<[^>\n]+>|[^\s]+)/
  const referenceUsePattern = /!?\[([^\]\n]+)\]\[([^\]\n]*)\]/g
  const shortcutReferencePattern = /!?\[([^\]\n]+)\](?![\[(])/g
  const autolinkPattern = /<((?:https?:|mailto:|app:)[^<>\s]*)>/g
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

  for (const line of lines) {
    const prose = stripCodeSpans(line)
    const definition = prose.match(referenceDefinitionPattern)
    if (definition) {
      if (isFootnoteLabel(definition[1])) {
        continue
      }
      const destination = normalizeDestination(definition[2])
      referenceDefinitions.set(normalizeLabel(definition[1]), destination)
      links.push(destination)
    }
  }

  for (const line of lines) {
    let prose = stripCodeSpans(line)
    for (const match of prose.matchAll(nestedImageLinkPattern)) {
      links.push(normalizeDestination(match[1]))
      links.push(normalizeDestination(match[2]))
    }
    prose = prose.replace(nestedImageLinkPattern, '')
    for (const match of prose.matchAll(linkPattern)) {
      links.push(normalizeDestination(match[1]))
    }
    for (const match of prose.matchAll(referenceUsePattern)) {
      const label = normalizeLabel(match[2] === '' ? match[1] : match[2])
      if (isFootnoteLabel(label)) {
        continue
      }
      const destination = referenceDefinitions.get(label)
      if (destination) {
        links.push(destination)
      } else if (looksLikeBracketIndexing(prose, match)) {
        continue
      } else {
        unresolvedReferences.push(match[0])
      }
    }
    for (const match of prose.matchAll(shortcutReferencePattern)) {
      if (isFootnoteLabel(match[1])) {
        continue
      }
      const destination = referenceDefinitions.get(normalizeLabel(match[1]))
      if (destination) {
        links.push(destination)
      }
    }
    for (const match of prose.matchAll(autolinkPattern)) {
      if (/^<\/?[A-Za-z][A-Za-z0-9-]*\s*\/?>$/.test(match[0])) {
        continue
      }
      links.push(match[1])
    }
  }

  return { links: [...new Set(links)], unresolvedReferences }
}

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
  if (!schemeAutolink.links.includes('app://workspace/thread')) {
    throw new Error('app autolink fixture should still collect supported URI schemes')
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

  const quotedFence = collectLinks('> ```md\n> [hidden](./missing.md)\n> ```')
  if (quotedFence.links.length > 0 || quotedFence.unresolvedReferences.length > 0) {
    throw new Error('blockquote fenced-code fixture should not produce links')
  }
  const quotedProse = collectLinks('> [visible](./visible.md)')
  if (!quotedProse.links.includes('./visible.md') || quotedProse.unresolvedReferences.length > 0) {
    throw new Error('blockquote prose fixture should produce visible links')
  }
  if (!collectAnchors('> ## Visible').has('visible')) {
    throw new Error('blockquote heading fixture should produce visible anchors')
  }
  const quotedIndentedCode = collectLinks('>     [hidden](./missing.md)')
  if (quotedIndentedCode.links.length > 0 || quotedIndentedCode.unresolvedReferences.length > 0) {
    throw new Error('blockquote indented-code fixture should not produce links')
  }

  const nested = collectLinks('[![diagram](./inner.png)](./outer.md)')
  if (!nested.links.includes('./inner.png') || !nested.links.includes('./outer.md')) {
    throw new Error('nested image link fixture should include inner and outer destinations')
  }

  const bracketIndexing = collectLinks('Matrix M[i][j] and coordinates [1][2] are notation, not links.')
  if (bracketIndexing.unresolvedReferences.length > 0) {
    throw new Error('bracket-indexing fixture should not produce unresolved reference links')
  }

  const missingReference = collectLinks('[missing][reference]')
  if (!missingReference.unresolvedReferences.includes('[missing][reference]')) {
    throw new Error('missing reference fixture should still report unresolved reference links')
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
  if (relativeFile.startsWith('..') || path.isAbsolute(relativeFile)) {
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
  for (const raw of unresolvedReferences) {
    failures.push(`${file}: unresolved reference link ${raw}`)
  }
  for (const raw of links) {
    if (raw === '') {
      failures.push(`${file}: empty link target`)
      continue
    }

    const scheme = raw.match(/^([a-z][a-z0-9+.-]*):/i)?.[1]?.toLowerCase()
    if (scheme) {
      if (!['http', 'https', 'mailto', 'app'].includes(scheme)) {
        failures.push(`${file}: disallowed link scheme ${raw}`)
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
      failures.push(`${file}: invalid link target ${raw}`)
      continue
    }

    const targetPath = path.normalize(
      decodedTarget === ''
        ? path.resolve(filePath)
        : decodedTarget.startsWith('/')
          ? path.resolve(repoRoot, decodedTarget.slice(1))
          : path.resolve(path.dirname(filePath), decodedTarget),
    )
    let canonicalTargetPath
    try {
      canonicalTargetPath = fs.realpathSync(targetPath)
    } catch {
      failures.push(`${file}: missing link target ${raw}`)
      continue
    }

    const relativeTarget = path.relative(canonicalRepoRoot, canonicalTargetPath)
    if (relativeTarget.startsWith('..') || path.isAbsolute(relativeTarget)) {
      failures.push(`${file}: link target escapes repository root ${raw}`)
      continue
    }

    let targetStat
    try {
      targetStat = fs.statSync(canonicalTargetPath)
    } catch {
      failures.push(`${file}: missing link target ${raw}`)
      continue
    }

    if (!targetStat.isFile()) {
      failures.push(`${file}: link target is not a file ${raw}`)
      continue
    }

    if (!decodedAnchor) {
      continue
    }

    if (!anchorsFor(canonicalTargetPath).has(decodedAnchor)) {
      failures.push(`${file}: missing anchor ${raw}`)
    }
  }
}

if (failures.length > 0) {
  console.error(failures.join('\n'))
  process.exit(1)
}

console.log(`docs link/anchor check passed for ${files.length} files`)
