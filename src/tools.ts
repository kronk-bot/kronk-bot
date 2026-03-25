import { join } from 'path'
import { createReadTool, createGrepTool, createFindTool, createLsTool } from '@mariozechner/pi-coding-agent'
import type { AgentTool } from '@mariozechner/pi-agent-core'
import type { GithubClient } from './github.js'
import type { Config } from './config.js'
import { CommentTracker } from './comment-tracker.js'
import { logger } from './logger.js'
import { Subagent } from './subagent.js'

// =============================================================================
// GitHub API Tools (used by explorer subagent)
// =============================================================================

export function createGithubTools(github: GithubClient): AgentTool<any>[] {
  return [
    {
      name: 'github_get_issue',
      label: 'GitHub: Get Issue',
      description: 'Get details about a GitHub issue including title, body, and comments',
      parameters: {
        type: 'object',
        properties: {
          issue_number: { type: 'number', description: 'The issue number' },
        },
        required: ['issue_number'],
      } as any,
      execute: async (_id, params: { issue_number: number }) => {
        const [issue, comments] = await Promise.all([
          github.getIssue(params.issue_number),
          github.getIssueComments(params.issue_number),
        ])
        return {
          content: [{ type: 'text' as const, text: JSON.stringify({ issue, comments }, null, 2) }],
          details: null,
        }
      },
    },
    {
      name: 'github_get_pr',
      label: 'GitHub: Get PR',
      description:
        'Get details about a GitHub PR including title, body, state (open/closed/merged), comments, and CI check run statuses',
      parameters: {
        type: 'object',
        properties: {
          pr_number: { type: 'number', description: 'The PR number' },
        },
        required: ['pr_number'],
      } as any,
      execute: async (_id, params: { pr_number: number }) => {
        const [pr, comments] = await Promise.all([
          github.getPullRequestInfo(params.pr_number),
          github.getIssueComments(params.pr_number),
        ])
        const checkRuns = pr ? await github.getCheckRuns(pr.branch).catch(() => []) : []
        return {
          content: [{ type: 'text' as const, text: JSON.stringify({ pr, comments, checkRuns }, null, 2) }],
          details: null,
        }
      },
    },
  ]
}

// =============================================================================
// Orchestrator Comment Tools
// =============================================================================

export { CommentTracker }

export function createCommentTools(commentTracker: CommentTracker): AgentTool<any>[] {
  return [
    {
      name: 'add_comment',
      label: 'Add Comment',
      description: 'Add a new comment to an issue or PR. Returns the comment index for future edits.',
      parameters: {
        type: 'object',
        properties: {
          issue_number: { type: 'number', description: 'The issue or PR number to comment on' },
          body: { type: 'string', description: 'Comment body in GitHub Markdown' },
        },
        required: ['issue_number', 'body'],
      } as any,
      execute: async (_id, params: { issue_number: number; body: string }) => {
        try {
          const { index } = await commentTracker.addComment(params.issue_number, params.body)
          return {
            content: [{ type: 'text' as const, text: `Created comment ${index} on issue/PR ${params.issue_number}` }],
            details: null,
          }
        } catch (err) {
          const msg = err instanceof Error ? err.message : String(err)
          return {
            content: [{ type: 'text' as const, text: `Error: ${msg}` }],
            details: null,
          }
        }
      },
    },
    {
      name: 'edit_comment',
      label: 'Edit Comment',
      description: 'Edit an existing comment on an issue or PR. Use the index returned by add_comment.',
      parameters: {
        type: 'object',
        properties: {
          issue_number: { type: 'number', description: 'The issue or PR number' },
          index: { type: 'number', description: 'The comment index (returned by add_comment)' },
          body: { type: 'string', description: 'New comment body in GitHub Markdown' },
        },
        required: ['issue_number', 'index', 'body'],
      } as any,
      execute: async (_id, params: { issue_number: number; index: number; body: string }) => {
        try {
          await commentTracker.editComment(params.issue_number, params.index, params.body)
          return {
            content: [
              { type: 'text' as const, text: `Updated comment ${params.index} on issue/PR ${params.issue_number}` },
            ],
            details: null,
          }
        } catch (err) {
          const msg = err instanceof Error ? err.message : String(err)
          return {
            content: [{ type: 'text' as const, text: `Error: ${msg}` }],
            details: null,
          }
        }
      },
    },
    {
      name: 'list_comments',
      label: 'List Comments',
      description: 'List all comments created by this session for a specific issue or PR.',
      parameters: {
        type: 'object',
        properties: {
          issue_number: { type: 'number', description: 'The issue or PR number' },
        },
        required: ['issue_number'],
      } as any,
      execute: async (_id, params: { issue_number: number }) => {
        const comments = commentTracker.listComments(params.issue_number)
        if (comments.length === 0) {
          return {
            content: [{ type: 'text' as const, text: `No comments found for issue/PR ${params.issue_number}` }],
            details: null,
          }
        }
        const lines = comments.map((c) => `  ${c.index}: ${c.bodyPreview}`)
        return {
          content: [
            { type: 'text' as const, text: `Comments on issue/PR ${params.issue_number}:\n${lines.join('\n')}` },
          ],
          details: null,
        }
      },
    },
  ]
}

// =============================================================================
// Explore Tool
// =============================================================================

export function createExploreTool(config: Config, worktreePath: string, github: GithubClient): AgentTool<any> {
  return {
    name: 'explore',
    label: 'Explore',
    description:
      'Spawn the Explorer subagent to investigate the codebase and/or GitHub. ' +
      'Returns structured results with status, summary, key files, and snippets.',
    parameters: {
      type: 'object',
      properties: {
        task: { type: 'string', description: 'What to investigate in the codebase and/or GitHub' },
      },
      required: ['task'],
    } as any,
    execute: async (_id, params: { task: string }) => {
      logger.info({ task: params.task }, 'explorer invoked')

      const explorer = new Subagent(config, worktreePath, {
        name: 'explorer',
        agentFile: join(config.agentsDir, 'explorer.md'),
        tools: [
          createReadTool(worktreePath),
          createGrepTool(worktreePath),
          createFindTool(worktreePath),
          createLsTool(worktreePath),
          ...createGithubTools(github),
        ],
        outputToolName: 'write_exploration_result',
      })

      const result = await explorer.run({ task: params.task })

      // Return structured output if available, otherwise return text
      const output = result.structuredOutput
        ? JSON.stringify(result.structuredOutput, null, 2)
        : result.text || '(no results)'

      return { content: [{ type: 'text', text: output }], details: null }
    },
  }
}
