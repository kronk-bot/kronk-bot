import { join, resolve, isAbsolute } from 'path'
import { randomUUID } from 'crypto'
import { existsSync, mkdirSync, writeFileSync, readFileSync } from 'fs'
import { createReadTool, createGrepTool, createFindTool, createLsTool } from '@mariozechner/pi-coding-agent'
import type { AgentTool } from '@mariozechner/pi-agent-core'
import type { GithubClient } from './github.js'
import type { Config } from './config.js'
import { CommentTracker } from './comment-tracker.js'
import { logger } from './logger.js'
import { Subagent } from './subagent.js'
import { createWorktree } from './git.js'
import { simpleGit } from 'simple-git'
import { execSync } from 'child_process'

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

// =============================================================================
// Builder Tools (used by builder subagent)
// =============================================================================

export interface BuilderWorktree {
  worktreePath: string
  branch: string
  issueNumber: number
}

/**
 * Context passed to builder tools, allowing them to manage worktrees
 * and track state across the builder session.
 */
export interface BuilderContext {
  repoDir: string
  github: GithubClient
  githubToken: string
  issueNumber: number
  activeWorktree: BuilderWorktree | null
  worktrees: Map<string, BuilderWorktree> // branch -> worktree info
  createdPRUrl: string | null
}

/**
 * Generate a branch name for an issue.
 * Format: kronk/{issueNumber}-{shortId}
 */
function generateBranchName(issueNumber: number): string {
  const shortId = randomUUID().slice(0, 4)
  return `kronk/${issueNumber}-${shortId}`
}

/**
 * Get the active worktree path, throwing an error if none is active.
 */
function getActiveWorktreePath(ctx: BuilderContext): string {
  if (!ctx.activeWorktree) {
    throw new Error('No active worktree. Create or use one first.')
  }
  return ctx.activeWorktree.worktreePath
}

/**
 * Resolve a path relative to the active worktree.
 */
function resolvePath(ctx: BuilderContext, path: string): string {
  const worktreePath = getActiveWorktreePath(ctx)
  return isAbsolute(path) ? path : resolve(worktreePath, path)
}

/**
 * Create tools used by the builder subagent.
 * These tools operate on a builder context that tracks worktrees and state.
 */
