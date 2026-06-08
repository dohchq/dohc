import * as esbuild from 'esbuild'
import { builtinModules, createRequire } from 'node:module'
import { dirname, extname, join, normalize } from 'node:path'
import {
  MAX_APP_BUNDLE_BYTES,
  MAX_APP_SOURCE_BYTES,
  MAX_APP_SOURCE_FILES,
  type AppSourceFile,
  type BuildAppBundleResult,
} from './buildAppBundle.shared'
import { VIRTUAL_DOHC_SDK } from './virtualDohcAppSdk'

export {
  MAX_APP_BUNDLE_BYTES,
  MAX_APP_SOURCE_BYTES,
  MAX_APP_SOURCE_FILES,
  MAX_VIEW_BUNDLE_BYTES,
  MAX_VIEW_SOURCE_BYTES,
  MAX_VIEW_SOURCE_FILES,
  type BuildAppBundleResult,
  type BuildViewBundleResult,
} from './buildAppBundle.shared'

const TEXT_ENCODER = new TextEncoder()
const NODE_BUILTINS = new Set([
  ...builtinModules,
  ...builtinModules.map((name) => `node:${name}`),
])
const require = createRequire(import.meta.url)
const APP_ENTRY_WRAPPER = '__dohc_app_entry__.tsx'

function bytes(value: string): number {
  return TEXT_ENCODER.encode(value).length
}

function diagnostic(code: string, message: string): BuildAppBundleResult {
  return { ok: false, diagnostics: [{ code, message }] }
}

function cleanRelativePath(path: string): string | null {
  const clean = normalize(path.replace(/^\/+/, '')).replace(/\\/g, '/')
  if (!clean || clean === '.' || clean.startsWith('../') || clean.includes('/../')) {
    return null
  }
  return clean
}

function loaderFor(path: string): esbuild.Loader {
  const ext = extname(path).toLowerCase()
  if (ext === '.tsx') return 'tsx'
  if (ext === '.ts') return 'ts'
  if (ext === '.jsx') return 'jsx'
  if (ext === '.js') return 'js'
  if (ext === '.json') return 'json'
  return 'text'
}

function jsString(value: string): string {
  return JSON.stringify(value)
}

function stripDohcFrontmatter(body: string): string {
  if (!body.startsWith('---\n') && !body.startsWith('---\r\n')) return body
  const match = /^---\r?\n[\s\S]*?\r?\n---\r?\n?/.exec(body)
  return match ? body.slice(match[0].length) : body
}

function resolveRelativeImport(
  files: Map<string, string>,
  importer: string,
  specifier: string,
): string | null {
  const base = cleanRelativePath(join(dirname(importer), specifier))
  if (!base) return null
  const candidates = [
    base,
    `${base}.ts`,
    `${base}.tsx`,
    `${base}.js`,
    `${base}.jsx`,
    `${base}.json`,
    `${base}.css`,
    `${base}/index.ts`,
    `${base}/index.tsx`,
    `${base}/index.js`,
    `${base}/index.jsx`,
  ]
  return candidates.find((candidate) => files.has(candidate)) ?? null
}

