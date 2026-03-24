export interface Stats {
  model?: string
  sessionName?: string
  tokens: { input: number; output: number; total: number }
  cost: number
  context: { percent: number | null }
}

const MAX_SLUG_LENGTH = 50

export function slugify(text: string): string {
  return text
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-|-$/g, '')
    .slice(0, MAX_SLUG_LENGTH)
}

export function formatStatsFooter(stats: Stats): string {
  const parts: string[] = []

  if (stats.sessionName) parts.push(`**session:** ${stats.sessionName}`)
  if (stats.model) parts.push(`**model:** ${stats.model}`)
  parts.push(`**tokens:** ${stats.tokens.total.toLocaleString()} (↑${stats.tokens.input.toLocaleString()} ↓${stats.tokens.output.toLocaleString()})`)
  parts.push(`**cost:** $${stats.cost.toFixed(4)}`)
  if (stats.context.percent !== null) parts.push(`**context:** ${stats.context.percent.toFixed(0)}%`)

  return `\n\\\n\\\n<sub>:mag: &nbsp; ${parts.join(' · ')}</sub>`
}

export function stripFrontmatter(content: string): string {
  if (!content.startsWith('---')) return content
  const end = content.indexOf('\n---', 3)
  if (end === -1) return content
  return content.slice(end + 4).trimStart()
}
