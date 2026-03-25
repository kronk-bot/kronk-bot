import { AgentSession } from '@mariozechner/pi-coding-agent'

export interface SessionStats {
  model?: string
  sessionName?: string
  tokens: { input: number; output: number; total: number }
  cost: number
  context: { percent: number | null }
}

export class StatsProvider {
  private stats: SessionStats = {
    model: undefined,
    sessionName: undefined,
    tokens: { input: 0, output: 0, total: 0 },
    cost: 0,
    context: { percent: null },
  }

  update(session: AgentSession): void {
    const sessionStats = session.getSessionStats()
    const contextUsage = session.getContextUsage()

    this.stats = {
      model: session.model?.id,
      sessionName: session.sessionName,
      tokens: {
        input: sessionStats?.tokens?.input ?? 0,
        output: sessionStats?.tokens?.output ?? 0,
        total: sessionStats?.tokens?.total ?? 0,
      },
      cost: sessionStats?.cost ?? 0,
      context: { percent: contextUsage?.percent ?? null },
    }
  }

  getStats(): SessionStats {
    return this.stats
  }
}

export function formatStatsFooter(stats: SessionStats): string {
  const parts: string[] = []

  if (stats.sessionName) parts.push(`**session:** ${stats.sessionName}`)
  if (stats.model) parts.push(`**model:** ${stats.model}`)
  parts.push(
    `**tokens:** ${stats.tokens.total.toLocaleString()} (↑${stats.tokens.input.toLocaleString()} ↓${stats.tokens.output.toLocaleString()})`
  )
  parts.push(`**cost:** $${stats.cost.toFixed(4)}`)
  if (stats.context.percent !== null) parts.push(`**context:** ${stats.context.percent.toFixed(0)}%`)

  return `\n\\\n\\\n<sub>${parts.join(' · ')}</sub>`
}
