import { existsSync } from 'fs'
import * as path from 'path'
import { simpleGit, ResetMode } from 'simple-git'
import type { Config } from './config.js'
import { logger } from './logger.js'

export async function cloneOrFetch(
  repo: string,
  workDir: string,
  branch: string,
  token: string
): Promise<void> {
  const url = `https://x-access-token:${token}@github.com/${repo}.git`
  const gitDir = path.join(workDir, '.git')

  if (!existsSync(gitDir)) {
    logger.info({ repo, dir: workDir }, 'Cloning repo')
    await simpleGit().clone(url, workDir)
    return
  }

  const git = simpleGit(workDir)
  await git.remote(['set-url', 'origin', url])
  logger.info({ repo }, 'Fetching latest changes')
  await git.fetch(['--prune'])
  await git.reset(ResetMode.HARD, [`origin/${branch}`])
}
