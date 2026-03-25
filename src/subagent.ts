import { readFileSync, writeFileSync, rmSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { randomUUID } from 'crypto'
import {
  createAgentSession,
  DefaultResourceLoader,
  SessionManager,
  SettingsManager,
} from '@mariozechner/pi-coding-agent'
import type { AgentTool } from '@mariozechner/pi-agent-core'
import type { Config } from './config.js'
import { stripFrontmatter, MAX_LOG_ARGS_LENGTH } from './utils.js'
import { resolveModel } from './model.js'
import { logger } from './logger.js'

export interface SubagentResult {
  text: string
  structuredOutput: Record<string, unknown> | null
  stats: {
    model: string | undefined
    tokens: { input: number; output: number; total: number }
    cost: number
    toolCalls: number
  }
}

export interface SubagentConfig {
  name: string
  agentFile: string
  tools: AgentTool<any>[]
  outputToolName?: string
}

export class Subagent {
  private readonly systemPrompt: string
  private readonly outputToolName: string | undefined

  constructor(
    private readonly config: Config,
    private readonly worktreePath: string,
    private readonly subagentConfig: SubagentConfig
  ) {
    this.systemPrompt = stripFrontmatter(readFileSync(subagentConfig.agentFile, 'utf-8'))
    this.outputToolName = subagentConfig.outputToolName
  }

  async run(input: unknown): Promise<SubagentResult> {
    const { authStorage, modelRegistry, resolvedModel } = resolveModel(this.config, this.config.agentModel)

    const settingsManager = SettingsManager.inMemory({
      compaction: { enabled: false },
      retry: { enabled: true, maxRetries: 2 },
    })

    const loader = new DefaultResourceLoader({
      cwd: this.worktreePath,
      agentDir: this.config.piConfigDir,
      settingsManager,
      systemPromptOverride: () => this.systemPrompt,
      agentsFilesOverride: () => ({ agentsFiles: [] }),
    })
    await loader.reload()

    // Create temp file for structured output if needed
    let outputFile: string | undefined
    const tools = [...this.subagentConfig.tools]
    if (this.outputToolName) {
      outputFile = join(tmpdir(), `${this.subagentConfig.name}-${randomUUID()}.json`)
      tools.push(this.createOutputTool(outputFile))
    }

    const { session } = await createAgentSession({
      cwd: this.worktreePath,
      model: resolvedModel,
      authStorage,
      modelRegistry,
      resourceLoader: loader,
      sessionManager: SessionManager.inMemory(),
      settingsManager,
      tools: [],
      customTools: tools as any[],
    })

    const completedMessages: string[] = []
    const textBuffer: string[] = []

    session.subscribe((event) => {
      if (event.type === 'message_update' && event.assistantMessageEvent.type === 'text_delta') {
        textBuffer.push(event.assistantMessageEvent.delta)
      }
      if (event.type === 'tool_execution_start') {
        logger.info(
          {
            agent: this.subagentConfig.name,
            tool: event.toolName,
            args: JSON.stringify(event.args).slice(0, MAX_LOG_ARGS_LENGTH),
          },
          'tool execution'
        )
      }
      if (event.type === 'message_end') {
        const trimmed = textBuffer.join('').trim()
        textBuffer.length = 0
        if (trimmed) completedMessages.push(trimmed)
      }
    })

    try {
      await session.prompt(JSON.stringify(input))
    } finally {
      session.dispose()
    }

    // Read structured output if available
    let structuredOutput: Record<string, unknown> | null = null
    if (outputFile) {
      try {
        const content = readFileSync(outputFile, 'utf-8')
        structuredOutput = JSON.parse(content)
        rmSync(outputFile)
      } catch {
        // No structured output written
      }
    }

    const { tokens, cost, toolCalls } = session.getSessionStats()

    return {
      text: completedMessages.join('\n\n'),
      structuredOutput,
      stats: {
        model: session.model?.id,
        tokens: { input: tokens.input, output: tokens.output, total: tokens.total },
        cost,
        toolCalls,
      },
    }
  }

  private createOutputTool(outputFile: string): AgentTool<any> {
    return {
      name: this.outputToolName!,
      label: 'Write Output',
      description: 'Write structured output. This MUST be the last tool call.',
      parameters: {
        type: 'object',
        additionalProperties: true,
      } as any,
      execute: async (_id, params: Record<string, unknown>) => {
        writeFileSync(outputFile, JSON.stringify(params, null, 2))
        return { content: [{ type: 'text', text: 'Output recorded.' }], details: null }
      },
    }
  }
}
