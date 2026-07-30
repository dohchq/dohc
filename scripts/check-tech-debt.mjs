#!/usr/bin/env node
import { readdirSync, readFileSync, statSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, join, relative } from 'node:path'

const root = join(dirname(fileURLToPath(import.meta.url)), '..')
const term = (...parts) => parts.join('')
const escaped = (value) => value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
const phraseRegex = (...parts) => new RegExp(escaped(term(...parts)), 'gi')

const debtPatterns = [
  { label: term('TO', 'DO'), regex: new RegExp(`\\b${term('TO', 'DO')}\\b`, 'g') },
  { label: term('TB', 'D'), regex: new RegExp(`\\b${term('TB', 'D')}\\b`, 'g') },
  { label: term('temporary ', 'dual ', 'backend'), regex: phraseRegex('temporary ', 'dual ', 'backend') },
  { label: term('remove ', 'after ', 'migration'), regex: phraseRegex('remove ', 'after ', 'migration') },
  { label: term('legacy ', 'views ', 'TO', 'DO'), regex: phraseRegex('legacy ', 'views ', 'TO', 'DO') },
  { label: term('skip ', 'because ', 'migration'), regex: phraseRegex('skip ', 'because ', 'migration') },
  { label: term('dead ', 'code'), regex: phraseRegex('dead ', 'code') },
]

const allowlist = []

const skippedDirectories = new Set([
  '.git',
  '.gstack',
  '.turbo',
  '.next',
  '.output',
  '.vercel',
  'coverage',
  'dist',
  'node_modules',
  'playwright-report',
  'test-results',
])
const skippedFiles = new Set([
  'pnpm-lock.yaml',
  'package-lock.json',
  'yarn.lock',
])
const skippedPathPrefixes = [
  // These records preserve the active Rust rewrite's decisions and evidence.
  // They quote past findings verbatim, including resolved debt markers.
  'docs/superpowers/plans/rust-engine/',
  'docs/superpowers/plans/2026-07-16-dohc-rust-engine-rewrite.md',
]
const skippedExtensions = new Set([
  '.avif',
  '.bmp',
  '.gif',
  '.ico',
  '.jpeg',
  '.jpg',
  '.pdf',
  '.png',
  '.sqlite',
  '.webp',
  '.zip',
])

validateAllowlist()

const hits = []
for (const file of walk(root)) {
  const rel = normalize(relative(root, file))
  if (skippedFiles.has(rel)) continue
  if (skippedPathPrefixes.some((prefix) => rel.startsWith(prefix))) continue
  const body = readTextFile(file)
  if (body === null) continue
  const lines = body.split(/\r?\n/)
  for (const pattern of debtPatterns) {
    pattern.regex.lastIndex = 0
    for (let lineIndex = 0; lineIndex < lines.length; lineIndex += 1) {
      const line = lines[lineIndex]
      pattern.regex.lastIndex = 0
      if (!pattern.regex.test(line)) continue
      const hit = {
        file: rel,
        line: lineIndex + 1,
        pattern: pattern.label,
        text: line.trim(),
      }
      if (!isAllowed(hit, lines)) hits.push(hit)
    }
  }
}

if (hits.length > 0) {
  console.error('Tech debt check failed. Unallowed debt markers found:')
  for (const hit of hits) {
    console.error(`- ${hit.file}:${hit.line} [${hit.pattern}] ${hit.text}`)
  }
  process.exit(1)
}

console.log(`Tech debt check passed with ${allowlist.length} documented allowlist entries.`)

function* walk(dir) {
  for (const name of readdirSync(dir)) {
    if (skippedDirectories.has(name)) continue
    const full = join(dir, name)
    const stat = statSync(full)
    if (stat.isDirectory()) {
      yield* walk(full)
      continue
    }
    if (!stat.isFile()) continue
    if (skippedExtensions.has(extensionOf(name))) continue
    yield full
  }
}

function extensionOf(name) {
  const index = name.lastIndexOf('.')
  return index === -1 ? '' : name.slice(index).toLowerCase()
}

function normalize(path) {
  return path.replace(/\\/g, '/')
}

function readTextFile(file) {
  const body = readFileSync(file)
  if (body.includes(0)) return null
  return body.toString('utf8')
}

function isAllowed(hit, lines) {
  return allowlist.some((entry) => {
    if (entry.file !== hit.file) return false
    if (!entry.patterns.includes(hit.pattern)) return false
    if (entry.contains && !hit.text.includes(entry.contains)) {
      const context = lines.slice(Math.max(0, hit.line - 12), Math.min(lines.length, hit.line + 4))
      return context.some((line) => line.includes(entry.contains))
    }
    return true
  })
}

function validateAllowlist() {
  for (const entry of allowlist) {
    if (!entry.reason || !entry.deleteWhen) {
      throw new Error(`Allowlist entry for ${entry.file} is missing reason or deletion condition.`)
    }
    if (!Array.isArray(entry.patterns) || entry.patterns.length === 0) {
      throw new Error(`Allowlist entry for ${entry.file} has no patterns.`)
    }
  }
}
