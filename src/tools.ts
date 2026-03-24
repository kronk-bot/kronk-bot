import { join } from 'path'
import { writeFileSync } from 'fs'
import { Type } from '@sinclair/typebox'
import {
  createBashTool,
  createReadTool,
  createGrepTool,
  createFindTool,
  createLsTool,
} from '@mariozechner/pi-coding-agent'
import type { AgentTool } from '@mariozechner/pi-agent-core'
import type { GithubClient } from './github.js'
import type { Config } from './config.js'
import { logger } from './logger.js'
import { runSubagent } from './subagent-runner.js'

const GIT_BLOCKED_MESSAGE =
  'git and gh commands are not allowed via bash. Return commitMessage/prTitle/prBody in your JSON response instead — the harness handles all git and GitHub operations.'

const NO_RESULT_FALLBACK = '(no results found)'

function textResult(text: string) {
  return { content: [{ type: 'text' as const, text }], details: null }
}

// --- GitHub API tools (used by github-explorer subagent) ---

export function createGithubTools(github: GithubClient): AgentTool<any>[] {
  return [
    {
      name: 'github_get_issue',
      label: 'GitHub: Get Issue',
      description: 'Get details about a GitHub issue including title, body, and comments',
      parameters: Type.Object({
        issue_number: Type.Number({ description: 'The issue number' }),
      }),
      execute: async (_id, params: { issue_number: number }) => {
        const [issue, comments] = await Promise.all([
          github.getIssue(params.issue_number),
          github.getIssueComments(params.issue_number),
        ])
        return textResult(JSON.stringify({ issue, comments }, null, 2))
      },
    },
    {
      name: 'github_get_pr',
      label: 'GitHub: Get PR',
      description:
        'Get details about a GitHub PR including title, body, state (open/closed/merged), comments, and CI check run statuses',
      parameters: Type.Object({
        pr_number: Type.Number({ description: 'The PR number' }),
      }),
      execute: async (_id, params: { pr_number: number }) => {
        const [pr, comments, checkRuns] = await Promise.all([
          github.getPullRequestInfo(params.pr_number),
          github.getIssueComments(params.pr_number),
          github.getCheckRuns(params.pr_number).catch(() => []),
        ])
        return textResult(JSON.stringify({ pr, comments, checkRuns }, null, 2))
      },
    },
  ]
}

// --- Main agent tools ---

export function createGitBlockedBashTool(worktreePath: string): AgentTool<any> {
  const realBash = createBashTool(worktreePath)
  return {
    ...realBash,
    execute: async (id: string, params: { command: string }) => {
      if (/^\s*(git|gh)\s/.test(params.command)) {
        return textResult(GIT_BLOCKED_MESSAGE)
      }
      return realBash.execute(id, params)
    },
  }
}

export function createWriteOutputTool(outputFilePath: string): AgentTool<any> {
  return {
    name: 'write_output',
    label: 'Write Output',
    description:
      'Write your final response. This MUST be the last tool call — do not call any tools after it.',
    parameters: Type.Object({
      comment: Type.String({ description: 'Your response in GitHub Markdown. Always required.' }),
      commitMessage: Type.Optional(Type.String({ description: 'Include when you made file changes.' })),
      prTitle: Type.Optional(Type.String({ description: 'Semantic commit format, reference the issue (e.g. feat(#42): add dark mode).' })),
      prBody: Type.Optional(Type.String({ description: 'Required when prTitle is set.' })),
      prNumber: Type.Optional(Type.Number({ description: 'Optional, only for updating an existing open PR from pullRequests.' })),
    }),
    execute: async (_id, params: Record<string, unknown>) => {
      const clean = Object.fromEntries(Object.entries(params).filter(([, v]) => v !== undefined))
      writeFileSync(outputFilePath, JSON.stringify(clean, null, 2))
      return textResult('Response recorded.')
    },
  }
}

// --- Explorer tools (tools that wrap subagents) ---

export function createGithubExplorerTool(
  config: Config,
  worktreePath: string,
  githubTools: AgentTool<any>[]
): AgentTool<any> {
  return {
    name: 'github_explorer',
    label: 'GitHub Explorer',
    description:
      'Explore GitHub to find details about issues, PRs, comments, and their relationships. ' +
      'Call this when you need context not provided upfront — e.g. details of a linked issue, ' +
      'state of a related PR, or comments on another thread.',
    parameters: Type.Object({
      task: Type.String({ description: 'What to find or explore on GitHub' }),
    }),
    execute: async (_id, params: { task: string }) => {
      logger.info({ task: params.task }, 'github explorer invoked')
      const result = await runSubagent(
        'github-explorer',
        join(config.agentsDir, 'github-explorer.md'),
        config.agentModel,
        { task: params.task },
        worktreePath,
        config,
        githubTools
      )
      return textResult(result || NO_RESULT_FALLBACK)
    },
  }
}

export function createRepoExplorerTool(
  config: Config,
  worktreePath: string
): AgentTool<any> {
  return {
    name: 'repo_explorer',
    label: 'Repo Explorer',
    description:
      'Explore the codebase to understand structure, conventions, and implementation details. ' +
      'Call this when you need to investigate how the code works — e.g. find where a function is ' +
      'defined, understand the project layout, trace how a feature is implemented, or identify ' +
      'patterns and conventions used in the codebase.',
    parameters: Type.Object({
      task: Type.String({ description: 'What to find or explore in the codebase' }),
    }),
    execute: async (_id, params: { task: string }) => {
      logger.info({ task: params.task }, 'repo explorer invoked')
      const repoTools: AgentTool<any>[] = [
        createReadTool(worktreePath),
        createGrepTool(worktreePath),
        createFindTool(worktreePath),
        createLsTool(worktreePath),
      ]
      const result = await runSubagent(
        'repo-explorer',
        join(config.agentsDir, 'repo-explorer.md'),
        config.agentModel,
        { task: params.task },
        worktreePath,
        config,
        repoTools
      )
      return textResult(result || NO_RESULT_FALLBACK)
    },
  }
}
