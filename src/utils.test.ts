import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { stripFrontmatter } from './utils.js'

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