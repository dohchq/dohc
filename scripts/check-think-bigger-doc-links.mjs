#!/usr/bin/env node

import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const canonicalRepoRoot = fs.realpathSync(repoRoot)

const expectedThinkBiggerDocs = [
  'docs/superpowers/plans/2026-06-23-think-bigger-dohc-workspace-engine.md',
  'docs/superpowers/plans/2026-06-23-think-bigger-dohc-workspace-engine.execution-log.md',
  'docs/superpowers/specs/2026-06-22-dohc-versioned-workspace-design.md',
  'docs/superpowers/specs/2026-06-23-dohc-chats-design.md',
  'docs/superpowers/specs/2026-06-23-dohc-native-filesystem-design.md',
]

const discoverThinkBiggerDocs = () => {
  const planDir = 'docs/superpowers/plans'
  const specDir = 'docs/superpowers/specs'
  const repoRelativePath = (...segments) => path.posix.join(...segments)
  const specNameFragments = [
    'dohc-versioned-workspace-design',
    'dohc-chats-design',
    'dohc-native-filesystem-design',
  ]
  const planDocs = fs.readdirSync(path.resolve(repoRoot, planDir))
    .filter((name) => name.includes('think-bigger-dohc-workspace-engine') && name.endsWith('.md'))
    .map((name) => repoRelativePath(planDir, name))
  const specDocs = fs.readdirSync(path.resolve(repoRoot, specDir))
    .filter((name) => name.endsWith('.md') && specNameFragments.some((fragment) => name.includes(fragment)))
    .map((name) => repoRelativePath(specDir, name))

  return [...planDocs, ...specDocs].sort()
}

const discoveredThinkBiggerDocs = discoverThinkBiggerDocs()
const missingExpectedDocs = expectedThinkBiggerDocs.filter((file) => !discoveredThinkBiggerDocs.includes(file))

if (missingExpectedDocs.length > 0) {
  console.error(`Think Bigger docs discovery missed expected files:\n${missingExpectedDocs.join('\n')}`)
  process.exit(1)
}

const files = discoveredThinkBiggerDocs

const visibleHeadingText = (heading) => heading
  .replace(/!\[([^\]\n]*)\]\([^)]*\)/g, '$1')
  .replace(/\[([^\]\n]+)\]\([^)]*\)/g, '$1')
  .replace(/\[([^\]\n]+)\]\[[^\]\n]*\]/g, '$1')
  .replace(/`([^`]*)`/g, '$1')
  .replace(/<[^>]+>/g, '')

const decodeHtmlEntities = (text) => text
  .replace(/&#(\d+);/g, (_, code) => String.fromCodePoint(Number(code)))
  .replace(/&#x([0-9a-f]+);/gi, (_, code) => String.fromCodePoint(Number.parseInt(code, 16)))
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

  for (const line of contentLines(markdown)) {
    const heading = line.match(/^\s{0,3}#{1,6}\s+(.*?)\s*$/)
    if (!heading) {
      continue
    }

    const base = slug(heading[1].replace(/[ \t]+#+[ \t]*$/, ''))
    let count = seen.get(base) ?? 0
    let candidate = count === 0 ? base : `${base}-${count}`
    while (anchors.has(candidate)) {
      count += 1
      candidate = `${base}-${count}`
    }
    seen.set(base, count + 1)
    anchors.add(candidate)
  }

  return anchors
}

const collectLinks = (markdown) => {
  const links = []
  const linkPattern = /!?\[[^\]\n]+\]\(([^)\s]+)(?:\s+"[^"]*")?\)/g

  for (const line of contentLines(markdown)) {
    const prose = line.replace(/(`+)(?:(?!\1).)*\1/g, '')
    for (const match of prose.matchAll(linkPattern)) {
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

    if (!anchorsFor(canonicalTargetPath).has(slug(decodedAnchor))) {
      failures.push(`${file}: missing anchor ${raw}`)
    }
  }
}

if (failures.length > 0) {
  console.error(failures.join('\n'))
  process.exit(1)
}

console.log(`docs link/anchor check passed for ${files.length} files`)
