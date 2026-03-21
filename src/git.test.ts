import { describe, it, mock, beforeEach } from 'node:test'
import assert from 'node:assert/strict'
import { ResetMode } from 'simple-git'

// --- mock fns ---
const mockClone = mock.fn(async () => {})
const mockFetch = mock.fn(async () => {})
const mockReset = mock.fn(async () => {})
const mockGitInstance = { clone: mockClone, fetch: mockFetch, reset: mockReset }
const mockSimpleGit = mock.fn(() => mockGitInstance as any)

let existsSyncResult = false
const mockExistsSync = mock.fn(() => existsSyncResult)

mock.module('simple-git', { namedExports: { simpleGit: mockSimpleGit, ResetMode } })
mock.module('fs', { namedExports: { existsSync: mockExistsSync } })
mock.module('./logger.js', {
  namedExports: { logger: { info: () => {}, error: () => {}, warn: () => {}, debug: () => {} } },
})

const { cloneOrFetch } = await import('./git.js')

describe('cloneOrFetch', () => {
  beforeEach(() => {
    mockClone.mock.resetCalls()
    mockFetch.mock.resetCalls()
    mockReset.mock.resetCalls()
    mockSimpleGit.mock.resetCalls()
    mockExistsSync.mock.resetCalls()
  })

  describe('when .git does not exist', () => {
    it('clones with the public URL and injects auth via extraHeader', async () => {
      existsSyncResult = false
      await cloneOrFetch('owner/repo', '/work', 'main', 'tok123')

      assert.equal(mockClone.mock.calls.length, 1)
      const [url, workDir] = mockClone.mock.calls[0].arguments as unknown as [string, string]
      assert.equal(url, 'https://github.com/owner/repo.git')
      assert.equal(workDir, '/work')

      const opts = (mockSimpleGit.mock.calls[0].arguments as unknown as [{ config: string[] }])[0]
      assert.ok(opts.config.some((c) => c.includes('Authorization: Basic ')))
    })

    it('does not fetch or reset', async () => {
      existsSyncResult = false
      await cloneOrFetch('owner/repo', '/work', 'main', 'tok123')

      assert.equal(mockFetch.mock.calls.length, 0)
      assert.equal(mockReset.mock.calls.length, 0)
    })
  })

  describe('when .git exists', () => {
    it('does not clone', async () => {
      existsSyncResult = true
      await cloneOrFetch('owner/repo', '/work', 'main', 'tok123')

      assert.equal(mockClone.mock.calls.length, 0)
    })

    it('injects auth via extraHeader config', async () => {
      existsSyncResult = true
      await cloneOrFetch('owner/repo', '/work', 'main', 'tok123')

      const opts = (mockSimpleGit.mock.calls[0].arguments as unknown as [{ config: string[] }])[0]
      assert.ok(opts.config.some((c) => c.includes('Authorization: Basic ')))
    })

    it('fetches with --prune', async () => {
      existsSyncResult = true
      await cloneOrFetch('owner/repo', '/work', 'main', 'tok123')

      const fetchArgs = mockFetch.mock.calls[0].arguments as unknown as [string[]]
      assert.equal(mockFetch.mock.calls.length, 1)
      assert.deepEqual(fetchArgs[0], ['--prune'])
    })

    it('hard resets to origin/<branch>', async () => {
      existsSyncResult = true
      await cloneOrFetch('owner/repo', '/work', 'develop', 'tok456')

      const resetArgs = mockReset.mock.calls[0].arguments as unknown as [string, string[]]
      assert.equal(mockReset.mock.calls.length, 1)
      assert.equal(resetArgs[0], ResetMode.HARD)
      assert.deepEqual(resetArgs[1], ['origin/develop'])
    })

    it('passes workDir to simpleGit', async () => {
      existsSyncResult = true
      await cloneOrFetch('owner/repo', '/my/work', 'main', 'tok123')

      const opts = (mockSimpleGit.mock.calls[0].arguments as unknown as [{ baseDir: string }])[0]
      assert.equal(opts.baseDir, '/my/work')
    })
  })
})
