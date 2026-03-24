import { readFileSync } from 'fs'
import type { AuthStorage, ModelRegistry } from '@mariozechner/pi-coding-agent'
import {
  AgentSession,
  createAgentSession,
  DefaultResourceLoader,
  SessionManager,
  SettingsManager,
} from '@mariozechner/pi-coding-agent'
import type { AgentTool } from '@mariozechner/pi-agent-core'
import type { Config } from './config.js'
import { logger } from './logger.js'
import { stripFrontmatter } from './utils.js'
import { resolveModel } from './model.js'

function loadAgentPrompt(agentFilePath: string): string {
  return stripFrontmatter(readFileSync(agentFilePath, 'utf-8'))
}

async function createSession(
  worktreePath: string,
  systemPrompt: string,
  authStorage: AuthStorage,
  modelRegistry: ModelRegistry,
  resolvedModel: any,
  piConfigDir: string,
  customTools: AgentTool<any>[]
): Promise<AgentSession> {
  const settingsManager = SettingsManager.inMemory({
    compaction: { enabled: false },
    retry: { enabled: true, maxRetries: 2 },
  })

  const loader = new DefaultResourceLoader({
    cwd: worktreePath,
    agentDir: piConfigDir,
    settingsManager,
    systemPromptOverride: () => systemPrompt,
    agentsFilesOverride: () => ({ agentsFiles: [] }),
  })
  await loader.reload()

  const { session } = await createAgentSession({
    cwd: worktreePath,
    model: resolvedModel,
    authStorage,
    modelRegistry,
    resourceLoader: loader,
    sessionManager: SessionManager.inMemory(),
    settingsManager,
    tools: [],
    customTools: customTools as any[],
  })

  return session
}

async function runSessionAndCollectOutput(
  session: AgentSession,
  agentName: string,
  promptInput: string
): Promise<string> {
  const allText: string[] = []
  const bufferParts: string[] = []
  session.subscribe((event) => {
    if (event.type === 'message_update' && event.assistantMessageEvent.type === 'text_delta') {
      bufferParts.push(event.assistantMessageEvent.delta)
    }
    if (event.type === 'tool_execution_start') {
      logger.info({ agent: agentName, tool: event.toolName, args: JSON.stringify(event.args).slice(0, 200) }, 'tool execution')
    }
    if (event.type === 'message_end') {
      const trimmed = bufferParts.join('').trim()
      bufferParts.length = 0
      if (trimmed) allText.push(trimmed)
    }
  })

  try {
    await session.prompt(promptInput)
  } finally {
    session.dispose()
  }

  return allText.join('\n\n')
}

export async function runSubagent(
  name: string,
  agentFilePath: string,
  model: string,
  input: unknown,
  worktreePath: string,
  config: Config,
  customTools: AgentTool<any>[]
): Promise<string> {
  const systemPrompt = loadAgentPrompt(agentFilePath)
  const { authStorage, modelRegistry, resolvedModel } = resolveModel(config, model)
  const session = await createSession(worktreePath, systemPrompt, authStorage, modelRegistry, resolvedModel, config.piConfigDir, customTools)
  const promptInput = JSON.stringify(input)
  return runSessionAndCollectOutput(session, name, promptInput)
}
