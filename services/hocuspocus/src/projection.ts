import { createHash } from 'node:crypto'
import * as Y from 'yjs'
import { decodeDocName } from './doc-name.js'
import type {
  AtomBodyCacheProjectionResult,
  DohcHocuspocusContext,
  HocuspocusAcl,
  HocuspocusLogger,
} from './hooks.js'
import { getDohcYDocMeta, yDocToMarkdown } from './import-export.js'
import type { PersistedProjectionJob, PostgresYDocStore } from './persistence.js'

export type ProjectionWorkerOptions = {
  store: PostgresYDocStore
  acl: HocuspocusAcl
  logger: HocuspocusLogger
  debounceMs?: number
}

export type ScheduleProjectionInput = {
  documentName: string
  document: Y.Doc
  context?: Partial<DohcHocuspocusContext> | null
  ydocSeq: number
}

export class ProjectionWorker {
  private readonly timers = new Map<string, ReturnType<typeof setTimeout>>()
  private flushing: Promise<void> | null = null
  private readonly debounceMs: number

  constructor(private readonly options: ProjectionWorkerOptions) {
    this.debounceMs = options.debounceMs ?? 500
  }

  schedule(input: ScheduleProjectionInput): void {
    const existing = this.timers.get(input.documentName)
    if (existing) clearTimeout(existing)

    const timer = setTimeout(() => {
      this.timers.delete(input.documentName)
      void this.enqueueAndFlush(input)
    }, this.debounceMs)
    this.timers.set(input.documentName, timer)
  }

  async flushPending(): Promise<void> {
    if (this.flushing) return this.flushing

    this.flushing = this.flushPendingOnce().finally(() => {
      this.flushing = null
    })
    return this.flushing
  }

  stop(): void {
    for (const timer of this.timers.values()) clearTimeout(timer)
    this.timers.clear()
  }

  private async enqueueAndFlush(input: ScheduleProjectionInput): Promise<void> {
    try {
      const doc = decodeDocName(input.documentName)
      const markdown = yDocToMarkdown(input.document)
      const meta = getDohcYDocMeta(input.document)
      await this.options.store.enqueueProjectionJob({
        documentName: input.documentName,
        workspaceId: doc.workspaceId,
        atomId: doc.atomId,
        markdown,
        projectionHash: markdownProjectionHash(markdown),
        schemaVersion: meta.schemaVersion,
        ydocStateVector: Buffer.from(Y.encodeStateVector(input.document)).toString(
          'base64',
        ),
        ydocSeq: input.ydocSeq,
        lastEditedByUserId:
          typeof input.context?.userId === 'string' ? input.context.userId : null,
      })
      await this.flushPending()
    } catch (error) {
      this.options.logger.error('failed to enqueue body projection', {
        documentName: input.documentName,
        error: errorMessage(error),
      })
    }
  }

  private async flushPendingOnce(): Promise<void> {
    const writeCache = this.options.acl.setAtomBodyCache
    if (!writeCache) return

    const jobs = await this.options.store.listRetryableProjectionJobs()
    for (const job of jobs) {
      await this.flushJob(job, writeCache)
    }
  }

  private async flushJob(
    job: PersistedProjectionJob,
    writeCache: NonNullable<HocuspocusAcl['setAtomBodyCache']>,
  ): Promise<void> {
    try {
      const result: AtomBodyCacheProjectionResult = await writeCache({
        workspaceId: job.workspaceId,
        atomId: job.atomId,
        markdown: job.markdown,
        projectionHash: job.projectionHash,
        schemaVersion: job.schemaVersion,
        ydocStateVector: job.ydocStateVector,
        lastEditedByUserId: job.lastEditedByUserId ?? undefined,
        projectedAt: Date.now(),
      })
      if (!result.ok) {
        throw new Error(`projection rejected: ${result.reason}`)
      }
      await this.options.store.markProjectionJobSucceeded(job.id)
    } catch (error) {
      await this.options.store.markProjectionJobFailed(job.id, errorMessage(error))
      this.options.logger.warn('body projection retryable failure', {
        documentName: job.documentName,
        jobId: job.id,
        error: errorMessage(error),
      })
    }
  }
}

export function createProjectionWorker(
  options: ProjectionWorkerOptions,
): ProjectionWorker {
  return new ProjectionWorker(options)
}

function markdownProjectionHash(markdown: string): string {
  return `sha256:${createHash('sha256').update(markdown).digest('hex')}`
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}
