import { readFileSync } from 'fs'
import {
  createAgentSession,
  DefaultResourceLoader,
  SessionManager,
  SettingsManager,
  createReadTool,
  createLsTool,
  createWriteTool,
  createEditTool,
} from '@mariozechner/pi-coding-agent'
import type { AgentTool } from '@mariozechner/pi-agent-core'
import type { Config } from './config.js'
import { logger } from './logger.js'
import { stripFrontmatter } from './utils.js'
import { resolveModel } from './model.js'
import { createGitBlockedBashTool, createWriteOutputTool } from './tools.js'

const MAX_LOG_ARGS_LENGTH = 200

export interface AgentRunResult {
  text: string
  stats: {
    model: string | undefined
    sessionName: string | undefined
    tokens: { input: number; output: number; cacheRead: number; cacheWrite: number; total: number }
    cost: number
    context: { tokens: number | null; contextWindow: number; percent: number | null }
    toolCalls: number
  }
}

function createFileTools(worktreePath: string): AgentTool<any>[] {
  return [
    createReadTool(worktreePath),
    createLsTool(worktreePath),
    createWriteTool(worktreePath),
    createEditTool(worktreePath),
  ]
}

async function setupSession(
  systemPrompt: string,
  worktreePath: string,
  config: Config,
  sessionDir: string,
  model: string,
  sessionName?: string,
  additionalCustomTools?: AgentTool<any>[],
  outputFilePath?: string
) {
  const { authStorage, modelRegistry, resolvedModel } = resolveModel(config, model)

  const settingsManager = SettingsManager.inMemory({
    compaction: { enabled: true },
    retry: { enabled: true, maxRetries: 2 },
  })

  const loader = new DefaultResourceLoader({
    cwd: worktreePath,
    agentDir: config.piConfigDir,
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
    sessionManager: SessionManager.continueRecent(worktreePath, sessionDir),
    settingsManager,
    tools: createFileTools(worktreePath),
    customTools: [
      createGitBlockedBashTool(worktreePath),
      ...(outputFilePath ? [createWriteOutputTool(outputFilePath)] : []),
      ...(additionalCustomTools ?? []),
    ] as any[],
  })

  if (sessionName) session.setSessionName(sessionName)

  return session
}

function subscribeToSessionEvents(
  session: { subscribe: (handler: (event: any) => void) => void },
  agentName: string,
  completedMessages: string[]
) {
  const textBuffer: string[] = []
  session.subscribe((event) => {
    if (event.type === 'message_update' && event.assistantMessageEvent.type === 'text_delta') {
      textBuffer.push(event.assistantMessageEvent.delta)
    }

    if (event.type === 'tool_execution_start') {
      logger.info(
        {
          agent: agentName,
          tool: event.toolName,
          args: JSON.stringify(event.args).slice(0, MAX_LOG_ARGS_LENGTH),
        },
        'tool execution'
      )
    }

    if (event.type === 'message_end') {
      const trimmed = textBuffer.join('').trim()
      textBuffer.length = 0
      if (trimmed) {
        completedMessages.push(trimmed)
        for (const line of trimmed.split('\n')) {
          if (line.trim()) logger.info({ agent: agentName }, line)
        }
      }
    }
  })
}

export async function runAgent(
  name: string,
  agentFilePath: string,
  model: string,
  input: unknown,
  worktreePath: string,
  config: Config,
  sessionDir: string,
  sessionName?: string,
  additionalCustomTools?: AgentTool<any>[],
  outputFilePath?: string
): Promise<AgentRunResult> {
  const systemPrompt = stripFrontmatter(readFileSync(agentFilePath, 'utf-8'))
  const session = await setupSession(systemPrompt, worktreePath, config, sessionDir, model, sessionName, additionalCustomTools, outputFilePath)

  const completedMessages: string[] = []
  subscribeToSessionEvents(session, name, completedMessages)

  try {
    await session.prompt(JSON.stringify(input))
  } finally {
    session.dispose()
  }

  const { tokens, cost, toolCalls } = session.getSessionStats()
  const context = session.getContextUsage() ?? { tokens: null, contextWindow: 0, percent: null }

  return {
    text: completedMessages.join('\n\n'),
    stats: {
      model: session.model?.id,
      sessionName: session.sessionName,
      tokens,
      cost,
      context,
      toolCalls,
    },
  }
}
