import type { Stats } from './utils.js'

export type { Stats as SessionStats }

export class StatsProvider {
  private stats: Stats = {
    model: undefined,
    sessionName: undefined,
    tokens: { input: 0, output: 0, total: 0 },
    cost: 0,
    context: { percent: null },
  }

  update(session: {
    model?: { id: string }
    sessionName?: string
    getSessionStats(): any
    getContextUsage(): any
  }): void {
    const sessionStats = session.getSessionStats()
    const contextUsage = session.getContextUsage() ?? { percent: null }
    this.stats = {
      model: session.model?.id,
      sessionName: session.sessionName,
      tokens: {
        input: sessionStats.tokens.input,
        output: sessionStats.tokens.output,
        total: sessionStats.tokens.total,
      },
      cost: sessionStats.cost,
      context: { percent: contextUsage.percent },
    }
  }

  getStats(): Stats {
    return this.stats
  }
}
