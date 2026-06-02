export type ViewSourceFile = {
  relativePath: string
  body: string
}

export type ViewBuildDiagnostic = {
  code: string
  message: string
}

export type BuildViewBundleResult =
  | { ok: true; code: string; diagnostics: ViewBuildDiagnostic[] }
  | { ok: false; diagnostics: ViewBuildDiagnostic[] }

export const MAX_VIEW_SOURCE_FILES = 100
export const MAX_VIEW_SOURCE_BYTES = 512 * 1024
export const MAX_VIEW_BUNDLE_BYTES = 1024 * 1024
