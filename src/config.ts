import { join, dirname } from 'path'
import { fileURLToPath } from 'url'

// Directory containing this module, used to resolve default agents directory
const moduleDir = dirname(fileURLToPath(import.meta.url))

const DEFAULT_BASE_MODEL = 'minimax/minimax-m2.5'
const DEFAULT_TRIGGER_WORD = '@kronk-bot'
const DEFAULT_POLL_INTERVAL_SEC = 60
const DEFAULT_PROCESSING_TIMEOUT_SEC = 900
const DEFAULT_DB_PATH = '/data/db.sqlite'
const DEFAULT_PI_CONFIG_DIR = '/data/pi-config'
const DEFAULT_WORK_DIR = '/data/workspace'
const ESCAPED_NEWLINE_PATTERN = /\\n/g

/**
 * Application configuration loaded from environment variables.
 * All environment-based configuration is centralized here.
 */
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

/**
 * Loads and validates configuration from environment variables.
 * Throws if any required variable is missing.
 */
export function loadConfig(): Config {
  const baseModel = process.env.MODEL ?? DEFAULT_BASE_MODEL

  return {
    githubAppId: getRequiredEnvVar('GITHUB_APP_ID'),
    githubAppPrivateKey: getRequiredEnvVar('GITHUB_APP_PRIVATE_KEY').replace(ESCAPED_NEWLINE_PATTERN, '\n'),
    openrouterApiKey: getRequiredEnvVar('OPENROUTER_API_KEY'),
    baseModel,
    agentModel: process.env.AGENT_MODEL ?? baseModel,
    triggerWord: process.env.TRIGGER_WORD ?? DEFAULT_TRIGGER_WORD,
    allowedUsers: parseAllowedUsers(process.env.ALLOWED_USERS),
    dbPath: process.env.DB_PATH ?? DEFAULT_DB_PATH,
    pollInterval: parseSecondsToMs(process.env.POLL_INTERVAL, DEFAULT_POLL_INTERVAL_SEC),
    processingTimeout: parseSecondsToMs(process.env.PROCESSING_TIMEOUT, DEFAULT_PROCESSING_TIMEOUT_SEC),
    piConfigDir: process.env.PI_CONFIG_DIR ?? DEFAULT_PI_CONFIG_DIR,
    workDir: process.env.WORK_DIR ?? DEFAULT_WORK_DIR,
    agentsDir: process.env.AGENTS_DIR ?? join(moduleDir, '..', 'agents'),
  }
}

function parseAllowedUsers(input: string | undefined): string[] {
  if (!input) return []
  return input
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean)
}

function parseSecondsToMs(input: string | undefined, defaultSeconds: number): number {
  const seconds = input ? parseInt(input, 10) : defaultSeconds
  return seconds * 1000
}

function getRequiredEnvVar(key: string): string {
  const val = process.env[key]
  if (!val) throw new Error(`Missing required env var: ${key}`)
  return val
}
