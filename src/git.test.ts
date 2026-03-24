import { describe, it, mock, beforeEach } from 'node:test'
import assert from 'node:assert/strict'
import { ResetMode } from 'simple-git'

// --- mock fns ---
const mockClone = mock.fn(async () => {})
const mockFetch = mock.fn(async () => {})
const mockReset = mock.fn(async () => {})
const mockRaw = mock.fn(async () => {})
const mockAddConfig = mock.fn(async () => {})
const mockAdd = mock.fn(async () => {})
const mockStatus = mock.fn(async () => ({ staged: [] }))
const mockCommit = mock.fn(async () => {})
const mockPush = mock.fn(async () => {})
const mockRevparse = mock.fn(async () => 'kronk/42-fix-bug')
const mockGitInstance = { clone: mockClone, fetch: mockFetch, reset: mockReset, raw: mockRaw, addConfig: mockAddConfig, add: mockAdd, status: mockStatus, commit: mockCommit, push: mockPush, revparse: mockRevparse }
const mockSimpleGit = mock.fn(() => mockGitInstance as any)

let existsSyncResult = false
const mockExistsSync = mock.fn(() => existsSyncResult)

mock.module('simple-git', { namedExports: { simpleGit: mockSimpleGit, ResetMode } })
mock.module('fs', { namedExports: { existsSync: mockExistsSync } })
mock.module('./logger.js', {
  namedExports: { logger: { info: () => {}, error: () => {}, warn: () => {}, debug: () => {} } },
})

const { cloneOrFetch, createWorktree, removeWorktree, commitAndPush, getCurrentBranch } = await import('./git.js')

function resetAllMocks() {
  mockClone.mock.resetCalls()
  mockFetch.mock.resetCalls()
  mockReset.mock.resetCalls()
  mockRaw.mock.resetCalls()
  mockAddConfig.mock.resetCalls()
  mockAdd.mock.resetCalls()
  mockStatus.mock.resetCalls()
  mockCommit.mock.resetCalls()
  mockPush.mock.resetCalls()
  mockRevparse.mock.resetCalls()
  mockSimpleGit.mock.resetCalls()
  mockExistsSync.mock.resetCalls()
}

