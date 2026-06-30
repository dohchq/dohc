#!/usr/bin/env node

import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const canonicalRepoRoot = fs.realpathSync(repoRoot)
const manifestPath = path.resolve(
  repoRoot,
  'docs/superpowers/plans/2026-06-23-think-bigger-docs.manifest.json',
)

const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'))
const expectedThinkBiggerDocs = manifest.thinkBiggerDocs

if (!Array.isArray(expectedThinkBiggerDocs) || expectedThinkBiggerDocs.some((file) => typeof file !== 'string')) {
  console.error('Think Bigger docs manifest must contain a thinkBiggerDocs string array')
  process.exit(1)
}

const discoverThinkBiggerDocs = () => {
  const repoRelativePath = (...segments) => path.posix.join(...segments)
  const expectedDocSet = new Set(expectedThinkBiggerDocs)
  const expectedDocDirs = [...new Set(expectedThinkBiggerDocs.map((file) => path.posix.dirname(file)))]
  const expectedDocBasenames = expectedThinkBiggerDocs.map((file) => path.posix.basename(file))
  const safeReadDir = (dir) => {
    try {
      return fs.readdirSync(path.resolve(repoRoot, dir))
    } catch {
      return []
    }
  }

  const isThinkBiggerRelatedDoc = (file) => {
    if (expectedDocSet.has(file) || path.posix.basename(file).includes('think-bigger')) {
      return true
    }

    const raw = fs.readFileSync(path.resolve(repoRoot, file), 'utf8')
    return /think bigger/i.test(raw) || expectedDocBasenames.some((basename) => raw.includes(basename))
  }

  return expectedDocDirs
    .flatMap((dir) => safeReadDir(dir)
      .filter((name) => name.endsWith('.md'))
      .map((name) => repoRelativePath(dir, name)))
    .filter(isThinkBiggerRelatedDoc)
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

const visibleHeadingText = (heading) => heading
  .replace(/!\[([^\]\n]*)\]\([^)]*\)/g, '$1')
  .replace(/\[([^\]\n]+)\]\([^)]*\)/g, '$1')
  .replace(/\[([^\]\n]+)\]\[[^\]\n]*\]/g, '$1')
  .replace(/`([^`]*)`/g, '$1')
  .replace(/(^|[^\w])__([^_\n]+)__($|[^\w])/g, '$1$2$3')
  .replace(/(^|[^\w])_([^_\n]+)_($|[^\w])/g, '$1$2$3')
  .replace(/<[^>]+>/g, '')

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

const slug = (heading) => decodeHtmlEntities(visibleHeadingText(heading))
  .trim()
  .toLowerCase()
  .replace(/[!"#$%&'()*+,./:;<=>?@\[\\\]^`{|}~]/g, '')
  .replace(/\s/g, '-')

function* contentLines(markdown) {
  let inFence = false
  let fenceChar = null
  let fenceLength = 0

  for (const line of markdown.split(/\r?\n/)) {
    const fence = line.match(/^\s{0,3}(```+|~~~+)(.*)$/)

    if (fence && !inFence) {
      const marker = fence[1][0]
      const markerLength = fence[1].length
      inFence = true
      fenceChar = marker
      fenceLength = markerLength
      continue
    }

    if (fence && inFence) {
      const marker = fence[1][0]
      const markerLength = fence[1].length
      const trailing = fence[2]
      if (marker === fenceChar && markerLength >= fenceLength && trailing.trim() === '') {
        inFence = false
        fenceChar = null
        fenceLength = 0
      }
      continue
    }

    if (!inFence) {
      yield line
    }
  }
}

const collectAnchors = (markdown) => {
  const anchors = new Set()
  const seen = new Map()
  const addAnchor = (headingText) => {
    const base = slug(headingText.replace(/[ \t]+#+[ \t]*$/, ''))
    let count = seen.get(base) ?? 0
    let candidate = count === 0 ? base : `${base}-${count}`
    while (anchors.has(candidate)) {
      count += 1
      candidate = `${base}-${count}`
    }
    seen.set(base, count + 1)
    anchors.add(candidate)
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
  const lines = [...contentLines(markdown)]
  const referenceDefinitions = new Map()
  const normalizeLabel = (label) => label.trim().replace(/\s+/g, ' ').toLowerCase()
  const normalizeDestination = (destination) => (
    destination.startsWith('<') && destination.endsWith('>')
      ? destination.slice(1, -1)
      : destination
  )
  const stripCodeSpans = (line) => line.replace(/(`+)(?:(?!\1).)*\1/g, '')
  const linkPattern = /!?\[[^\]\n]*\]\((<[^>\n]*>|[^)\s]*)(?:\s+(?:"[^"]*"|'[^']*'|\([^)]*\)))?\)/g
  const referenceDefinitionPattern = /^\s{0,3}\[([^\]\n]+)\]:\s*(<[^>\n]+>|[^\s]+)/
  const referenceUsePattern = /!?\[([^\]\n]+)\]\[([^\]\n]*)\]/g
  const shortcutReferencePattern = /!?\[([^\]\n]+)\](?![\[(])/g
  const autolinkPattern = /<((?:https?:|mailto:|app:|\.{1,2}\/|\/|[A-Za-z0-9_.-]+\/)[^<>\s]*)>/g

  for (const line of lines) {
    const prose = stripCodeSpans(line)
    const definition = prose.match(referenceDefinitionPattern)
    if (definition) {
      const destination = normalizeDestination(definition[2])
      referenceDefinitions.set(normalizeLabel(definition[1]), destination)
      links.push(destination)
    }
  }

  for (const line of lines) {
    const prose = stripCodeSpans(line)
    for (const match of prose.matchAll(linkPattern)) {
      links.push(normalizeDestination(match[1]))
    }
    for (const match of prose.matchAll(referenceUsePattern)) {
      const label = normalizeLabel(match[2] === '' ? match[1] : match[2])
      const destination = referenceDefinitions.get(label)
      if (destination) {
        links.push(destination)
      }
    }
    for (const match of prose.matchAll(shortcutReferencePattern)) {
      const destination = referenceDefinitions.get(normalizeLabel(match[1]))
      if (destination) {
        links.push(destination)
      }
    }
    for (const match of prose.matchAll(autolinkPattern)) {
      if (/^<\/[A-Za-z][A-Za-z0-9-]*>$/.test(match[0])) {
        continue
      }
      links.push(match[1])
    }
  }

  return links
}

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
  for (const raw of collectLinks(text)) {
    if (/^(https?:|mailto:|app:)/.test(raw)) {
      continue
    }

    const hashIndex = raw.indexOf('#')
    const targetRaw = hashIndex === -1 ? raw : raw.slice(0, hashIndex)
    const anchorRaw = hashIndex === -1 ? '' : raw.slice(hashIndex + 1)
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
