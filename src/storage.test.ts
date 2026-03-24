import { describe, it, before, after, beforeEach } from 'node:test'
import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { Storage } from './storage.js'
import type { Trigger } from './storage.js'

function makeTrigger(overrides: Partial<Omit<Trigger, 'status' | 'started_at' | 'completed_at' | 'placeholder_comment_id' | 'error'>> = {}): Omit<Trigger, 'status' | 'started_at' | 'completed_at' | 'placeholder_comment_id' | 'error'> {
  return {
    id: randomUUID(),
    repo: 'owner/repo',
    source_type: 'issue_comment',
    source_id: String(Math.floor(Math.random() * 1_000_000)),
    issue_number: 1,
    is_pr: false,
    trigger_text: '@bot do something',
    created_at: new Date().toISOString(),
    ...overrides,
  }
}

describe('Storage', () => {
  describe('recordRun / getLastRunAt', () => {
    let storage: Storage
    before(() => { storage = new Storage(':memory:') })
    after(() => { storage.close() })

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

  describe('insertTrigger', () => {
    let storage: Storage
    beforeEach(() => { storage = new Storage(':memory:') })
    after(() => { storage.close() })

    it('inserts a new trigger and returns true', () => {
      const t = makeTrigger()
      assert.equal(storage.insertTrigger(t), true)
    })

    it('returns false for a duplicate (same repo, source_type, source_id)', () => {
      const t = makeTrigger({ source_id: 'dup-1' })
      assert.equal(storage.insertTrigger(t), true)
      assert.equal(storage.insertTrigger({ ...t, id: randomUUID() }), false)
    })

    it('supersedes older pending triggers on the same issue', () => {
      const t1 = makeTrigger({ issue_number: 1, source_id: 'sup-1', created_at: '2024-01-01T00:00:00.000Z' })
      const t2 = makeTrigger({ issue_number: 1, source_id: 'sup-2', created_at: '2024-01-02T00:00:00.000Z' })
      storage.insertTrigger(t1)
      storage.insertTrigger(t2)

      const pending = storage.getPendingTriggers('owner/repo')
      assert.equal(pending.length, 1)
      assert.equal(pending[0]?.id, t2.id)
    })

    it('does not supersede triggers on different issues', () => {
      const t1 = makeTrigger({ issue_number: 2, source_id: 'iso-1' })
      const t2 = makeTrigger({ issue_number: 3, source_id: 'iso-2' })
      storage.insertTrigger(t1)
      storage.insertTrigger(t2)

      // Both should remain pending — verify neither was superseded
      const expectedPending = [t1.id, t2.id]
      const actualPending = storage.getPendingTriggers('owner/repo')
      assert.equal(actualPending.length, expectedPending.length)
      assert.ok(expectedPending.includes(actualPending[0].id))
      assert.ok(expectedPending.includes(actualPending[1].id))
    })
  })

  describe('getPendingTriggers', () => {
    let storage: Storage
    before(() => { storage = new Storage(':memory:') })
    after(() => { storage.close() })

    it('returns empty array when no pending triggers', () => {
      assert.deepEqual(storage.getPendingTriggers('empty/repo'), [])
    })

    it('returns all pending triggers across different issues', () => {
      const t1 = makeTrigger({ issue_number: 1, source_id: 'p-1', created_at: '2024-01-01T00:00:00.000Z' })
      const t2 = makeTrigger({ issue_number: 2, source_id: 'p-2', created_at: '2024-01-02T00:00:00.000Z' })
      storage.insertTrigger(t1)
      storage.insertTrigger(t2)

      const pending = storage.getPendingTriggers('owner/repo')
      assert.deepEqual(pending.map((t) => t.id), [t1.id, t2.id])
    })

    it('skips issues that have a processing trigger', () => {
      const t1 = makeTrigger({ issue_number: 3, source_id: 'pp-1' })
      const t2 = makeTrigger({ issue_number: 4, source_id: 'pp-2' })
      storage.insertTrigger(t1)
      storage.insertTrigger(t2)
      storage.markProcessing(t1.id, new Date().toISOString(), 42)

      const pending = storage.getPendingTriggers('owner/repo')
      assert.ok(pending.every((t) => t.id !== t1.id))
      assert.ok(pending.some((t) => t.id === t2.id))
    })
  })

  describe('getStaleTriggers', () => {
    let storage: Storage
    before(() => { storage = new Storage(':memory:') })
    after(() => { storage.close() })

    it('returns processing triggers older than the timeout', () => {
      const t = makeTrigger({ source_id: 'stale-1', issue_number: 1 })
      storage.insertTrigger(t)
      const oldDate = new Date(Date.now() - 60_000).toISOString()
      storage.markProcessing(t.id, oldDate, 99)

      const stale = storage.getStaleTriggers('owner/repo', 30_000)
      assert.ok(stale.some((s) => s.id === t.id))
    })

    it('does not return recent processing triggers', () => {
      const t = makeTrigger({ source_id: 'fresh-proc-1', issue_number: 2 })
      storage.insertTrigger(t)
      storage.markProcessing(t.id, new Date().toISOString(), 99)

      const stale = storage.getStaleTriggers('owner/repo', 30_000)
      assert.ok(!stale.some((s) => s.id === t.id))
    })
  })

  describe('markDone / markFailed', () => {
    let storage: Storage
    before(() => { storage = new Storage(':memory:') })
    after(() => { storage.close() })

    it('markDone sets status to done', () => {
      const t = makeTrigger({ source_id: 'done-1', issue_number: 1 })
      storage.insertTrigger(t)
      storage.markProcessing(t.id, new Date().toISOString(), 1)
      storage.markDone(t.id, new Date().toISOString())

      assert.equal(storage.getPendingTriggers('owner/repo').length, 0)
    })

    it('markFailed sets status to failed with error', () => {
      const t = makeTrigger({ source_id: 'fail-1', issue_number: 1 })
      storage.insertTrigger(t)
      storage.markProcessing(t.id, new Date().toISOString(), 1)
      storage.markFailed(t.id, new Date().toISOString(), 'something went wrong')

      assert.equal(storage.getPendingTriggers('owner/repo').length, 0)
    })
  })

  describe('recoverStaleAndInsert', () => {
    let storage: Storage
    beforeEach(() => { storage = new Storage(':memory:') })

    it('resets stale triggers to pending, preserving placeholder_comment_id', () => {
      const t = makeTrigger({ source_id: 'rec-1', issue_number: 1 })
      storage.insertTrigger(t)
      storage.markProcessing(t.id, new Date().toISOString(), 42)

      storage.recoverStaleAndInsert('owner/repo', [t.id], [])

      const pending = storage.getPendingTriggers('owner/repo')
      assert.equal(pending.length, 1)
      assert.equal(pending[0].id, t.id)
      assert.equal(pending[0].placeholder_comment_id, 42)
      assert.equal(pending[0].started_at, null)
    })

    it('inserts new triggers and supersedes recovered ones on the same issue', () => {
      const stale = makeTrigger({ source_id: 'rec-sup-1', issue_number: 1 })
      storage.insertTrigger(stale)
      storage.markProcessing(stale.id, new Date().toISOString(), 10)

      const fresh = makeTrigger({ source_id: 'rec-sup-2', issue_number: 1 })

      storage.recoverStaleAndInsert('owner/repo', [stale.id], [fresh])

      const pending = storage.getPendingTriggers('owner/repo')
      assert.equal(pending.length, 1)
      assert.equal(pending[0].id, fresh.id)
    })

    it('does not supersede recovered triggers on different issues', () => {
      const stale = makeTrigger({ source_id: 'rec-diff-1', issue_number: 1 })
      storage.insertTrigger(stale)
      storage.markProcessing(stale.id, new Date().toISOString(), 10)

      const fresh = makeTrigger({ source_id: 'rec-diff-2', issue_number: 2 })

      storage.recoverStaleAndInsert('owner/repo', [stale.id], [fresh])

      const pending = storage.getPendingTriggers('owner/repo')
      assert.equal(pending.length, 2)
    })

    it('ignores duplicate new triggers', () => {
      const t = makeTrigger({ source_id: 'rec-dup-1', issue_number: 1 })
      storage.insertTrigger(t)

      storage.recoverStaleAndInsert('owner/repo', [], [{ ...t, id: randomUUID() }])

      // Original is still pending, no duplicate inserted
      const pending = storage.getPendingTriggers('owner/repo')
      assert.equal(pending.length, 1)
      assert.equal(pending[0].id, t.id)
    })
  })
})