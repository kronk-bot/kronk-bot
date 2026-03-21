import { join } from 'path'
import { runAgent } from './agent-runner.js'
import type { Config } from './config.js'
import type { TriggerContext } from './context.js'

export async function runOrchestrator(ctx: TriggerContext, config: Config, workDir: string, sessionDir: string): Promise<string> {
  const result = await runAgent(
    'orchestrator',
    join(config.agentsDir, 'orchestrator.md'),
    config.orchestratorModel,
    ctx,
    workDir,
    config,
    sessionDir,
    `orchestrator-issue-${ctx.issueNumber}`
  )

  const { model, sessionName, tokens, cost, context, toolCalls } = result.stats
  const parts: string[] = []
  if (model) parts.push(`**model:** ${model}`)
  if (sessionName) parts.push(`**session:** ${sessionName}`)
  parts.push(`**tokens:** ${tokens.total.toLocaleString()} (↑${tokens.input.toLocaleString()} ↓${tokens.output.toLocaleString()})`)
  parts.push(`**cost:** $${cost.toFixed(4)}`)
  if (context.percent !== null) parts.push(`**context:** ${context.percent.toFixed(0)}%`)
  parts.push(`**tool calls:** ${toolCalls}`)
  const footer = `\n\\\n\\\n<sub>:mag: &nbsp; ${parts.join(' · ')}</sub>`

  return result.text + footer
}
