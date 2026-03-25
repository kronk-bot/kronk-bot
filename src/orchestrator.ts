import { join } from 'path'
import { readFileSync } from 'fs'
import {
  AgentSessionEvent,
  createAgentSession,
  DefaultResourceLoader,
  SessionManager,
  SettingsManager,
} from '@mariozechner/pi-coding-agent'
import type { AgentTool } from '@mariozechner/pi-agent-core'
import type { Config } from './config.js'
import type { TriggerContext } from './context.js'
import type { GithubClient } from './github.js'
import type { Storage } from './storage.js'
import { createExploreTool, createCommentTools, CommentTracker } from './tools.js'
import { StatsProvider } from './stats-provider.js'
import { stripFrontmatter, MAX_LOG_ARGS_LENGTH } from './utils.js'
import { resolveModel } from './model.js'
import { logger } from './logger.js'

export class Orchestrator {
  constructor(
    private readonly config: Config,
    private readonly github: GithubClient,
    private readonly worktreePath: string,
    private readonly sessionDir: string,
    private readonly storage: Storage
  ) {}

  async run(ctx: TriggerContext): Promise<void> {
    const agentPath = join(this.config.agentsDir, 'orchestrator.md')
    const systemPrompt = stripFrontmatter(readFileSync(agentPath, 'utf-8'))
    const { authStorage, modelRegistry, resolvedModel } = resolveModel(this.config, this.config.agentModel)

    const settingsManager = SettingsManager.inMemory({
      compaction: { enabled: true },
      retry: { enabled: true, maxRetries: 2 },
    })

    const loader = new DefaultResourceLoader({
      cwd: this.worktreePath,
      agentDir: this.config.piConfigDir,
      settingsManager,
      systemPromptOverride: () => systemPrompt,
      agentsFilesOverride: () => ({ agentsFiles: [] }),
    })
    await loader.reload()

    // Stats provider for comment footer
    const statsProvider = new StatsProvider()

    // Create comment tracker for this session
    const commentTracker = new CommentTracker(ctx.triggerId, this.github, this.storage, statsProvider)

    // Create tools
    const tools: AgentTool<any>[] = [
      createExploreTool(this.config, this.worktreePath, this.github),
      ...createCommentTools(commentTracker),
    ]

    const { session } = await createAgentSession({
      cwd: this.worktreePath,
      model: resolvedModel,
      authStorage,
      modelRegistry,
      resourceLoader: loader,
      sessionManager: SessionManager.continueRecent(this.worktreePath, this.sessionDir),
      settingsManager,
      tools: [],
      customTools: tools as any[],
    })

    session.setSessionName(String(ctx.issueNumber))

    session.subscribe((event: AgentSessionEvent) => {
      switch (event.type) {
        case 'tool_execution_start':
          logger.info(
            {
              agent: 'orchestrator',
              tool: event.toolName,
              args: JSON.stringify(event.args).slice(0, MAX_LOG_ARGS_LENGTH),
            },
            'tool execution'
          )
          break
        case 'message_end':
        case 'tool_execution_end':
          statsProvider.update(session)
          break
      }
    })

    try {
      await session.prompt(JSON.stringify(ctx))
    } finally {
      session.dispose()
    }

    const { tokens, cost, toolCalls } = session.getSessionStats()
    const contextUsage = session.getContextUsage() ?? { tokens: null, contextWindow: 0, percent: null }

    logger.info(
      {
        triggerId: ctx.triggerId,
        model: session.model?.id,
        tokens: { input: tokens.input, output: tokens.output, total: tokens.total },
        cost,
        toolCalls,
      },
      'orchestrator session completed'
    )
  }
}
