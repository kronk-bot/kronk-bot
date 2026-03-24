import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { slugify, stripFrontmatter, formatStatsFooter } from './utils.js'

describe('slugify', () => {
  it('lowercases and replaces spaces with hyphens', () => {
    assert.equal(slugify('Add age to user'), 'add-age-to-user')
  })

  it('collapses multiple non-alphanumeric chars into one hyphen', () => {
    assert.equal(slugify('Fix bug: crash on load!'), 'fix-bug-crash-on-load')
  })

  it('strips leading and trailing hyphens', () => {
    assert.equal(slugify('  hello world  '), 'hello-world')
  })

  it('truncates to 50 characters', () => {
    const long = 'a'.repeat(60)
    assert.equal(slugify(long).length, 50)
  })

  it('handles empty string', () => {
    assert.equal(slugify(''), '')
  })
})

describe('stripFrontmatter', () => {
  it('returns content unchanged when no frontmatter', () => {
    assert.equal(stripFrontmatter('hello world'), 'hello world')
  })

  it('returns content unchanged when starts with --- but no closing ---', () => {
    const content = '---\ntitle: foo\n'
    assert.equal(stripFrontmatter(content), content)
  })

  it('strips frontmatter and trims leading whitespace from body', () => {
    const content = '---\ntitle: foo\nauthor: bar\n---\n\nHello world'
    assert.equal(stripFrontmatter(content), 'Hello world')
  })

  it('strips frontmatter with no body', () => {
    const content = '---\ntitle: foo\n---\n'
    assert.equal(stripFrontmatter(content), '')
  })

  it('strips frontmatter when body starts immediately after closing ---', () => {
    const content = '---\nfoo: bar\n---\nNo leading newline'
    assert.equal(stripFrontmatter(content), 'No leading newline')
  })

  it('returns empty string unchanged', () => {
    assert.equal(stripFrontmatter(''), '')
  })
})

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
    assert.ok(footer.includes('<sub>:mag:'))
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