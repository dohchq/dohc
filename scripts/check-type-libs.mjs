#!/usr/bin/env node
// Every typecheck program must get its libs from its tsconfig. A declaration
// file in node_modules can add one with `/// <reference lib>`, and when pnpm
// resolves that file through its hoist, which version answers depends on how
// the install happened. GitHub's fresh install then checks different built-ins
// from an incremental one (#3666). @types/node's libs are allowed: every
// install has the same @types/node.
import { execFile } from 'node:child_process'
import { existsSync, readdirSync, readFileSync } from 'node:fs'
import { availableParallelism } from 'node:os'
import { join, relative } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = join(fileURLToPath(new URL('.', import.meta.url)), '..')

function workspacePackages() {
  const config = readFileSync(join(root, 'pnpm-workspace.yaml'), 'utf8')
  const globs = [...config.split(/^packages:\n/m)[1].matchAll(/^ {2}- "([^"]+)"/gm)].map(match => match[1])
  return globs.flatMap(glob => glob.endsWith('/*')
    ? readdirSync(join(root, glob.slice(0, -2)), { withFileTypes: true })
      .filter(entry => entry.isDirectory()).map(entry => join(root, glob.slice(0, -2), entry.name))
    : [join(root, glob)])
    .filter(dir => existsSync(join(dir, 'package.json')))
}

function programs() {
  return workspacePackages().flatMap(dir => {
    const script = JSON.parse(readFileSync(join(dir, 'package.json'), 'utf8')).scripts?.typecheck ?? ''
    return [...script.matchAll(/(?:^|&&)\s*tsc\b([^&]*)/g)].map(([, args]) =>
      ({ dir, config: args.match(/(?:-p|--project)\s+(\S+)/)?.[1] ?? 'tsconfig.json' }))
  })
}

function listFiles({ dir, config }) {
  const tsc = join(dir, 'node_modules', 'typescript', 'bin', 'tsc')
  // No incremental cache: listing files must not leave a cache the typecheck trusts.
  const args = [tsc, '-p', config, '--noEmit', '--incremental', 'false', '--listFilesOnly', '--explainFiles']
  return new Promise((resolve, reject) => execFile(process.execPath, args, { cwd: dir, maxBuffer: 1 << 30 },
    (error, stdout, stderr) => error
      ? reject(new Error(`${stdout.split(/\r?\n/).filter(line => / error TS\d+:/.test(line)).join('\n')}${stderr}${error.message}`))
      : resolve(stdout)))
}

// tsc prints each file, then its reasons indented beneath it.
function check(output) {
  const reasons = new Map()
  let file
  for (const line of output.split(/\r?\n/)) {
    if (line && !/^\s/.test(line)) reasons.set(file = line, [])
    else if (line.trim() && file) reasons.get(file).push(line.trim())
  }
  const libs = new Map([...reasons].filter(([, why]) => why.some(reason => /^(Default )?[Ll]ibrary\b/.test(reason))))
  const allowed = new Set([...libs].filter(([, why]) =>
    why.some(reason => /^Library '[^']+' specified in compilerOptions$|^Default library\b/.test(reason))).map(([lib]) => lib))
  if (allowed.size === 0) throw new Error(`tsc's output names no lib from compilerOptions:\n${output.slice(0, 2000)}`)
  const from = reason => reason.match(/^Library referenced via '[^']+' from file '([^']+)'$/)?.[1]
  const allows = source => allowed.has(source) || !source.includes('/node_modules/') || source.includes('/@types/node/')
  for (let grew = true; grew;) {
    grew = false
    for (const [lib, why] of libs) {
      if (!allowed.has(lib) && why.map(from).some(source => source && allows(source))) {
        allowed.add(lib)
        grew = true
      }
    }
  }
  return [...libs.keys()].filter(lib => !allowed.has(lib)).flatMap(lib => libs.get(lib)
    .filter(reason => from(reason) && !libs.has(from(reason)))
    .map(reason => `${reason.replace(/^Library referenced via /, '').replace(/ from file /, ' from ')}`))
}

const queue = programs()
const failures = []
await Promise.all(Array.from({ length: Math.min(4, availableParallelism()) }, async () => {
  for (let program; (program = queue.shift());) {
    const name = relative(root, join(program.dir, program.config)).replaceAll('\\', '/')
    try {
      const found = [...new Set(check(await listFiles(program)))]
      if (found.length) failures.push(`${name} gets libs its tsconfig doesn't name:\n${found.map(line => `  ${line}`).join('\n')}`)
    } catch (error) {
      failures.push(`${name}: ${error.message}`)
    }
  }
}))
if (failures.length) {
  console.error(`${failures.join('\n')}\n\nA declaration file in node_modules adds these libs with \`/// <reference lib>\`. If a package imports it without declaring it, give that package the dependency with packageExtensions in pnpm-workspace.yaml.`)
  process.exit(1)
}
