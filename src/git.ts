import { existsSync } from 'fs'
import * as path from 'path'
import { simpleGit, ResetMode } from 'simple-git'
import { logger } from './logger.js'

function encodeToken(token: string) {
  const basic = Buffer.from(`x-access-token:${token}`).toString('base64')
  return {
    header: `Authorization: Basic ${basic}`,
    // Leading empty value clears any auth from credential helpers before setting ours
    config: ['http.extraHeader=', `http.extraHeader=Authorization: Basic ${basic}`],
  }
}

export async function cloneOrFetch(repo: string, workDir: string, branch: string, token: string): Promise<void> {
  const url = `https://github.com/${repo}.git`
  const gitDir = path.join(workDir, '.git')
  const { config } = encodeToken(token)

  if (!existsSync(gitDir)) {
    logger.info({ repo, dir: workDir }, 'Cloning repo')
    await simpleGit({ config }).clone(url, workDir)
    return
  }

  const git = simpleGit({ baseDir: workDir, config })
  logger.info({ repo }, 'Fetching latest changes')
  await git.fetch(['--prune'])
  await git.reset(ResetMode.HARD, [`origin/${branch}`])
}

export async function createWorktree(repoDir: string, worktreePath: string, branch: string, token: string): Promise<void> {
  const { config, header } = encodeToken(token)
  const git = simpleGit({ baseDir: repoDir, config })

  // Clean up any leftover worktree from a previous failed run before creating
  await git.raw(['worktree', 'remove', '--force', worktreePath]).catch(() => {})

  // -B creates the branch if new, or resets it to HEAD if it already exists
  await git.raw(['worktree', 'add', '-B', branch, worktreePath])

  // Bake auth into the worktree's local git config so the agent can push without needing the token.
  // Empty string first clears any auth from credential helpers, then sets ours.
  const worktreeGit = simpleGit({ baseDir: worktreePath })
  await worktreeGit.raw(['config', '--replace-all', 'http.extraHeader', ''])
  await worktreeGit.raw(['config', '--add', 'http.extraHeader', header])

  logger.info({ branch, worktreePath }, 'Created worktree')
}

export async function removeWorktree(repoDir: string, worktreePath: string): Promise<void> {
  const git = simpleGit({ baseDir: repoDir })
  await git.raw(['worktree', 'remove', '--force', worktreePath])
  logger.info({ worktreePath }, 'Removed worktree')
}