export async function buildAppBundle({
  entry,
  files,
}: {
  entry: string
  files: AppSourceFile[]
}): Promise<BuildAppBundleResult> {
  if (files.length > MAX_APP_SOURCE_FILES) {
    return diagnostic(
      'too-many-files',
      'This app has too many source files to render safely.',
    )
  }

  let totalBytes = 0
  const fileMap = new Map<string, string>()
  for (const file of files) {
    const cleanPath = cleanRelativePath(file.relativePath)
    if (!cleanPath) return diagnostic('invalid-path', 'An app source path is invalid.')
    totalBytes += bytes(file.body)
    if (totalBytes > MAX_APP_SOURCE_BYTES) {
      return diagnostic(
        'source-too-large',
        'This app source is too large to render safely.',
      )
    }
    fileMap.set(cleanPath, stripDohcFrontmatter(file.body))
  }

  const cleanEntry = cleanRelativePath(entry)
  if (!cleanEntry || !fileMap.has(cleanEntry)) {
    return diagnostic('missing-entry', 'The app entry file was not found.')
  }

  const plugin: esbuild.Plugin = {
    name: 'dohc-app-virtual-files',
    setup(build) {
      build.onResolve({ filter: /.*/ }, (args) => {
        const fromApp =
          args.namespace === 'dohc-app' ||
          args.namespace === 'dohc-app-entry' ||
          args.importer === ''
        if (
          args.path === 'react' ||
          args.path === 'react-dom/client' ||
          args.path === 'react/jsx-runtime' ||
          args.path === 'react/jsx-dev-runtime'
        ) {
          return { path: require.resolve(args.path) }
        }
        if (args.path === APP_ENTRY_WRAPPER && args.importer === '') {
          return { path: args.path, namespace: 'dohc-app-entry' }
        }
        if (!fromApp && args.path !== '@dohc/app' && args.path !== '@dohc/view') {
          return undefined
        }
        if (args.kind === 'dynamic-import') {
          return {
            errors: [{ text: 'dynamic-import' }],
          }
        }
        if (/^https?:\/\//i.test(args.path)) {
          return {
            errors: [{ text: 'remote-import' }],
          }
        }
        if (args.path.startsWith('/')) {
          return {
            errors: [{ text: 'absolute-import' }],
          }
        }
        if (args.path === '@dohc/app' || args.path === '@dohc/view') {
          return { path: args.path, namespace: 'dohc-app-sdk' }
        }
        if (args.path === cleanEntry && args.importer === '') {
          return { path: cleanEntry, namespace: 'dohc-app' }
        }
        if (args.path.startsWith('.')) {
          const importer = args.importer.replace(/^\/+/, '')
          const resolved = resolveRelativeImport(fileMap, importer, args.path)
          if (!resolved) return { errors: [{ text: 'missing-relative-import' }] }
          return { path: resolved, namespace: 'dohc-app' }
        }
        if (NODE_BUILTINS.has(args.path)) {
          return { errors: [{ text: 'unsupported-import' }] }
        }
        return { errors: [{ text: 'unsupported-import' }] }
      })

      build.onLoad({ filter: /.*/, namespace: 'dohc-app-entry' }, () => ({
        contents: `
import React from 'react'
import { createRoot } from 'react-dom/client'
import * as AppModule from './${cleanEntry}'
const Component = AppModule.default
if (Component !== undefined) {
  const root = document.getElementById('root')
  if (root && root.childNodes.length === 0) {
    createRoot(root).render(React.createElement(Component))
  }
}
`,
        loader: 'tsx',
        resolveDir: '.',
      }))

      build.onLoad({ filter: /.*/, namespace: 'dohc-app-sdk' }, (args) => {
        const contents = args.path === '@dohc/view'
          ? VIRTUAL_DOHC_SDK.replace(
              'export const dohc = window.dohc',
              "console.warn('@dohc/view is deprecated; use @dohc/app')\nexport const dohc = window.dohc",
            )
          : VIRTUAL_DOHC_SDK
        return { contents, loader: 'js' }
      })

      build.onLoad({ filter: /.*/, namespace: 'dohc-app' }, (args) => {
        const cleanPath = cleanRelativePath(args.path)
        if (!cleanPath) return { errors: [{ text: 'invalid-path' }] }
        const contents = fileMap.get(cleanPath)
        if (contents === undefined) return { errors: [{ text: 'missing-source' }] }
        if (cleanPath.endsWith('.css')) {
          return {
            contents: `
const style = document.createElement('style')
style.textContent = ${jsString(contents)}
document.head.appendChild(style)
`,
            loader: 'js',
          }
        }
        return {
          contents,
          loader: loaderFor(cleanPath),
          resolveDir: dirname(cleanPath),
        }
      })
    },
  }

  try {
    const result = await esbuild.build({
      entryPoints: [APP_ENTRY_WRAPPER],
      bundle: true,
      write: false,
      platform: 'browser',
      format: 'iife',
      target: 'es2020',
      jsx: 'automatic',
      minify: true,
      define: {
        'process.env.NODE_ENV': '"production"',
      },
      plugins: [plugin],
      logLevel: 'silent',
    })
    const code = result.outputFiles[0]?.text ?? ''
    if (bytes(code) > MAX_APP_BUNDLE_BYTES) {
      return diagnostic(
        'bundle-too-large',
        'This app is too large to render safely.',
      )
    }
    return { ok: true, code, diagnostics: [] }
  } catch (error) {
    const text = error instanceof Error ? error.message : String(error)
    const code =
      text.includes('dynamic-import')
        ? 'dynamic-import'
        : text.includes('absolute-import')
          ? 'absolute-import'
          : text.includes('unsupported-import')
            ? 'unsupported-import'
            : text.includes('remote-import')
              ? 'remote-import'
              : 'build-failed'
    return diagnostic(code, 'This app could not be bundled safely.')
  }
}
