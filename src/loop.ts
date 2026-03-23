import { join } from 'path'
import type { Config } from './config.js'
import type { GithubClient, GithubIssue, GithubComment, GithubRepoComment } from './github.js'
import type { TriggerContext } from './context.js'
import type { Storage } from './storage.js'
import { cloneOrFetch, createWorktree, removeWorktree } from './git.js'
import { runAgentForIssue } from './agent.js'
import { slugify } from './utils.js'
import { logger } from './logger.js'

const PROCESSING_MSG = '⏳ Processing...'
const FAILED_MSG = '❌ Processing timed out, retrying...'

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

function formatComments(comments: Array<{ id: number; user: string; body: string }>): string {
  return comments.map((c) => `[${c.user}]: ${c.body}`).join('\n\n')
}

function buildTriggerContext(
  issue: GithubIssue,
  triggerText: string,
  comments: GithubComment[],
  config: Config,
  botLogin: string
): TriggerContext {
  const safeComments = comments.filter((c) => c.user === botLogin || isAllowed(c.user, config))
  return {
    issueNumber: issue.number,
    title: issue.title,
    body: issue.body ?? '',
    comments: formatComments(safeComments),
    triggerText,
  }
}

async function processTrigger(
  issue: GithubIssue,
  triggerText: string,
  comments: GithubComment[],
  ctx: LoopContext
): Promise<void> {
  const { config, github, repoFullName, repoWorkDir, repoDefaultBranch } = ctx
  const processingCommentId = await github.addComment(issue.number, PROCESSING_MSG)

  const branch = `kronk/${issue.number}-${slugify(issue.title)}`
  const worktreePath = join(repoWorkDir, 'worktrees', `${issue.number}`)
  const sessionDir = join(config.piConfigDir, 'sessions', `${repoFullName.replace('/', '-')}-${issue.number}`)

  try {
    const token = await ctx.getToken()
    await createWorktree(repoWorkDir, worktreePath, branch, token)
  } catch (err) {
    logger.error({ repo: repoFullName, issueNumber: issue.number, err }, 'failed to create worktree')
    await github.editComment(processingCommentId, '❌ Processing failed.')
    return
  }

  try {
    const triggerCtx = buildTriggerContext(issue, triggerText, comments, config, ctx.botLogin)

    logger.info({ repo: repoFullName, issueNumber: issue.number, branch }, 'running agent')
    const response = await runAgentForIssue(triggerCtx, config, worktreePath, sessionDir, github, repoDefaultBranch)

    await github.editComment(processingCommentId, response)
    logger.info({ repo: repoFullName, issueNumber: issue.number }, 'posted response')
  } catch (err) {
    logger.error({ repo: repoFullName, issueNumber: issue.number, err }, 'agent failed')
    await github.editComment(processingCommentId, '❌ Processing failed.')
  } finally {
    try {
      await removeWorktree(repoWorkDir, worktreePath)
    } catch (err) {
      logger.warn({ repo: repoFullName, issueNumber: issue.number, err }, 'failed to remove worktree')
    }
  }
}

function findBotReplyAfter(comments: GithubComment[], triggerId: number, botLogin: string): GithubComment | undefined {
  return comments.find((c) => c.id > triggerId && c.user === botLogin)
}

async function processCommentTriggers(
  triggers: GithubRepoComment[],
  issueNumber: number,
  ctx: LoopContext
): Promise<void> {
  const { config, github, botLogin, repoFullName } = ctx
  const [issue, allComments] = await Promise.all([github.getIssue(issueNumber), github.getIssueComments(issueNumber)])
  if (!issue) return

  for (const trigger of triggers) {
    const botReply = findBotReplyAfter(allComments, trigger.id, botLogin)
    if (!botReply) {
      logger.info({ repo: repoFullName, issueNumber, commentId: trigger.id }, 'trigger found in comment')
      await processTrigger(issue, trigger.body, allComments, ctx)
    } else if (botReply.body === PROCESSING_MSG) {
      const age = Date.now() - new Date(botReply.created_at).getTime()
      if (age > config.processingTimeout) {
        logger.warn({ repo: repoFullName, issueNumber, commentId: trigger.id }, 'recovering stale processing comment')
        await github.editComment(botReply.id, FAILED_MSG)
        await processTrigger(issue, trigger.body, allComments, ctx)
      }
    }
    // bot has a real reply → already handled, skip
  }
}

async function scanForTriggers(ctx: LoopContext, since: string, updatedIssues: GithubIssue[]): Promise<void> {
  const { config, github, storage, botLogin, repoFullName } = ctx
  const triggerWord = config.triggerWord
  const scanStartedAt = new Date().toISOString()

  // Scan bodies of updated issues
  for (const issue of updatedIssues) {
    if (!isAllowed(issue.user, config)) {
      logger.info(
        { repo: repoFullName, issueNumber: issue.number, user: issue.user },
        'ignoring trigger from non-allowed user'
      )
      continue
    }
    if (!issue.body?.includes(triggerWord)) continue
    logger.info({ repo: repoFullName, issueNumber: issue.number }, 'trigger found in issue body')
    const comments = await github.getIssueComments(issue.number)
    const botReply = comments.find((c) => c.user === botLogin)
    if (!botReply) {
      await processTrigger(issue, issue.body, comments, ctx)
    } else if (botReply.body === PROCESSING_MSG) {
      const age = Date.now() - new Date(botReply.created_at).getTime()
      if (age > config.processingTimeout) {
        logger.warn({ repo: repoFullName, issueNumber: issue.number }, 'recovering stale processing comment')
        await github.editComment(botReply.id, FAILED_MSG)
        await processTrigger(issue, issue.body, comments, ctx)
      }
    }
    // bot has a real reply → already handled, skip
  }

  // Scan new comments across all issues/PRs since last run, grouped by issue to avoid duplicate fetches
  const newComments = await github.listNewComments(since)
  const triggerComments = newComments.filter(
    (c) => c.user !== botLogin && c.body.includes(triggerWord) && isAllowed(c.user, config)
  )

  const byIssue = new Map<number, GithubRepoComment[]>()
  for (const trigger of triggerComments) {
    const group = byIssue.get(trigger.issueNumber) ?? []
    group.push(trigger)
    byIssue.set(trigger.issueNumber, group)
  }

  await Promise.all(
    [...byIssue.entries()].map(([issueNumber, triggers]) => processCommentTriggers(triggers, issueNumber, ctx))
  )

  storage.recordRun(repoFullName, scanStartedAt)
}

export async function pollCycle(ctx: LoopContext): Promise<void> {
  logger.info({ repo: ctx.repoFullName }, 'poll cycle starting')

  const since = ctx.storage.getLastRunAt(ctx.repoFullName)
  const [, updatedIssues] = await Promise.all([
    ctx
      .getToken()
      .then((token) => cloneOrFetch(ctx.repoFullName, ctx.repoWorkDir, ctx.repoDefaultBranch, token))
      .catch((err) =>
        logger.error({ repo: ctx.repoFullName, err }, 'failed to fetch repo, continuing with existing workspace')
      ),
    ctx.github.getIssuesUpdatedSince(since),
  ])
  await scanForTriggers(ctx, since, updatedIssues)
}