describe('cloneOrFetch', () => {
  beforeEach(() => {
    resetAllMocks()
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

describe('createWorktree', () => {
  beforeEach(() => resetAllMocks())

  it('removes any existing worktree then creates with -B', async () => {
    await createWorktree('/repo', '/repo/worktrees/42', 'kronk/42-fix-bug', 'tok')

    const removeCall = mockRaw.mock.calls.find(
      (c) => (c.arguments.at(0) as unknown as string[])?.[1] === 'remove'
    )
    assert.ok(removeCall, 'expected a worktree remove call before add')
    assert.deepEqual(removeCall.arguments.at(0), ['worktree', 'remove', '--force', '/repo/worktrees/42'])

    const addCall = mockRaw.mock.calls.find(
      (c) => (c.arguments.at(0) as unknown as string[])?.[1] === 'add'
    )
    assert.ok(addCall, 'expected a worktree add call')
    assert.deepEqual(addCall.arguments.at(0), ['worktree', 'add', '-B', 'kronk/42-fix-bug', '/repo/worktrees/42'])
  })

  it('appends startPoint to the worktree add command when provided', async () => {
    await createWorktree('/repo', '/repo/worktrees/42', 'feat/my-pr', 'tok', 'origin/feat/my-pr')

    const addCall = mockRaw.mock.calls.find(
      (c) => (c.arguments.at(0) as unknown as string[])?.[1] === 'add'
    )
    assert.ok(addCall, 'expected a worktree add call')
    assert.deepEqual(addCall.arguments.at(0), ['worktree', 'add', '-B', 'feat/my-pr', '/repo/worktrees/42', 'origin/feat/my-pr'])
  })

  it('configures http.extraHeader auth in the worktree', async () => {
    await createWorktree('/repo', '/repo/worktrees/42', 'kronk/42-fix-bug', 'tok123')

    const configCalls = mockRaw.mock.calls.filter(
      (c) => (c.arguments.at(0) as unknown as string[])?.[0] === 'config'
    )
    // First call clears existing headers, second adds ours
    const clearCall = configCalls.find((c) => {
      const args = c.arguments.at(0) as unknown as string[]
      return args[1] === '--replace-all' && args[3] === ''
    })
    const setCall = configCalls.find((c) => {
      const args = c.arguments.at(0) as unknown as string[]
      return args[1] === '--add' && args[3]?.includes('Authorization: Basic ')
    })
    assert.ok(clearCall, 'expected a config call to clear existing auth headers')
    assert.ok(setCall, 'expected a config call to set Authorization header')
  })

  it('injects auth via extraHeader config on the base repo git instance', async () => {
    await createWorktree('/repo', '/repo/worktrees/42', 'kronk/42-fix-bug', 'tok123')

    const repoGitCall = mockSimpleGit.mock.calls.find(
      (c) => (c.arguments as any[])[0]?.baseDir === '/repo'
    )
    assert.ok(repoGitCall, 'expected a simpleGit call with baseDir /repo')
    assert.ok(
      (repoGitCall.arguments as any[])[0].config?.some((c: string) => c.includes('Authorization: Basic ')),
      'expected auth header in repo git config'
    )
  })
})

describe('removeWorktree', () => {
  beforeEach(() => resetAllMocks())

  it('calls git worktree remove --force with the path', async () => {
    await removeWorktree('/repo', '/repo/worktrees/42')

    assert.equal(mockRaw.mock.calls.length, 1)
    const args = mockRaw.mock.calls[0].arguments.at(0) as unknown as string[]
    assert.deepEqual(args, ['worktree', 'remove', '--force', '/repo/worktrees/42'])
  })

  it('does not require a token', async () => {
    // removeWorktree is a local git operation — signature has no token param
    await assert.doesNotReject(() => removeWorktree('/repo', '/repo/worktrees/42'))
  })
})

describe('getCurrentBranch', () => {
  beforeEach(() => {
    resetAllMocks()
    mockRevparse.mock.mockImplementation(async () => '  kronk/42-fix-bug  \n')
  })

  it('creates simpleGit with the worktreePath', async () => {
    await getCurrentBranch('/repo/worktrees/42')

    const opts = (mockSimpleGit.mock.calls[0].arguments as unknown as [{ baseDir: string }])[0]
    assert.equal(opts.baseDir, '/repo/worktrees/42')
  })

  it('calls revparse with --abbrev-ref HEAD', async () => {
    await getCurrentBranch('/repo/worktrees/42')

    assert.equal(mockRevparse.mock.calls.length, 1)
    assert.deepEqual(mockRevparse.mock.calls[0].arguments, [['--abbrev-ref', 'HEAD']])
  })

  it('trims whitespace from the branch name', async () => {
    const branch = await getCurrentBranch('/repo/worktrees/42')
    assert.equal(branch, 'kronk/42-fix-bug')
  })
})

describe('commitAndPush', () => {
  beforeEach(() => {
    resetAllMocks()
    mockStatus.mock.mockImplementation(async () => ({ staged: ['src/file.ts'] as never[] }))
  })

  it('creates simpleGit with the worktreePath', async () => {
    await commitAndPush('/repo/worktrees/42', 'fix: something', 42)

    const opts = (mockSimpleGit.mock.calls[0].arguments as unknown as [{ baseDir: string }])[0]
    assert.equal(opts.baseDir, '/repo/worktrees/42')
  })

  it('sets bot user.name and user.email via addConfig', async () => {
    await commitAndPush('/repo/worktrees/42', 'fix: something', 42)

    assert.equal(mockAddConfig.mock.calls.length, 2)
    assert.deepEqual(mockAddConfig.mock.calls[0].arguments, ['user.email', 'kronk-bot@users.noreply.github.com'])
    assert.deepEqual(mockAddConfig.mock.calls[1].arguments, ['user.name', 'kronk-bot'])
  })

  it('stages all files with git add .', async () => {
    await commitAndPush('/repo/worktrees/42', 'fix: something', 42)

    assert.equal(mockAdd.mock.calls.length, 1)
    assert.deepEqual(mockAdd.mock.calls[0].arguments, ['.'])
  })

  it('commits with the given message when there are staged files', async () => {
    await commitAndPush('/repo/worktrees/42', 'fix: something', 42)

    assert.equal(mockCommit.mock.calls.length, 1)
    assert.deepEqual(mockCommit.mock.calls[0].arguments, ['fix: something'])
  })

  it('skips commit when no files are staged', async () => {
    mockStatus.mock.mockImplementation(async () => ({ staged: [] }))

    await commitAndPush('/repo/worktrees/42', 'fix: something', 42)

    assert.equal(mockCommit.mock.calls.length, 0)
  })

  it('pushes to origin with --set-upstream', async () => {
    await commitAndPush('/repo/worktrees/42', 'fix: something', 42)

    assert.equal(mockPush.mock.calls.length, 1)
    assert.deepEqual(mockPush.mock.calls[0].arguments, ['origin', 'HEAD', ['--set-upstream']])
  })

  it('pushes even when there are no staged changes', async () => {
    mockStatus.mock.mockImplementation(async () => ({ staged: [] }))

    await commitAndPush('/repo/worktrees/42', 'fix: something', 42)

    assert.equal(mockPush.mock.calls.length, 1)
  })
})
