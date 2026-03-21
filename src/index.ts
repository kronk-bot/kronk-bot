import { mkdirSync } from 'fs'
import { join } from 'path'
import { loadConfig } from './config.js'
import { logger } from './logger.js'
import { GithubAppClient } from './github.js'
import { Storage } from './storage.js'
import { pollCycle } from './loop.js'

async function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

async function main(): Promise<void> {
  const config = loadConfig()

  mkdirSync(config.piConfigDir, { recursive: true })
  mkdirSync(config.workDir, { recursive: true })

  const appClient = new GithubAppClient(config)
  const storage = new Storage(config.dbPath)

  const botLogin = await appClient.getBotLogin()

  logger.info(
    {
      model: config.orchestratorModel,
      pollIntervalSec: config.pollInterval / 1000,
      triggerWord: config.triggerWord,
      bot: botLogin,
    },
    'kronk-pull starting'
  )

  let running = true
  const shutdown = (): void => {
    logger.info('Shutting down...')
    running = false
  }
  process.on('SIGINT', shutdown)
  process.on('SIGTERM', shutdown)

  while (running) {
    try {
      const installations = await appClient.listAllInstallations()
      logger.info({ repos: installations.map((i) => i.fullName) }, 'discovered repos')

      for (const installation of installations) {
        const repoWorkDir = join(config.workDir, installation.owner, installation.repo)
        mkdirSync(repoWorkDir, { recursive: true })

        const github = await appClient.createRepoClient(installation)
        const ctx = {
          config,
          github,
          storage,
          botLogin,
          getToken: github.getToken.bind(github),
          repoFullName: installation.fullName,
          repoWorkDir,
          repoDefaultBranch: installation.defaultBranch,
        }

        try {
          await pollCycle(ctx)
        } catch (err) {
          logger.error({ repo: installation.fullName, err }, 'Unhandled poll cycle error')
        }
      }
    } catch (err) {
      logger.error({ err }, 'Failed to list installations')
    }

    if (!running) break
    logger.info({ pollIntervalSec: config.pollInterval / 1000 }, 'Next poll')
    await sleep(config.pollInterval)
  }

  storage.close()
  logger.info('kronk-pull stopped')
}

main().catch((err) => {
  logger.error({ err }, 'Fatal error')
  process.exit(1)
})
