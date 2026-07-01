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
  || expectedThinkBiggerDocs.length === 0
  || expectedThinkBiggerDocs.some((file) => typeof file !== 'string')
  || new Set(expectedThinkBiggerDocs).size !== expectedThinkBiggerDocs.length
) {
  console.error('Think Bigger docs manifest must contain a non-empty unique thinkBiggerDocs string array')
  process.exit(1)
}

const thinkBiggerSpecMarkerPattern = /^Think Bigger Spec:\s*true\s*$/im
const thinkBiggerMetadataHeader = (raw) => {
  const lines = raw.split(/\r?\n/)
  const openingFence = lines[0]?.trim()
  if (openingFence === '---' || openingFence === '+++') {
    const endIndex = lines.findIndex((line, index) => index > 0 && line.trim() === openingFence)
    if (endIndex !== -1) {
      return lines.slice(0, endIndex + 1).join('\n')
    }
  }

  const nextSectionIndex = lines.findIndex((line, index) => index > 0 && /^#{2,6}\s+/.test(line))
  return lines.slice(0, nextSectionIndex === -1 ? lines.length : nextSectionIndex).join('\n')
}

const discoverThinkBiggerDocs = () => {
  const repoRelativePath = (...segments) => path.posix.join(...segments)
  const hasThinkBiggerSpecMarker = (dir, name) => {
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
    return thinkBiggerSpecMarkerPattern.test(thinkBiggerMetadataHeader(raw))
  }
  const discoveryRoots = [
    {
      dir: 'docs/superpowers/plans',
      include: (name) => /^\d{4}-\d{2}-\d{2}-think-bigger-.*\.md$/.test(name),
    },
    {
      dir: 'docs/superpowers/specs',
      include: (name) => hasThinkBiggerSpecMarker('docs/superpowers/specs', name),
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

const rawHtmlTagPattern = /<\/?[A-Za-z][A-Za-z0-9:-]*(?:\s[^<>]*)?\s*\/?>/g

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
    .replace(rawHtmlTagPattern, '')
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

const rawHtmlStartTagPattern = /<[A-Za-z][A-Za-z0-9:-]*(?:\s[^<>]*)?>/g
const rawHtmlAnchorTagPattern = /<a\b[^>]*>/gi
const htmlAttributeValue = (tag, attrName) => {
  const attributePattern = new RegExp(`(?:^|\\s)${attrName}\\s*=\\s*(?:"([^"]*)"|'([^']*)'|([^\\s"'>=]+))`, 'i')
  const match = tag.match(attributePattern)
  const value = match?.[1] ?? match?.[2] ?? match?.[3]
  return value === undefined ? null : decodeHtmlEntities(value)
}

const indentationWidth = (line) => line.match(/^[ \t]*/)[0].replace(/\t/g, '    ').length
const markerWidth = (text) => text.replace(/\t/g, '    ').length

const inlineCodeRanges = (line) => {
  const ranges = []
  let index = 0
  while (index < line.length) {
    if (line[index] !== '`') {
      index += 1
      continue
    }
    let tickEnd = index + 1
    while (tickEnd < line.length && line[tickEnd] === '`') {
      tickEnd += 1
    }
    const marker = '`'.repeat(tickEnd - index)
    const close = line.indexOf(marker, tickEnd)
    if (close === -1) {
      index = tickEnd
      continue
    }
    ranges.push([index, close + marker.length])
    index = close + marker.length
  }
  return ranges
}

const isInsideRange = (index, ranges) => ranges.some(([start, end]) => index >= start && index < end)

const indexOutsideInlineCode = (line, needle, fromIndex, ranges) => {
  let index = line.indexOf(needle, fromIndex)
  while (index !== -1 && isInsideRange(index, ranges)) {
    index = line.indexOf(needle, index + 1)
  }
  return index
}

function* contentLines(markdown) {
  let inFence = false
  let fenceChar = null
  let fenceLength = 0
  let fenceOpenedInBlockquote = false
  let inIndentedCode = false
  let activeListIndent = null
  let inHtmlComment = false

  const stripHtmlComments = (line) => {
    const codeRanges = inlineCodeRanges(line)
    let rest = line
    let visible = ''
    let offset = 0
    while (rest.length > 0) {
      if (inHtmlComment) {
        const end = rest.indexOf('-->')
        if (end === -1) {
          return visible
        }
        rest = rest.slice(end + 3)
        offset += end + 3
        inHtmlComment = false
        continue
      }

      const start = indexOutsideInlineCode(line, '<!--', offset, codeRanges)
      if (start === -1) {
        return visible + rest
      }

      visible += line.slice(offset, start)
      offset = start + 4
      rest = line.slice(offset)
      const end = rest.indexOf('-->')
      if (end === -1) {
        inHtmlComment = true
        return visible
      }
      rest = rest.slice(end + 3)
      offset += end + 3
    }
    return visible
  }

  const stripBlockquoteMarkers = (value) => value.replace(/^(?: {0,3}>[ \t]?)+/, '')
  const lines = markdown.split(/\r?\n/)
  const frontMatterFence = lines[0]?.trim()
  const frontMatterEndIndex = frontMatterFence === '---' || frontMatterFence === '+++'
    ? lines.findIndex((line, index) => index > 0 && line.trim() === frontMatterFence)
    : -1

  let lineIndex = 0
  for (const rawLine of lines) {
    lineIndex += 1
    if (frontMatterEndIndex !== -1 && lineIndex <= frontMatterEndIndex + 1) {
      continue
    }
    const rawLineForBlockDetection = inFence ? rawLine : stripBlockquoteMarkers(rawLine)
    const rawListItemForBlockDetection = rawLineForBlockDetection.match(/^([ \t]*)(?:[-+*]|\d+[.)])([ \t]+)/)
    const rawLeadingIndentForBlockDetection = indentationWidth(rawLineForBlockDetection)
    const rawListItemAllowedForBlockDetection = rawListItemForBlockDetection && (
      rawLeadingIndentForBlockDetection <= 3
      || (
        activeListIndent !== null
        && rawLeadingIndentForBlockDetection >= activeListIndent
        && rawLeadingIndentForBlockDetection <= activeListIndent + 3
      )
    )
    const rawIndentedListItemForBlockDetection = Boolean(rawListItemAllowedForBlockDetection)
    const rawListCodeBlockForBlockDetection = activeListIndent !== null
      && rawLineForBlockDetection.trim() !== ''
      && rawLeadingIndentForBlockDetection >= activeListIndent + 4
      && !rawIndentedListItemForBlockDetection
    const rawListContinuationForBlockDetection = activeListIndent !== null
      && rawLineForBlockDetection.trim() !== ''
      && rawLeadingIndentForBlockDetection >= activeListIndent
      && !rawListCodeBlockForBlockDetection
    const rawIndentedCodeForBlockDetection = (
      /^(?: {4}|\t)/.test(rawLineForBlockDetection)
      && !rawIndentedListItemForBlockDetection
      && !rawListContinuationForBlockDetection
    ) || rawListCodeBlockForBlockDetection
    const rawVisibleLine = inFence || (!inHtmlComment && rawIndentedCodeForBlockDetection)
      ? rawLine
      : stripHtmlComments(rawLine)
    const line = inFence ? rawVisibleLine : stripBlockquoteMarkers(rawVisibleLine)
    const fenceLine = inFence && !fenceOpenedInBlockquote
      ? rawVisibleLine
      : stripBlockquoteMarkers(rawVisibleLine)
    const rawFence = fenceLine.match(/^([ \t]*)(```+|~~~+)(.*)$/)
    const rawListItem = line.match(/^([ \t]*)(?:[-+*]|\d+[.)])([ \t]+)/)
    const leadingIndent = indentationWidth(line)
    const listItemAllowed = rawListItem && (
      leadingIndent <= 3
      || (
        activeListIndent !== null
        && leadingIndent >= activeListIndent
        && leadingIndent <= activeListIndent + 3
      )
    )
    const listItem = listItemAllowed ? rawListItem : null
    const indentedListItem = Boolean(listItem)
    const sameLineListFence = !inFence && listItem
      ? line.slice(listItem[0].length).match(/^(```+|~~~+)(.*)$/)
      : null
    const fenceMatch = rawFence ?? (
      sameLineListFence
        ? [sameLineListFence[0], line.slice(0, listItem[0].length), sameLineListFence[1], sameLineListFence[2]]
        : null
    )
    const listContentIndent = listItem ? markerWidth(listItem[0]) : null
    const fenceIndent = fenceMatch ? indentationWidth(fenceMatch[1]) : null
    const fence = fenceMatch && (
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
      const marker = fenceMatch[2][0]
      const markerLength = fenceMatch[2].length
      inFence = true
      fenceChar = marker
      fenceLength = markerLength
      fenceOpenedInBlockquote = /^(?: {0,3}>[ \t]?)+/.test(rawVisibleLine)
      if (sameLineListFence && listContentIndent !== null) {
        activeListIndent = listContentIndent
      }
      continue
    }

    if (fence && inFence) {
      const marker = fenceMatch[2][0]
      const markerLength = fenceMatch[2].length
      const trailing = fenceMatch[3]
      if (marker === fenceChar && markerLength >= fenceLength && trailing.trim() === '') {
        inFence = false
        fenceChar = null
        fenceLength = 0
        fenceOpenedInBlockquote = false
      }
      continue
    }

    if (!inFence && indentedCode) {
      inIndentedCode = true
      if (!listCodeBlock) {
        activeListIndent = null
      }
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
  const stripBackslashEscapes = (line) => line.replace(/\\[\\`*{}\[\]#+\-.!_>~|<]/g, (match) => ' '.repeat(match.length))

  for (const { text: line } of contentLines(markdown)) {
    const prose = stripBackslashEscapes(stripCodeSpans(line))
    for (const match of prose.matchAll(rawHtmlStartTagPattern)) {
      const tag = match[0]
      const idAnchor = htmlAttributeValue(tag, 'id')
      if (idAnchor) {
        anchors.add(idAnchor)
      }
      if (/^<a\b/i.test(tag)) {
        const nameAnchor = htmlAttributeValue(tag, 'name')
        if (nameAnchor) {
          anchors.add(nameAnchor)
        }
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
  const unescapeMarkdownDestination = (destination) => (
    destination.replace(/\\([\\`*{}\[\]()#+\-.!_>~|<])/g, '$1')
  )
  const normalizeDestination = (destination) => {
    const unwrapped = destination.startsWith('<') && destination.endsWith('>')
      ? destination.slice(1, -1)
      : destination
    return unescapeMarkdownDestination(unwrapped)
  }
  const stripCodeSpans = (line) => line.replace(/(`+)(?:(?!\1).)*\1/g, ' ')
  const stripBackslashEscapes = (line) => line.replace(/\\[\\`*{}\[\]#+\-.!_>~|<]/g, (match) => ' '.repeat(match.length))
  const referenceDefinitionPattern = /^\s{0,3}\[([^\]\n]+)\]:\s*(<[^>\n]*>|[^\s]+)/
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
  const matchingLabelEnd = (value, openBracketIndex) => {
    let depth = 0
    for (let index = openBracketIndex + 1; index < value.length; index += 1) {
      const char = value[index]
      if (char === '\n') {
        return -1
      }
      if (char === '[') {
        depth += 1
      } else if (char === ']') {
        if (depth === 0) {
          return index
        }
        depth -= 1
      }
    }
    return -1
  }
  const parseInlineLinkAt = (value, start) => {
    const isImage = value[start] === '!' && value[start + 1] === '['
    if (value[start - 1] === '\\') {
      return null
    }
    if (!isImage && value[start] !== '[') {
      return null
    }
    if (!isImage && value[start - 1] === '!') {
      return null
    }

    const openBracketIndex = isImage ? start + 1 : start
    const closeBracketIndex = matchingLabelEnd(value, openBracketIndex)
    if (closeBracketIndex === -1 || value[closeBracketIndex + 1] !== '(') {
      return null
    }

    let cursor = closeBracketIndex + 2
    let destination
    if (value[cursor] === '<') {
      const closeDestinationIndex = value.indexOf('>', cursor + 1)
      if (closeDestinationIndex === -1 || value.slice(cursor, closeDestinationIndex).includes('\n')) {
        return null
      }
      destination = value.slice(cursor, closeDestinationIndex + 1)
      cursor = closeDestinationIndex + 1
    } else {
      const destinationStart = cursor
      let parenDepth = 0
      while (cursor < value.length) {
        const char = value[cursor]
        if (char === '\n') {
          return null
        }
        if (char === '\\' && cursor + 1 < value.length) {
          cursor += 2
          continue
        }
        if (char === '(') {
          parenDepth += 1
        } else if (char === ')') {
          if (parenDepth === 0) {
            break
          }
          parenDepth -= 1
        } else if (/\s/.test(char) && parenDepth === 0) {
          break
        }
        cursor += 1
      }
      destination = value.slice(destinationStart, cursor)
    }

    let quote = null
    let titleParenDepth = 0
    for (; cursor < value.length; cursor += 1) {
      const char = value[cursor]
      if (char === '\n') {
        return null
      }
      if (quote !== null) {
        if (char === quote) {
          quote = null
        }
      } else if (char === '"' || char === "'") {
        quote = char
      } else if (char === '(') {
        titleParenDepth += 1
      } else if (char === ')') {
        if (titleParenDepth === 0) {
          return {
            target: normalizeDestination(destination),
            start,
            end: cursor + 1,
            labelStart: openBracketIndex + 1,
            labelEnd: closeBracketIndex,
          }
        }
        titleParenDepth -= 1
      }
    }
    return null
  }
  const extractInlineLinks = (value) => {
    const inlineLinks = []
    const visitRange = (start, end) => {
      for (let index = start; index < end; index += 1) {
        const parsed = parseInlineLinkAt(value, index)
        if (parsed && parsed.end <= end) {
          inlineLinks.push(parsed)
          visitRange(parsed.labelStart, parsed.labelEnd)
          index = parsed.end - 1
        }
      }
    }
    visitRange(0, value.length)
    return inlineLinks
  }
  const eraseRanges = (value, ranges) => {
    const sortedRanges = [...ranges].sort((left, right) => left.start - right.start || right.end - left.end)
    let cursor = 0
    let result = ''
    for (const range of sortedRanges) {
      if (range.end <= cursor) {
        continue
      }
      const start = Math.max(range.start, cursor)
      result += value.slice(cursor, start)
      result += ' '.repeat(range.end - start)
      cursor = range.end
    }
    return result + value.slice(cursor)
  }

  for (const { text: line, lineNumber } of lines) {
    const prose = stripCodeSpans(line)
    const definition = prose.match(referenceDefinitionPattern)
    if (definition) {
      if (isFootnoteLabel(definition[1])) {
        continue
      }
      const destination = normalizeDestination(definition[2])
      const label = normalizeLabel(definition[1])
      if (!referenceDefinitions.has(label)) {
        referenceDefinitions.set(label, destination)
        addLink(destination, lineNumber)
      }
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
    const rawHtmlAnchorRanges = []
    for (const match of prose.matchAll(rawHtmlAnchorTagPattern)) {
      if (match.index > 0 && prose[match.index - 1] === '\\') {
        continue
      }
      const href = htmlAttributeValue(match[0], 'href')
      if (href !== null) {
        addLink(href, lineNumber)
      }
      rawHtmlAnchorRanges.push({ start: match.index, end: match.index + match[0].length })
    }
    prose = eraseRanges(prose, rawHtmlAnchorRanges)
    const inlineLinks = extractInlineLinks(prose)
    for (const link of inlineLinks) {
      addLink(link.target, lineNumber)
    }
    prose = eraseRanges(prose, inlineLinks)
    let referenceProse = stripBackslashEscapes(prose)
    for (const match of referenceProse.matchAll(referenceUsePattern)) {
      const label = normalizeLabel(match[2] === '' ? match[1] : match[2])
      if (isFootnoteLabel(label)) {
        continue
      }
      if (referenceDefinitions.has(label)) {
        const destination = referenceDefinitions.get(label)
        addLink(destination, lineNumber)
      } else if (looksLikeBracketIndexing(referenceProse, match)) {
        continue
      } else {
        unresolvedReferences.push({ reference: match[0], lineNumber })
      }
    }
    referenceProse = referenceProse.replace(referenceUsePattern, '')
    for (const match of referenceProse.matchAll(shortcutReferencePattern)) {
      if (isFootnoteLabel(match[1])) {
        continue
      }
      const label = normalizeLabel(match[1])
      if (referenceDefinitions.has(label)) {
        const destination = referenceDefinitions.get(label)
        addLink(destination, lineNumber)
      }
    }
    for (const match of prose.matchAll(autolinkPattern)) {
      if (match.index > 0 && prose[match.index - 1] === '\\') {
        continue
      }
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
  const longMetadataHeader = [
    '# Spec',
    '',
    'Status: exploratory',
    'Cohort: dohc Think Bigger Workspace Engine',
    ...Array.from({ length: 16 }, (_, index) => `Extra-${index}: value`),
    'Think Bigger Spec: true',
    'Date: 2026-06-23',
    '',
    '## Body',
    'Think Bigger Spec: false',
  ].join('\n')
  if (!thinkBiggerSpecMarkerPattern.test(thinkBiggerMetadataHeader(longMetadataHeader))) {
    throw new Error('long metadata header fixture should preserve Think Bigger spec markers before body headings')
  }

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
  const inlineCodeCommentDelimiter = collectLinks('`<!--` [visible](./visible.md) `-->`')
  if (!inlineCodeCommentDelimiter.links.some((link) => link.target === './visible.md')) {
    throw new Error('inline-code HTML comment delimiters should not hide visible links')
  }
  const realCommentAfterInlineCode = collectLinks('`<!--` <!-- [hidden](./missing.md) --> [visible](./visible.md)')
  if (
    realCommentAfterInlineCode.links.some((link) => link.target === './missing.md')
    || !realCommentAfterInlineCode.links.some((link) => link.target === './visible.md')
  ) {
    throw new Error('real HTML comments after inline code should still be stripped')
  }
  const frontMatterLinks = collectLinks('---\nsee: [hidden](./missing.md)\n---\n[visible](./visible.md)')
  if (
    frontMatterLinks.links.some((link) => link.target === './missing.md')
    || !frontMatterLinks.links.some((link) => link.target === './visible.md')
  ) {
    throw new Error('front matter fixture should not produce body links')
  }
  if (collectAnchors('<!-- # Hidden -->').has('hidden')) {
    throw new Error('HTML comment fixture should not produce anchors')
  }
  if (collectAnchors('---\nHidden\n---\n# Visible').has('hidden')) {
    throw new Error('front matter fixture should not produce setext anchors')
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
  const literalAngleHeadingAnchor = new GithubSlugger().slug('A < B > C')
  if (!collectAnchors('## A < B > C').has(literalAngleHeadingAnchor)) {
    throw new Error('literal angle heading fixture should preserve non-tag comparison text')
  }
  if (!collectAnchors('## A <span>Thing</span>').has('a-thing')) {
    throw new Error('raw HTML tag heading fixture should strip tag markup')
  }
  const rawHtmlAnchors = collectAnchors('<a id="custom-anchor"></a>\n<a name=\'legacy-anchor\'></a>\n<section id="section-anchor"></section>')
  if (
    !rawHtmlAnchors.has('custom-anchor')
    || !rawHtmlAnchors.has('legacy-anchor')
    || !rawHtmlAnchors.has('section-anchor')
  ) {
    throw new Error('raw HTML anchor fixture should collect id and name anchors')
  }
  if (collectAnchors('\\<a id="escaped-anchor"></a>').has('escaped-anchor')) {
    throw new Error('escaped raw HTML anchor fixture should not collect anchors')
  }
  const rawHtmlLink = collectLinks('<a href="./target.md#custom-anchor">target</a>')
  if (!rawHtmlLink.links.some((link) => link.target === './target.md#custom-anchor')) {
    throw new Error('raw HTML link fixture should collect href destinations')
  }
  const escapedRawHtmlLink = collectLinks('\\<a href="./missing.md">target</a>')
  if (escapedRawHtmlLink.links.length > 0) {
    throw new Error('escaped raw HTML link fixture should not collect href destinations')
  }
  const rawHtmlEmptyHref = collectLinks('<a href="">empty</a>')
  if (!rawHtmlEmptyHref.links.some((link) => link.target === '')) {
    throw new Error('raw HTML empty href fixture should reach empty-target validation')
  }
  const markdownEmptyHref = collectLinks('[empty]()')
  if (!markdownEmptyHref.links.some((link) => link.target === '')) {
    throw new Error('empty Markdown link fixture should reach empty-target validation')
  }
  const escapedDestination = collectLinks('[visible](./file\\).md)')
  if (!escapedDestination.links.some((link) => link.target === './file).md')) {
    throw new Error('escaped Markdown destination fixture should preserve escaped punctuation')
  }
  const escapedPunctuationDestination = collectLinks('[visible](./file\\_v1\\.md)')
  if (!escapedPunctuationDestination.links.some((link) => link.target === './file_v1.md')) {
    throw new Error('escaped Markdown destination fixture should preserve escaped underscores and dots')
  }
  const escapedReferenceDestination = collectLinks('[ref]: ./file\\).md\n[ref]')
  if (!escapedReferenceDestination.links.some((link) => link.target === './file).md')) {
    throw new Error('escaped reference destination fixture should preserve escaped punctuation')
  }
  const escapedPunctuationReferenceDestination = collectLinks('[ref]: ./file\\_v1\\.md\n[ref]')
  if (!escapedPunctuationReferenceDestination.links.some((link) => link.target === './file_v1.md')) {
    throw new Error('escaped reference destination fixture should preserve escaped underscores and dots')
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
  const sameLineListFence = collectLinks('- ```md\n  [hidden](./missing.md)\n  ```\n[visible](./visible.md)')
  if (
    sameLineListFence.links.some((link) => link.target === './missing.md')
    || sameLineListFence.unresolvedReferences.length > 0
    || !sameLineListFence.links.some((link) => link.target === './visible.md')
  ) {
    throw new Error('same-line list fenced-code fixture should hide code links and keep later prose links')
  }
  const normalFenceWithLiteralBlockquoteFence = collectLinks('```\n> ```\n[hidden](./missing.md)\n```')
  if (
    normalFenceWithLiteralBlockquoteFence.links.length > 0
    || normalFenceWithLiteralBlockquoteFence.unresolvedReferences.length > 0
  ) {
    throw new Error('regular fenced-code fixture should treat literal blockquote fences as code')
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
  const indentedListItemCode = collectLinks('    - [hidden](./missing.md)')
  if (indentedListItemCode.links.length > 0 || indentedListItemCode.unresolvedReferences.length > 0) {
    throw new Error('indented code starting with a list marker should not produce links')
  }
  const indentedCodeUnclosedHtmlComment = collectLinks('    <!--\n[visible](./visible.md)')
  if (!indentedCodeUnclosedHtmlComment.links.some((link) => link.target === './visible.md')) {
    throw new Error('indented code HTML comment fixture should not hide later prose links')
  }
  const listContinuationAfterCode = collectLinks('- item\n      code block\n    [visible](./visible.md)')
  if (!listContinuationAfterCode.links.some((link) => link.target === './visible.md')) {
    throw new Error('list continuation after an indented list code block should produce links')
  }

  const nested = collectLinks('[![diagram](./inner.png)](./outer.md)')
  if (!nested.links.some((link) => link.target === './inner.png') || !nested.links.some((link) => link.target === './outer.md')) {
    throw new Error('nested image link fixture should include inner and outer destinations')
  }
  const nestedBracketLabel = collectLinks('[See [details]](./details.md)')
  if (!nestedBracketLabel.links.some((link) => link.target === './details.md')) {
    throw new Error('nested bracket link label fixture should include the destination')
  }
  const linkLikeTitle = collectLinks('[visible](./visible.md "[hidden](./missing.md)")')
  if (
    !linkLikeTitle.links.some((link) => link.target === './visible.md')
    || linkLikeTitle.links.some((link) => link.target === './missing.md')
  ) {
    throw new Error('inline link title fixture should not parse title text as a link')
  }

  const bracketIndexing = collectLinks('Matrix M[i][j] and coordinates [1][2] are notation, not links.')
  if (bracketIndexing.unresolvedReferences.length > 0) {
    throw new Error('bracket-indexing fixture should not produce unresolved reference links')
  }

  const missingReference = collectLinks('[missing][reference]')
  if (!missingReference.unresolvedReferences.some((entry) => entry.reference === '[missing][reference]' && entry.lineNumber === 1)) {
    throw new Error('missing reference fixture should still report unresolved reference links')
  }
  const escapedMarkdownLink = collectLinks('\\[hidden](./missing.md)\n[visible](./visible.md)')
  if (
    escapedMarkdownLink.links.some((link) => link.target === './missing.md')
    || !escapedMarkdownLink.links.some((link) => link.target === './visible.md')
  ) {
    throw new Error('escaped Markdown link fixture should ignore escaped links only')
  }
  const escapedAutolink = collectLinks('\\<https://example.com>\n<app://workspace/thread>')
  if (
    escapedAutolink.links.some((link) => link.target === 'https://example.com')
    || !escapedAutolink.links.some((link) => link.target === 'app://workspace/thread')
  ) {
    throw new Error('escaped autolink fixture should ignore escaped autolinks only')
  }
  const referenceLinks = collectLinks('[ref]: ./target.md\n[ref]\n[full][ref]')
  const referenceTargetCount = referenceLinks.links.filter((link) => link.target === './target.md').length
  if (referenceTargetCount !== 3) {
    throw new Error('reference fixture should count definition, shortcut, and full reference links exactly once')
  }
  const duplicateReferenceLinks = collectLinks('[dup]: ./first.md\n[dup]: ./second.md\n[dup]')
  const duplicateFirstTargetCount = duplicateReferenceLinks.links.filter((link) => link.target === './first.md').length
  const duplicateSecondTargetCount = duplicateReferenceLinks.links.filter((link) => link.target === './second.md').length
  if (duplicateFirstTargetCount !== 2 || duplicateSecondTargetCount !== 0) {
    throw new Error('duplicate reference definitions should preserve the first target and ignore later duplicates')
  }
  const emptyReferenceTarget = collectLinks('[empty]: <>\n[empty]\n[full][empty]')
  const emptyReferenceTargetCount = emptyReferenceTarget.links.filter((link) => link.target === '').length
  if (emptyReferenceTargetCount !== 3 || emptyReferenceTarget.unresolvedReferences.length > 0) {
    throw new Error('empty reference definition targets should be collected as empty links')
  }
  const inlineTitleReferenceText = collectLinks('[text](./target.md "[missing][ref]")')
  if (
    !inlineTitleReferenceText.links.some((link) => link.target === './target.md')
    || inlineTitleReferenceText.unresolvedReferences.length > 0
  ) {
    throw new Error('inline link titles should not produce reference-style links')
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
