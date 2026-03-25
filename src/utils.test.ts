import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { slugify, stripFrontmatter } from './utils.js'

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
