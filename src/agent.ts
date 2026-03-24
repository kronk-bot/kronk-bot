import { join } from 'path'
import { readFileSync, rmSync } from 'fs'
import { runAgent } from './agent-runner.js'
import { createGithubTools, createGithubExplorerTool, createRepoExplorerTool } from './tools.js'
import { commitAndPush, getCurrentBranch } from './git.js'
import { formatStatsFooter } from './utils.js'
import { logger } from './logger.js'
import type { Config } from './config.js'
import type { TriggerContext } from './context.js'
import type { GithubClient } from './github.js'

interface AgentResponse {
  comment: string
  commitMessage?: string
  prNumber?: number
  prTitle?: string
  prBody?: string
}

function consumeAgentOutput(outputFile: string): AgentResponse {
  const jsonContent = readFileSync(outputFile, 'utf-8')
  rmSync(outputFile)
  return JSON.parse(jsonContent)
}

async function updateOrCreatePullRequest(
  github: GithubClient,
  worktreePath: string,
  ctx: TriggerContext,
  response: AgentResponse,
  defaultBranch: string
): Promise<void> {
  const existingPr = response.prNumber !== undefined
    ? ctx.pullRequests.find((pr) => pr.number === response.prNumber)
    : undefined

  const prTitle = response.prTitle ?? ''
  const prBody = response.prBody ?? ''

  if (existingPr) {
    await github.updatePullRequest(existingPr.number, prTitle, prBody)
    logger.info({ issueNumber: ctx.issueNumber, prNumber: existingPr.number }, 'updated PR')
    return
  }

  if (response.prTitle) {
    const head = await getCurrentBranch(worktreePath)
    const url = await github.createPullRequest(prTitle, prBody, head, defaultBranch)
    logger.info({ issueNumber: ctx.issueNumber, url }, 'created PR')
  }
}

export async function runAgentForIssue(
  ctx: TriggerContext,
  config: Config,
  worktreePath: string,
  sessionDir: string,
  github: GithubClient,
  defaultBranch: string
): Promise<void> {
  const githubTools = createGithubTools(github)
  const tools = [
    createGithubExplorerTool(config, worktreePath, githubTools),
    createRepoExplorerTool(config, worktreePath),
  ]

  const { stats } = await runAgent(
    'agent',
    join(config.agentsDir, 'agent.md'),
    config.agentModel,
    ctx,
    worktreePath,
    config,
    sessionDir,
    `${ctx.issueNumber}`,
    tools,
    ctx.outputFile
  )

  const response = consumeAgentOutput(ctx.outputFile)

  if (response.commitMessage) {
    await commitAndPush(worktreePath, response.commitMessage, ctx.issueNumber)
  }

  await updateOrCreatePullRequest(github, worktreePath, ctx, response, defaultBranch)

  const footer = formatStatsFooter(stats)
  await github.editComment(ctx.processingCommentId, response.comment + footer)
}
