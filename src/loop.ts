import { join } from 'path'
import { randomUUID } from 'crypto'
import type { Config } from './config.js'
import type { GithubClient, GithubIssue, GithubRepoComment } from './github.js'
import type { Storage, Trigger, NewTriggerData } from './storage.js'
import { cloneOrFetch } from './git.js'
import { runAgentForIssue } from './agent.js'
import { logger } from './logger.js'

const MSG_PROCESSING = '⏳ Processing...'
const MSG_FAILED = '❌ Processing failed.'


function isAllowed(user: string, config: Config): boolean {
  return config.allowedUsers.length === 0 || config.allowedUsers.includes(user)
}

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

async function fetchBodyTriggers(ctx: LoopContext, since: string): Promise<NewTriggerData[]> {
  const { config, github, repoFullName } = ctx
  const triggerWord = config.triggerWord
  const updatedIssues = await github.getIssuesUpdatedSince(since)
  const results: NewTriggerData[] = []

  for (const issue of updatedIssues) {
    if (!isAllowed(issue.user, config)) continue
    if (!issue.body?.includes(triggerWord)) continue
    results.push({
      id: randomUUID(),
      repo: repoFullName,
      source_type: issue.isPR ? 'pr_body' : 'issue_body',
      source_id: String(issue.number),
      issue_number: issue.number,
      is_pr: issue.isPR,
      trigger_text: issue.body,
      created_at: issue.updated_at,
    })
  }

  return results
}

async function fetchCommentTriggers(ctx: LoopContext, since: string): Promise<NewTriggerData[]> {
  const { config, github, botLogin, repoFullName } = ctx
  const triggerWord = config.triggerWord

  const newComments = await github.listNewComments(since)
  const triggerComments = newComments.filter(
    (c) => c.user !== botLogin && c.body.includes(triggerWord) && isAllowed(c.user, config)
  )

  const byIssue = new Map<number, GithubRepoComment[]>()
  for (const comment of triggerComments) {
    const group = byIssue.get(comment.issueNumber) ?? []
    group.push(comment)
    byIssue.set(comment.issueNumber, group)
  }

  const grouped = await Promise.all(
    [...byIssue.entries()].map(async ([issueNumber, comments]) => {
      const issue = await github.getIssue(issueNumber)
      if (!issue) {
        logger.warn({ repo: repoFullName, issueNumber }, 'issue not found, skipping comment triggers')
        return []
      }
      return comments.map((comment): NewTriggerData => ({
        id: randomUUID(),
        repo: repoFullName,
        source_type: issue.isPR ? 'pr_comment' : 'issue_comment',
        source_id: String(comment.id),
        issue_number: issueNumber,
        is_pr: issue.isPR,
        trigger_text: comment.body,
        created_at: comment.created_at,
      }))
    })
  )

  return grouped.flat()
}

async function processSingleTrigger(trigger: Trigger, ctx: LoopContext): Promise<void> {
  const { config, github, storage, repoFullName, repoWorkDir, repoDefaultBranch } = ctx

  const issue = await github.getIssue(trigger.issue_number)
  if (!issue) {
    storage.markFailed(trigger.id, new Date().toISOString(), 'issue not found')
    return
  }

  let placeholderCommentId: number
  if (trigger.placeholder_comment_id) {
    placeholderCommentId = trigger.placeholder_comment_id
    await github.editComment(placeholderCommentId, MSG_PROCESSING)
  } else {
    placeholderCommentId = await github.addComment(trigger.issue_number, MSG_PROCESSING)
  }
  const now = new Date().toISOString()
  storage.markProcessing(trigger.id, now, placeholderCommentId)

  const outputFile = join(repoWorkDir, `kronk-output-${trigger.id}.json`)
  const sessionDir = join(config.piConfigDir, 'sessions', `${repoFullName.replace('/', '-')}-${trigger.issue_number}`)

  const triggerCtx = {
    issueNumber: trigger.issue_number,
    title: issue.title,
    body: issue.body ?? '',
    comments: '',
    triggerText: trigger.trigger_text,
    triggerSource: (trigger.is_pr ? 'pr' : 'issue') as 'issue' | 'pr',
    processingCommentId: placeholderCommentId,
    outputFile,
    pullRequests: [],
    checkRuns: undefined,
  }

  try {
    logger.info({ repo: repoFullName, issueNumber: trigger.issue_number, triggerId: trigger.id }, 'running agent')
    await runAgentForIssue(triggerCtx, config, repoWorkDir, sessionDir, github, repoDefaultBranch)
    storage.markDone(trigger.id, new Date().toISOString())
    logger.info({ repo: repoFullName, issueNumber: trigger.issue_number }, 'agent done')
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err)
    logger.error({ repo: repoFullName, issueNumber: trigger.issue_number, err }, 'agent failed')
    storage.markFailed(trigger.id, new Date().toISOString(), msg)
    await github.editComment(placeholderCommentId, MSG_FAILED)
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
    fetchBodyTriggers(ctx, since),
    fetchCommentTriggers(ctx, since),
  ])

  const newTriggers = [...bodyTriggers, ...commentTriggers]
  const hasWork = staleTriggers.length > 0 || newTriggers.length > 0

  // Phase 2: advance scan cursor (before any slow work)
  storage.recordRun(repoFullName, scanStartedAt)

  if (!hasWork) return

  // Phase 3: atomic persist — reset stale + insert new triggers in a single transaction
  storage.recoverStaleAndInsert(repoFullName, staleTriggers.map((t) => t.id), newTriggers)

  // Phase 4: fetch repo
  await ctx.getToken()
    .then((token) => cloneOrFetch(repoFullName, ctx.repoWorkDir, ctx.repoDefaultBranch, token))
    .catch((err) => logger.error({ repo: repoFullName, err }, 'failed to fetch repo, continuing with existing workspace'))

  // Phase 5: process all pending triggers in parallel
  const pending = storage.getPendingTriggers(repoFullName)
  await Promise.all(pending.map((t) => processSingleTrigger(t, ctx)))
}
