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

  describe('recordRun / getLastRunAt', () => {
    it('returns a date ~now when no runs exist', () => {
      const before = Date.now()
      const lastRun = new Date(storage.getLastRunAt('fresh/repo'))
      const after = Date.now()
      assert.ok(lastRun.getTime() >= before && lastRun.getTime() <= after)
    })

    it('returns the most recent run timestamp', () => {
      const t1 = '2024-01-01T00:00:00.000Z'
      const t2 = '2024-06-01T00:00:00.000Z'
      storage.recordRun('owner/repo', t1)
      storage.recordRun('owner/repo', t2)
      assert.equal(storage.getLastRunAt('owner/repo'), t2)
    })

    it('isolates runs by repo', () => {
      storage.recordRun('other/repo', '2020-01-01T00:00:00.000Z')
      assert.equal(storage.getLastRunAt('owner/repo'), '2024-06-01T00:00:00.000Z')
    })
  })
})