export function createBuilderTools(ctx: BuilderContext): AgentTool<any>[] {
  return [
    // ── File Operations (use active worktree) ───────────────────────────────
    {
      name: 'read',
      label: 'Read File',
      description: 'Read the contents of a file in the active worktree.',
      parameters: {
        type: 'object',
        properties: {
          path: { type: 'string', description: 'Path to the file (relative to worktree root)' },
          offset: { type: 'number', description: 'Line number to start reading from (1-indexed)' },
          limit: { type: 'number', description: 'Maximum number of lines to read' },
        },
        required: ['path'],
      } as any,
      execute: async (_id, params: { path: string; offset?: number; limit?: number }) => {
        try {
          const filePath = resolvePath(ctx, params.path)
          const content = readFileSync(filePath, 'utf-8')
          const lines = content.split('\n')
          const offset = params.offset ? params.offset - 1 : 0
          const limit = params.limit ?? lines.length
          const selectedLines = lines.slice(offset, offset + limit).join('\n')
          return {
            content: [{ type: 'text' as const, text: selectedLines || '(empty file)' }],
            details: { path: filePath, totalLines: lines.length },
          }
        } catch (err) {
          const msg = err instanceof Error ? err.message : String(err)
          return { content: [{ type: 'text' as const, text: `Error reading file: ${msg}` }], details: null }
        }
      },
    },
    {
      name: 'write_file',
      label: 'Write File',
      description: 'Create or overwrite a file in the active worktree.',
      parameters: {
        type: 'object',
        properties: {
          path: { type: 'string', description: 'Path to the file (relative to worktree root)' },
          content: { type: 'string', description: 'Content to write to the file' },
        },
        required: ['path', 'content'],
      } as any,
      execute: async (_id, params: { path: string; content: string }) => {
        try {
          const filePath = resolvePath(ctx, params.path)
          // Ensure directory exists
          const dir = join(filePath, '..')
          if (!existsSync(dir)) {
            mkdirSync(dir, { recursive: true })
          }
          writeFileSync(filePath, params.content)
          return {
            content: [{ type: 'text' as const, text: `Wrote ${params.content.length} bytes to ${params.path}` }],
            details: { path: filePath },
          }
        } catch (err) {
          const msg = err instanceof Error ? err.message : String(err)
          return { content: [{ type: 'text' as const, text: `Error writing file: ${msg}` }], details: null }
        }
      },
    },
    {
      name: 'bash',
      label: 'Run Verification Command',
      description: 'Run a verification command in the active worktree. Use ONLY for: running tests, lint, typecheck, or build. Do NOT use for exploration, fetching data, or other purposes.',
      parameters: {
        type: 'object',
        properties: {
          command: { type: 'string', description: 'The verification command to run (e.g., npm test, npm run lint, npm run typecheck)' },
          timeout: { type: 'number', description: 'Timeout in seconds (default: 60)' },
        },
        required: ['command'],
      } as any,
      execute: async (_id, params: { command: string; timeout?: number }) => {
        try {
          const worktreePath = getActiveWorktreePath(ctx)
          const timeout = (params.timeout ?? 60) * 1000
          const result = execSync(params.command, {
            cwd: worktreePath,
            encoding: 'utf-8',
            timeout,
            maxBuffer: 10 * 1024 * 1024, // 10MB
            stdio: ['pipe', 'pipe', 'pipe'],
          })
          return {
            content: [{ type: 'text' as const, text: result || '(no output)' }],
            details: { cwd: worktreePath },
          }
        } catch (err: any) {
          const output = err.stdout || err.stderr || err.message
          return {
            content: [{ type: 'text' as const, text: `Command failed:\n${output}` }],
            details: null,
          }
        }
      },
    },

    // ── Worktree Management ────────────────────────────────────────────────
    // ── Worktree Management ────────────────────────────────────────────────
    {
      name: 'create_worktree',
      label: 'Create Worktree',
      description: 'Create a new isolated worktree with a branch for this issue. Use this when starting fresh.',
      parameters: {
        type: 'object',
        properties: {
          base_branch: { type: 'string', description: 'The branch to base the new branch on (default: main)' },
        },
      } as any,
      execute: async (_id, params: { base_branch?: string }) => {
        const branch = generateBranchName(ctx.issueNumber)
        const worktreePath = join(ctx.repoDir, '..', `worktree-${branch.replace(/\//g, '-')}`)

        try {
          await createWorktree(ctx.repoDir, worktreePath, branch, ctx.githubToken, params.base_branch)
          ctx.activeWorktree = { worktreePath, branch, issueNumber: ctx.issueNumber }
          ctx.worktrees.set(branch, ctx.activeWorktree)

          return {
            content: [
              {
                type: 'text' as const,
                text: `Created worktree at ${worktreePath} on branch ${branch}`,
              },
            ],
            details: { worktreePath, branch },
          }
        } catch (err) {
          const msg = err instanceof Error ? err.message : String(err)
          return { content: [{ type: 'text' as const, text: `Error creating worktree: ${msg}` }], details: null }
        }
      },
    },
    {
      name: 'list_worktrees',
      label: 'List Worktrees',
      description: 'List all worktrees for this repository, including any existing ones for this issue.',
      parameters: { type: 'object', properties: {} } as any,
      execute: async () => {
        try {
          const git = simpleGit({ baseDir: ctx.repoDir })
          const result = await git.raw(['worktree', 'list'])
          const lines = result.trim().split('\n')

          // Parse worktree list and identify ones for this issue
          const worktrees = lines
            .map((line) => {
              const [path, commit, branch] = line.split(/\s+/)
              return { path, commit, branch: branch?.replace('refs/heads/', '') || '' }
            })
            .filter((wt) => wt.branch.startsWith(`kronk/${ctx.issueNumber}-`))

          if (worktrees.length === 0) {
            return {
              content: [{ type: 'text' as const, text: `No existing worktrees for issue #${ctx.issueNumber}` }],
              details: { worktrees: [] },
            }
          }

          const text = worktrees.map((wt) => `- ${wt.path} (branch: ${wt.branch})`).join('\n')
          return {
            content: [{ type: 'text' as const, text: `Worktrees for issue #${ctx.issueNumber}:\n${text}` }],
            details: { worktrees },
          }
        } catch (err) {
          const msg = err instanceof Error ? err.message : String(err)
          return { content: [{ type: 'text' as const, text: `Error listing worktrees: ${msg}` }], details: null }
        }
      },
    },
    {
      name: 'use_worktree',
      label: 'Use Worktree',
      description: 'Continue working in an existing worktree for this issue. Use after list_worktrees to find available worktrees.',
      parameters: {
        type: 'object',
        properties: {
          branch: { type: 'string', description: 'The branch name of the worktree to use' },
        },
        required: ['branch'],
      } as any,
      execute: async (_id, params: { branch: string }) => {
        try {
          const git = simpleGit({ baseDir: ctx.repoDir })
          const result = await git.raw(['worktree', 'list'])
          const lines = result.trim().split('\n')

          const worktree = lines
            .map((line) => {
              const [path, commit, branch] = line.split(/\s+/)
              return { path, branch: branch?.replace('refs/heads/', '') || '' }
            })
            .find((wt) => wt.branch === params.branch)

          if (!worktree) {
            return {
              content: [{ type: 'text' as const, text: `Worktree with branch ${params.branch} not found` }],
              details: null,
            }
          }

          ctx.activeWorktree = {
            worktreePath: worktree.path,
            branch: params.branch,
            issueNumber: ctx.issueNumber,
          }
          ctx.worktrees.set(params.branch, ctx.activeWorktree)

          return {
            content: [{ type: 'text' as const, text: `Now using worktree at ${worktree.path} (branch: ${params.branch})` }],
            details: { worktreePath: worktree.path, branch: params.branch },
          }
        } catch (err) {
          const msg = err instanceof Error ? err.message : String(err)
          return { content: [{ type: 'text' as const, text: `Error using worktree: ${msg}` }], details: null }
        }
      },
    },

    // ── Git Operations ──────────────────────────────────────────────────────
    {
      name: 'git_add',
      label: 'Git Add',
      description: 'Stage changes for commit. Specify files or use "." for all changes.',
      parameters: {
        type: 'object',
        properties: {
          files: {
            type: 'array',
            items: { type: 'string' },
            description: 'Files to stage (relative to worktree root). Use ["."] for all changes.',
          },
        },
        required: ['files'],
      } as any,
      execute: async (_id, params: { files: string[] }) => {
        if (!ctx.activeWorktree) {
          return { content: [{ type: 'text' as const, text: 'Error: No active worktree. Create or use one first.' }], details: null }
        }

        try {
          const git = simpleGit({ baseDir: ctx.activeWorktree.worktreePath })
          await git.add(params.files)
          const status = await git.status()
          const staged = status.staged.join(', ') || '(none)'
          return {
            content: [{ type: 'text' as const, text: `Staged files: ${staged}` }],
            details: { staged: status.staged },
          }
        } catch (err) {
          const msg = err instanceof Error ? err.message : String(err)
          return { content: [{ type: 'text' as const, text: `Error staging files: ${msg}` }], details: null }
        }
      },
    },
    {
      name: 'git_commit',
      label: 'Git Commit',
      description: 'Commit staged changes with a message.',
      parameters: {
        type: 'object',
        properties: {
          message: { type: 'string', description: 'Commit message' },
        },
        required: ['message'],
      } as any,
      execute: async (_id, params: { message: string }) => {
        if (!ctx.activeWorktree) {
          return { content: [{ type: 'text' as const, text: 'Error: No active worktree. Create or use one first.' }], details: null }
        }

        try {
          const git = simpleGit({ baseDir: ctx.activeWorktree.worktreePath })
          await git.addConfig('user.email', 'kronk-bot@users.noreply.github.com')
          await git.addConfig('user.name', 'kronk-bot')
          await git.commit(params.message)
          const log = await git.log(['-1'])
          return {
            content: [{ type: 'text' as const, text: `Committed: ${log.latest?.hash?.slice(0, 7)} - ${params.message}` }],
            details: { commit: log.latest?.hash },
          }
        } catch (err) {
          const msg = err instanceof Error ? err.message : String(err)
          return { content: [{ type: 'text' as const, text: `Error committing: ${msg}` }], details: null }
        }
      },
    },
    {
      name: 'git_push',
      label: 'Git Push',
      description: 'Push the current branch to remote.',
      parameters: { type: 'object', properties: {} } as any,
      execute: async () => {
        if (!ctx.activeWorktree) {
          return { content: [{ type: 'text' as const, text: 'Error: No active worktree. Create or use one first.' }], details: null }
        }

        try {
          const git = simpleGit({ baseDir: ctx.activeWorktree.worktreePath })
          await git.push('origin', ctx.activeWorktree.branch, ['--set-upstream'])
          return {
            content: [{ type: 'text' as const, text: `Pushed branch ${ctx.activeWorktree.branch} to remote` }],
            details: { branch: ctx.activeWorktree.branch },
          }
        } catch (err) {
          const msg = err instanceof Error ? err.message : String(err)
          return { content: [{ type: 'text' as const, text: `Error pushing: ${msg}` }], details: null }
        }
      },
    },

    // ── PR Operations ───────────────────────────────────────────────────────
    {
      name: 'create_pr',
      label: 'Create Pull Request',
      description: 'Create a new pull request from the current branch.',
      parameters: {
        type: 'object',
        properties: {
          title: { type: 'string', description: 'PR title' },
          body: { type: 'string', description: 'PR body (markdown)' },
          draft: { type: 'boolean', description: 'Create as draft PR (default: false)' },
        },
        required: ['title', 'body'],
      } as any,
      execute: async (_id, params: { title: string; body: string; draft?: boolean }) => {
        if (!ctx.activeWorktree) {
          return { content: [{ type: 'text' as const, text: 'Error: No active worktree. Create or use one first.' }], details: null }
        }

        try {
          // Get default branch
          const repoInfo = await ctx.github.getIssue(1) // Hack to get repo context
          const baseBranch = 'main' // Could be made configurable

          const prUrl = await ctx.github.createPullRequest(
            params.title,
            params.body,
            ctx.activeWorktree.branch,
            baseBranch,
            params.draft ?? false
          )

          ctx.createdPRUrl = prUrl

          return {
            content: [{ type: 'text' as const, text: `Created PR: ${prUrl}` }],
            details: { prUrl, branch: ctx.activeWorktree.branch },
          }
        } catch (err) {
          const msg = err instanceof Error ? err.message : String(err)
          return { content: [{ type: 'text' as const, text: `Error creating PR: ${msg}` }], details: null }
        }
      },
    },
    {
      name: 'update_pr',
      label: 'Update Pull Request',
      description: 'Update an existing pull request title and/or body.',
      parameters: {
        type: 'object',
        properties: {
          pr_number: { type: 'number', description: 'PR number to update' },
          title: { type: 'string', description: 'New PR title (optional)' },
          body: { type: 'string', description: 'New PR body (optional)' },
        },
        required: ['pr_number'],
      } as any,
      execute: async (_id, params: { pr_number: number; title?: string; body?: string }) => {
        if (!params.title && !params.body) {
          return {
            content: [{ type: 'text' as const, text: 'Error: Must provide either title or body to update' }],
            details: null,
          }
        }

        try {
          // Get current PR to fill in missing values
          const pr = await ctx.github.getPullRequestInfo(params.pr_number)
          if (!pr) {
            return { content: [{ type: 'text' as const, text: `Error: PR #${params.pr_number} not found` }], details: null }
          }

          const title = params.title ?? pr.title
          const body = params.body ?? pr.body

          await ctx.github.updatePullRequest(params.pr_number, title, body)

          return {
            content: [{ type: 'text' as const, text: `Updated PR #${params.pr_number}` }],
            details: { prNumber: params.pr_number },
          }
        } catch (err) {
          const msg = err instanceof Error ? err.message : String(err)
          return { content: [{ type: 'text' as const, text: `Error updating PR: ${msg}` }], details: null }
        }
      },
    },
  ]
}

