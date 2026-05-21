import { HeatmapKernel } from './kernels/HeatmapKernel'
import { ListKernel } from './kernels/ListKernel'
import { TableKernel } from './kernels/TableKernel'
import { CustomKernel } from './kernels/CustomKernel'
import type { Kernel } from './types'

// Built-in kernels. Four total. Plugin atoms reference them by key.

export const KERNELS: Record<string, Kernel> = {
  heatmap: HeatmapKernel,
  list: ListKernel,
  table: TableKernel,
  custom: CustomKernel,
}
