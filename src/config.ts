import { join, dirname } from 'path'
import { fileURLToPath } from 'url'

const __dirname = dirname(fileURLToPath(import.meta.url))

export interface Config {
  githubAppId: string
  githubAppPrivateKey: string
  openrouterApiKey: string
  baseModel: string
  agentModel: string
  triggerWord: string
  allowedUsers: string[]
  dbPath: string
  pollInterval: number
  processingTimeout: number
  piConfigDir: string
  workDir: string
  agentsDir: string
}

function required(key: string): string {
  const val = process.env[key]
  if (!val) throw new Error(`Missing required env var: ${key}`)
  return val
}

export function loadConfig(): Config {
  const baseModel = process.env.MODEL ?? 'minimax/minimax-m2.5'

  return {
    githubAppId: required('GITHUB_APP_ID'),
    githubAppPrivateKey: required('GITHUB_APP_PRIVATE_KEY').replace(/\\n/g, '\n'),
    openrouterApiKey: required('OPENROUTER_API_KEY'),
    baseModel,
    agentModel: process.env.AGENT_MODEL || baseModel,
    triggerWord: process.env.TRIGGER_WORD ?? '@kronk-bot',
    allowedUsers: process.env.ALLOWED_USERS
      ? process.env.ALLOWED_USERS.split(',')
          .map((s) => s.trim())
          .filter(Boolean)
      : [],
    dbPath: process.env.DB_PATH ?? '/data/db.sqlite',
    pollInterval: parseInt(process.env.POLL_INTERVAL ?? '60', 10) * 1000,
    processingTimeout: parseInt(process.env.PROCESSING_TIMEOUT ?? '900', 10) * 1000,
    piConfigDir: process.env.PI_CONFIG_DIR ?? '/data/pi-config',
    workDir: process.env.WORK_DIR ?? '/data/workspace',
    agentsDir: process.env.AGENTS_DIR ?? join(__dirname, '..', 'agents'),
  }
}
