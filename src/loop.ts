import { join } from 'path'
import type { Config } from './config.js'
import type { GithubClient, GithubIssue, GithubComment } from './github.js'
import type { Issue } from './storage.js'
import type { TriggerContext } from './context.js'
import { Storage } from './storage.js'
import { cloneOrFetch } from './git.js'
import { runOrchestrator } from './orchestrator.js'
import { logger } from './logger.js'

const PROCESSING_MSG = '⏳ Processing...'
const FAILED_MSG = '❌ Processing timed out, retrying...'

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

function formatComments(comments: Array<{ id: number; user: string; body: string }>): string {
  return comments.map((c) => `[${c.user}]: ${c.body}`).join('\n\n')
}

function buildTriggerContext(issue: Issue, triggerText: string, comments: GithubComment[]): TriggerContext {
  return {
    issueNumber: issue.number,
    title: issue.title,
    body: issue.body ?? '',
    comments: formatComments(comments),
    triggerText,
  }
}

async function syncIssues(repo: string, issues: GithubIssue[], storage: Storage): Promise<void> {
  for (const issue of issues) {
    storage.upsertIssue(repo, { number: issue.number, title: issue.title, body: issue.body })
  }
  logger.info({ repo, count: issues.length }, 'synced issues')
}

async function processTrigger(
  issue: Issue,
  triggerText: string,
  comments: GithubComment[],
  ctx: LoopContext
): Promise<void> {
  const { config, github, repoFullName, repoWorkDir } = ctx
  const processingCommentId = await github.addComment(issue.number, PROCESSING_MSG)

  try {
    const triggerCtx = buildTriggerContext(issue, triggerText, comments)
    const sessionDir = join(config.piConfigDir, 'sessions', `${repoFullName.replace('/', '-')}-${issue.number}-orchestrator`)

    logger.info({ repo: repoFullName, issueNumber: issue.number }, 'running orchestrator')
    const response = await runOrchestrator(triggerCtx, config, repoWorkDir, sessionDir)

    await github.editComment(processingCommentId, response ?? '✅ Done.')
    logger.info({ repo: repoFullName, issueNumber: issue.number }, 'posted response')
  } catch (err) {
    logger.error({ repo: repoFullName, issueNumber: issue.number, err }, 'orchestrator failed')
    await github.editComment(processingCommentId, '❌ Processing failed.')
  }
}

function findBotReplyAfter(comments: GithubComment[], triggerId: number, botLogin: string): GithubComment | undefined {
  return comments.find((c) => c.id > triggerId && c.user === botLogin)
}

async function scanForTriggers(ctx: LoopContext): Promise<void> {
  const { config, github, storage, botLogin, repoFullName } = ctx
  const triggerWord = config.triggerWord
  const scanStartedAt = new Date().toISOString()

  // Scan bodies of newly seen issues
  for (const issue of storage.getUnscannedIssues(repoFullName)) {
    if (issue.body && issue.body.includes(triggerWord)) {
      logger.info({ repo: repoFullName, issueNumber: issue.number }, 'trigger found in issue body')
      const comments = await github.getIssueComments(issue.number)
      await processTrigger(issue, issue.body, comments, ctx)
    }
    storage.markBodyScanned(repoFullName, issue.number)
  }

  // Scan comments on issues updated since last run
  const updatedIssues = await github.getIssuesUpdatedSince(storage.getLastRunAt(repoFullName))
  for (const ghIssue of updatedIssues) {
    const issue = storage.getIssue(repoFullName, ghIssue.number)
    if (!issue) continue

    const comments = await github.getIssueComments(ghIssue.number)
    const triggerComments = comments.filter((c) => c.user !== botLogin && c.body.includes(triggerWord))

    for (const trigger of triggerComments) {
      const botReply = findBotReplyAfter(comments, trigger.id, botLogin)

      if (!botReply) {
        logger.info({ repo: repoFullName, issueNumber: issue.number, commentId: trigger.id }, 'trigger found in comment')
        await processTrigger(issue, trigger.body, comments, ctx)
      } else if (botReply.body === PROCESSING_MSG) {
        const age = Date.now() - new Date(botReply.created_at).getTime()
        if (age > config.processingTimeout) {
          logger.warn({ repo: repoFullName, issueNumber: issue.number, commentId: trigger.id }, 'recovering stale processing comment')
          await github.editComment(botReply.id, FAILED_MSG)
          await processTrigger(issue, trigger.body, comments, ctx)
        }
      }
      // bot has a real reply → already handled, skip
    }
  }

  storage.logRun(repoFullName, scanStartedAt)
}

export async function pollCycle(ctx: LoopContext): Promise<void> {
  logger.info({ repo: ctx.repoFullName }, 'poll cycle starting')

  try {
    await cloneOrFetch(ctx.config, ctx.repoFullName, ctx.repoWorkDir, ctx.repoDefaultBranch, ctx.getToken)
  } catch (err) {
    logger.error({ repo: ctx.repoFullName, err }, 'failed to fetch repo, continuing with existing workspace')
  }

  const allIssues = await ctx.github.getOpenIssues()
  await syncIssues(ctx.repoFullName, allIssues, ctx.storage)
  await scanForTriggers(ctx)
}
