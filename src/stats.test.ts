import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { formatStatsFooter } from './stats.js'

describe('formatStatsFooter', () => {
  const baseStats = {
    tokens: { input: 1000, output: 500, total: 1500 },
    cost: 0.0123,
    context: { percent: 42 },
  }

  it('includes model when provided', () => {
    const footer = formatStatsFooter({ ...baseStats, model: 'openai/gpt-4' })
    assert.ok(footer.includes('**model:** openai/gpt-4'))
  })

  it('omits model when not provided', () => {
    const footer = formatStatsFooter(baseStats)
    assert.ok(!footer.includes('**model:**'))
  })

  it('includes session name when provided', () => {
    const footer = formatStatsFooter({ ...baseStats, sessionName: 'fix-auth' })
    assert.ok(footer.includes('**session:** fix-auth'))
  })

  it('omits session name when not provided', () => {
    const footer = formatStatsFooter(baseStats)
    assert.ok(!footer.includes('**session:**'))
  })

  it('formats token counts with locale separators', () => {
    const footer = formatStatsFooter(baseStats)
    assert.ok(footer.includes('**tokens:** 1,500'))
    assert.ok(footer.includes('↑1,000'))
    assert.ok(footer.includes('↓500'))
  })

  it('formats cost with 4 decimal places', () => {
    const footer = formatStatsFooter(baseStats)
    assert.ok(footer.includes('**cost:** $0.0123'))
  })

  it('includes context percentage when not null', () => {
    const footer = formatStatsFooter(baseStats)
    assert.ok(footer.includes('**context:** 42%'))
  })

  it('omits context percentage when null', () => {
    const footer = formatStatsFooter({ ...baseStats, context: { percent: null } })
    assert.ok(!footer.includes('**context:**'))
  })

  it('returns a GitHub-compatible sub tag', () => {
    const footer = formatStatsFooter({ ...baseStats, model: 'test' })
    assert.ok(footer.includes('<sub>'))
    assert.ok(footer.includes('</sub>'))
  })

  it('joins parts with · separator', () => {
    const footer = formatStatsFooter({ ...baseStats, model: 'm', sessionName: 's' })
    assert.ok(footer.includes(' · '))
  })

  it('uses GitHub line breaks (backslash backslash newline)', () => {
    const footer = formatStatsFooter(baseStats)
    assert.ok(footer.startsWith('\n\\\n\\\n'))
  })
})
