import { join } from 'path'
import { runAgent } from './agent-runner.js'
import type { Config } from './config.js'
import type { TriggerContext } from './context.js'
import type { GithubClient } from './github.js'
import { createGitCommitTool, createGitPushTool, createGhPrCreateTool } from './tools.js'

export async function runAgentForIssue(
  ctx: TriggerContext,
  config: Config,
  worktreePath: string,
  sessionDir: string,
  github: GithubClient,
  defaultBranch: string
): Promise<string> {
  const extraTools = [
    createGitCommitTool(worktreePath),
    createGitPushTool(worktreePath),
    createGhPrCreateTool(worktreePath, github, defaultBranch),
  ]

  const result = await runAgent(
    'agent',
    join(config.agentsDir, 'agent.md'),
    config.agentModel,
    ctx,
    worktreePath,
    config,
    sessionDir,
    extraTools,
    `${ctx.issueNumber}`
  )

  const { model, sessionName, tokens, cost, context } = result.stats
  const parts: string[] = []
  if (sessionName) parts.push(`**session:** ${sessionName}`)
  if (model) parts.push(`**model:** ${model}`)
  parts.push(`**tokens:** ${tokens.total.toLocaleString()} (↑${tokens.input.toLocaleString()} ↓${tokens.output.toLocaleString()})`)
  parts.push(`**cost:** $${cost.toFixed(4)}`)
  if (context.percent !== null) parts.push(`**context:** ${context.percent.toFixed(0)}%`)
  const footer = `\n\\\n\\\n<sub>:mag: &nbsp; ${parts.join(' · ')}</sub>`

  return result.text + footer
}
