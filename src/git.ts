import { existsSync } from 'fs'
import * as path from 'path'
import { simpleGit, ResetMode } from 'simple-git'
import { logger } from './logger.js'

export async function cloneOrFetch(repo: string, workDir: string, branch: string, token: string): Promise<void> {
  const url = `https://github.com/${repo}.git`
  const gitDir = path.join(workDir, '.git')
  const basicAuth = Buffer.from(`x-access-token:${token}`).toString('base64')
  const gitConfig = [`http.extraHeader=Authorization: Basic ${basicAuth}`]

  if (!existsSync(gitDir)) {
    logger.info({ repo, dir: workDir }, 'Cloning repo')
    await simpleGit({ config: gitConfig }).clone(url, workDir)
    return
  }

  const git = simpleGit({ baseDir: workDir, config: gitConfig })
  logger.info({ repo }, 'Fetching latest changes')
  await git.fetch(['--prune'])
  await git.reset(ResetMode.HARD, [`origin/${branch}`])
}
