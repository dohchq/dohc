export type AppSourceFile = {
  relativePath: string
  body: string
}

export type AppBuildDiagnostic = {
  code: string
  message: string
}

export type BuildAppBundleResult =
  | { ok: true; code: string; diagnostics: AppBuildDiagnostic[] }
  | { ok: false; diagnostics: AppBuildDiagnostic[] }

export const MAX_APP_SOURCE_FILES = 100
export const MAX_APP_SOURCE_BYTES = 512 * 1024
export const MAX_APP_BUNDLE_BYTES = 1024 * 1024

export type ViewSourceFile = AppSourceFile
export type ViewBuildDiagnostic = AppBuildDiagnostic
export type BuildViewBundleResult = BuildAppBundleResult
export const MAX_VIEW_SOURCE_FILES = MAX_APP_SOURCE_FILES
export const MAX_VIEW_SOURCE_BYTES = MAX_APP_SOURCE_BYTES
export const MAX_VIEW_BUNDLE_BYTES = MAX_APP_BUNDLE_BYTES
