import { describe, it, before, after } from 'node:test'
import assert from 'node:assert/strict'
import { Storage } from './storage.js'

describe('Storage', () => {
  let storage: Storage

  before(() => {
    storage = new Storage(':memory:')
  })

  after(() => {
    storage.close()
  })

  describe('upsertIssue / getIssue', () => {
    it('inserts a new issue', () => {
      storage.upsertIssue('owner/repo', { number: 1, title: 'Bug', body: 'details' })
      const issue = storage.getIssue('owner/repo', 1)
      assert.ok(issue)
      assert.equal(issue.repo, 'owner/repo')
      assert.equal(issue.number, 1)
      assert.equal(issue.title, 'Bug')
      assert.equal(issue.body, 'details')
      assert.equal(issue.body_scanned, 0)
    })

    it('updates title and body on conflict', () => {
      storage.upsertIssue('owner/repo', { number: 1, title: 'Bug v2', body: 'new details' })
      const issue = storage.getIssue('owner/repo', 1)
      assert.ok(issue)
      assert.equal(issue.title, 'Bug v2')
      assert.equal(issue.body, 'new details')
    })

    it('returns null for a missing issue', () => {
      assert.equal(storage.getIssue('owner/repo', 9999), null)
    })

    it('handles null body', () => {
      storage.upsertIssue('owner/repo', { number: 2, title: 'No body', body: null })
      const issue = storage.getIssue('owner/repo', 2)
      assert.ok(issue)
      assert.equal(issue.body, null)
    })
  })

  describe('getUnscannedIssues', () => {
    it('returns only unscanned issues for the repo', () => {
      storage.upsertIssue('other/repo', { number: 10, title: 'Other', body: null })
      const unscanned = storage.getUnscannedIssues('owner/repo')
      assert.ok(unscanned.every(i => i.repo === 'owner/repo'))
      assert.ok(unscanned.every(i => i.body_scanned === 0))
      assert.ok(unscanned.some(i => i.number === 1))
      assert.ok(unscanned.some(i => i.number === 2))
    })
  })

  describe('markBodyScanned', () => {
    it('marks an issue as scanned', () => {
      storage.markBodyScanned('owner/repo', 1)
      const issue = storage.getIssue('owner/repo', 1)
      assert.ok(issue)
      assert.equal(issue.body_scanned, 1)
    })

    it('excludes scanned issues from getUnscannedIssues', () => {
      const unscanned = storage.getUnscannedIssues('owner/repo')
      assert.ok(unscanned.every(i => i.number !== 1))
    })
  })

  describe('logRun / getLastRunAt', () => {
    it('returns a date ~1 year ago when no runs exist', () => {
      const lastRun = new Date(storage.getLastRunAt('fresh/repo'))
      const oneYearAgo = new Date()
      oneYearAgo.setFullYear(oneYearAgo.getFullYear() - 1)
      assert.ok(Math.abs(lastRun.getTime() - oneYearAgo.getTime()) < 5000)
    })

    it('returns the most recent run timestamp', () => {
      const t1 = '2024-01-01T00:00:00.000Z'
      const t2 = '2024-06-01T00:00:00.000Z'
      storage.logRun('owner/repo', t1)
      storage.logRun('owner/repo', t2)
      assert.equal(storage.getLastRunAt('owner/repo'), t2)
    })

    it('isolates runs by repo', () => {
      storage.logRun('other/repo', '2020-01-01T00:00:00.000Z')
      assert.equal(storage.getLastRunAt('owner/repo'), '2024-06-01T00:00:00.000Z')
    })
  })
})