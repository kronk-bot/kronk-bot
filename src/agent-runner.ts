import { readFileSync } from 'fs'
import {
  createAgentSession,
  DefaultResourceLoader,
  SessionManager,
  SettingsManager,
  createReadTool,
  createGrepTool,
  createFindTool,
  createLsTool,
  createWriteTool,
  createEditTool,
  createBashTool,
} from '@mariozechner/pi-coding-agent'
import type { AgentTool } from '@mariozechner/pi-agent-core'
import type { Config } from './config.js'
import { logger } from './logger.js'
import { stripFrontmatter } from './utils.js'
import { resolveModel } from './model.js'

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

async function setupSession(
  systemPrompt: string,
  worktreePath: string,
  config: Config,
  sessionDir: string,
  model: string,
  extraTools: AgentTool[],
  sessionName?: string
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
    tools: [
      createReadTool(worktreePath),
      createGrepTool(worktreePath),
      createFindTool(worktreePath),
      createLsTool(worktreePath),
      createWriteTool(worktreePath),
      createEditTool(worktreePath),
      createBashTool(worktreePath),
      ...extraTools,
    ],
  })

  if (sessionName) session.setSessionName(sessionName)

  return session
}

export async function runAgent(
  name: string,
  agentFilePath: string,
  model: string,
  input: unknown,
  worktreePath: string,
  config: Config,
  sessionDir: string,
  extraTools: AgentTool[],
  sessionName?: string
): Promise<AgentRunResult> {
  const systemPrompt = stripFrontmatter(readFileSync(agentFilePath, 'utf-8'))
  const session = await setupSession(systemPrompt, worktreePath, config, sessionDir, model, extraTools, sessionName)

  const allText: string[] = []
  const bufferParts: string[] = []
  session.subscribe((event) => {
    if (event.type === 'message_update' && event.assistantMessageEvent.type === 'text_delta') {
      bufferParts.push(event.assistantMessageEvent.delta)
    }

    if (event.type === 'tool_execution_start') {
      logger.debug(
        {
          agent: name,
          tool: event.toolName,
          args: JSON.stringify(event.args).slice(0, 200),
        },
        'tool execution'
      )
    }

    if (event.type === 'message_end') {
      const trimmed = bufferParts.join('').trim()
      bufferParts.length = 0
      if (trimmed) {
        allText.push(trimmed)
        for (const line of trimmed.split('\n')) {
          if (line.trim()) logger.info({ agent: name }, line)
        }
      }
    }
  })

  try {
    await session.prompt(JSON.stringify(input))
  } finally {
    session.dispose()
  }

  const { tokens, cost, toolCalls } = session.getSessionStats()
  const context = session.getContextUsage() ?? { tokens: null, contextWindow: 0, percent: null }

  return {
    text: allText.join('\n\n'),
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
