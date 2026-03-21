import { existsSync } from 'fs'
import * as path from 'path'
import { simpleGit, ResetMode } from 'simple-git'
import type { Config } from './config.js'
import { logger } from './logger.js'

async function authUrl(getToken: () => Promise<string>, repo: string): Promise<string> {
  const token = await getToken()
  return `https://x-access-token:${token}@github.com/${repo}.git`
}

export async function cloneOrFetch(config: Config, repo: string, workDir: string, branch: string, getToken: () => Promise<string>): Promise<void> {
  const url = await authUrl(getToken, repo)
  const gitDir = path.join(workDir, '.git')

  if (!existsSync(gitDir)) {
    logger.info({ repo, dir: workDir }, 'Cloning repo')
    await simpleGit().clone(url, workDir)
  } else {
    const git = simpleGit(workDir)
    await git.remote(['set-url', 'origin', url])
    logger.info({ repo }, 'Fetching latest changes')
    await git.fetch(['--prune'])
    await git.reset(ResetMode.HARD, [`origin/${branch}`])
  }
}