// =============================================================================
// Build Tool (used by orchestrator)
// =============================================================================

export interface BuildToolParams {
  trigger_text: string
  trigger_source: 'issue' | 'pr'
  issue_number: number
  pr_number?: number
  context?: Record<string, unknown>
  job_done_so_far?: Record<string, unknown> | null
}

export interface BuildToolResult {
  status: 'done' | 'need_context' | 'pending'
  summary: string
  changes_made: Array<{ file: string; description: string }>
  pr_url?: string
  context_request?: string
  job_done_so_far?: Record<string, unknown>
}

export function createBuildTool(
  config: Config,
  repoDir: string,
  github: GithubClient,
  githubToken: string
): AgentTool<any> {
  return {
    name: 'build',
    label: 'Build',
    description:
      'Spawn the Builder subagent to implement code changes, commit, push, and create/update PRs. ' +
      'Returns structured results with status, summary, changes made, and PR URL.',
    parameters: {
      type: 'object',
      properties: {
        trigger_text: { type: 'string', description: 'The comment that triggered this build' },
        trigger_source: { type: 'string', enum: ['issue', 'pr'], description: 'Whether triggered from issue or PR' },
        issue_number: { type: 'number', description: 'The issue or PR number' },
        pr_number: { type: 'number', description: 'PR number if triggered from a PR' },
        context: { type: 'object', description: 'Context gathered by explorer' },
        job_done_so_far: { type: 'object', description: 'State from previous iteration' },
      },
      required: ['trigger_text', 'trigger_source', 'issue_number'],
    } as any,
    execute: async (_id, params: BuildToolParams) => {
      logger.info({ issue: params.issue_number }, 'builder invoked')

      // Create builder context
      const builderCtx: BuilderContext = {
        repoDir,
        github,
        githubToken,
        issueNumber: params.issue_number,
        activeWorktree: null,
        worktrees: new Map(),
        createdPRUrl: null,
      }

      // Create builder tools with dynamic worktree support
      const builderTools = createBuilderTools(builderCtx)

      // Use repo dir as base for grep/find/ls (they can work across worktrees)
      const baseDir = repoDir

      const builder = new Subagent(config, baseDir, {
        name: 'builder',
        agentFile: join(config.agentsDir, 'builder.md'),
        tools: builderTools,
        outputToolName: 'write_builder_result',
      })

      const result = await builder.run({
        trigger_text: params.trigger_text,
        trigger_source: params.trigger_source,
        issue_number: params.issue_number,
        pr_number: params.pr_number,
        context: params.context ?? {},
        job_done_so_far: params.job_done_so_far ?? null,
      })

      // Return structured output if available, otherwise return text
      const output = result.structuredOutput
        ? JSON.stringify(result.structuredOutput, null, 2)
        : result.text || '(no results)'

      return { content: [{ type: 'text', text: output }], details: null }
    },
  }
}
