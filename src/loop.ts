import { join } from 'path'
import type { Config } from './config.js'
import type { GithubClient } from './github.js'
import type { Storage, Trigger } from './storage.js'
import { cloneOrFetch } from './git.js'
import { Orchestrator } from './orchestrator.js'
import { logger } from './logger.js'
import { fetchBodyTriggers, fetchCommentTriggers } from './triggers.js'

export interface LoopContext {
  config: Config
  github: GithubClient
  storage: Storage
  botLogin: string
  getToken: () => Promise<string>
  repoFullName: string
  repoWorkDir: string
  repoDefaultBranch: string
}

async function processSingleTrigger(trigger: Trigger, ctx: LoopContext): Promise<void> {
  const { config, github, storage, repoFullName, repoWorkDir, getToken } = ctx

  const now = new Date().toISOString()
  storage.markProcessing(trigger.id, now)

  const sessionDir = join(config.piConfigDir, 'sessions', `${repoFullName.replace('/', '-')}-${trigger.issue_number}`)

  const triggerCtx = {
    issueNumber: trigger.issue_number,
    triggerText: trigger.trigger_text,
    triggerSource: (trigger.is_pr ? 'pr' : 'issue') as 'issue' | 'pr',
    triggerId: trigger.id,
  }

  try {
    logger.info(
      { repo: repoFullName, issueNumber: trigger.issue_number, triggerId: trigger.id },
      'running orchestrator'
    )
    const githubToken = await getToken()
    const orchestrator = new Orchestrator(config, github, githubToken, repoWorkDir, sessionDir, storage)
    await orchestrator.run(triggerCtx)
    storage.markDone(trigger.id, new Date().toISOString())
    logger.info({ repo: repoFullName, issueNumber: trigger.issue_number }, 'orchestrator done')
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err)
    logger.error({ repo: repoFullName, issueNumber: trigger.issue_number, err }, 'orchestrator failed')
    storage.markFailed(trigger.id, new Date().toISOString(), msg)
  }
}

export async function pollCycle(ctx: LoopContext): Promise<void> {
  logger.info({ repo: ctx.repoFullName }, 'poll cycle starting')

  const { config, github, storage, repoFullName } = ctx
  const since = storage.getLastRunAt(repoFullName)
  const scanStartedAt = new Date().toISOString()

  // Phase 1: parallel reads — no storage writes
  const [staleTriggers, bodyTriggers, commentTriggers] = await Promise.all([
    storage.getStaleTriggers(repoFullName, config.processingTimeout),
    fetchBodyTriggers(config, github, repoFullName, since),
    fetchCommentTriggers(config, github, ctx.botLogin, repoFullName, since),
  ])

  const newTriggers = [...bodyTriggers, ...commentTriggers]
  const hasWork = staleTriggers.length > 0 || newTriggers.length > 0

  // Phase 2: advance scan cursor (before any slow work)
  storage.recordRun(repoFullName, scanStartedAt)

  if (!hasWork) return

  // Phase 3: atomic persist — reset stale + insert new triggers in a single transaction
  storage.recoverStaleAndInsert(
    repoFullName,
    staleTriggers.map((t) => t.id),
    newTriggers
  )

  // Phase 4: fetch repo (explorer needs access to the codebase)
  await ctx
    .getToken()
    .then((token) => cloneOrFetch(repoFullName, ctx.repoWorkDir, ctx.repoDefaultBranch, token))
    .catch((err) =>
      logger.error({ repo: repoFullName, err }, 'failed to fetch repo, continuing with existing workspace')
    )

  // Phase 5: process all pending triggers in parallel
  const pending = storage.getPendingTriggers(repoFullName)
  await Promise.all(pending.map((t) => processSingleTrigger(t, ctx)))
}
