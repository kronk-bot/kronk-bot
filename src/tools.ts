import { Type, type Static } from '@sinclair/typebox'
import { simpleGit } from 'simple-git'
import type { AgentTool } from '@mariozechner/pi-agent-core'
import type { GithubClient } from './github.js'

function textResult(text: string) {
  return { content: [{ type: 'text' as const, text }], details: null }
}

const gitCommitParams = Type.Object({
  message: Type.String({ description: 'Commit message (-m)' }),
  all: Type.Optional(Type.Boolean({ description: 'Stage all modified and deleted files before committing (-a). Defaults to true.' })),
})

const gitPushParams = Type.Object({
  remote: Type.Optional(Type.String({ description: 'Remote name. Defaults to "origin".' })),
  branch: Type.Optional(Type.String({ description: 'Branch to push. Defaults to current branch (HEAD).' })),
  setUpstream: Type.Optional(Type.Boolean({ description: 'Set upstream tracking reference (--set-upstream / -u). Defaults to true.' })),
})

const ghPrCreateParams = (defaultBranch: string) => Type.Object({
  title: Type.String({ description: 'PR title (--title)' }),
  body: Type.String({ description: 'PR body / description (--body)' }),
  base: Type.Optional(Type.String({ description: `Base branch to merge into (--base). Defaults to "${defaultBranch}".` })),
  draft: Type.Optional(Type.Boolean({ description: 'Open as a draft pull request (--draft). Defaults to false.' })),
})

/**
 * Mirrors: git commit [-a] -m <message>
 */
export function createGitCommitTool(worktreePath: string): AgentTool<any> {
  const git = simpleGit({ baseDir: worktreePath })
  return {
    name: 'git_commit',
    label: 'git commit',
    description: 'Stage and commit changes in the working tree. Mirrors: git commit [-a] -m <message>',
    parameters: gitCommitParams,
    execute: async (_id: string, { message, all = true }: Static<typeof gitCommitParams>) => {
      if (all) await git.add('.')
      const result = await git.commit(message)
      const text = result.commit ? `[${result.branch} ${result.commit}] ${message}` : 'nothing to commit, working tree clean'
      return textResult(text)
    },
  }
}

/**
 * Mirrors: git push [--set-upstream] [<remote>] [<branch>]
 */
export function createGitPushTool(worktreePath: string): AgentTool<any> {
  const git = simpleGit({ baseDir: worktreePath })
  return {
    name: 'git_push',
    label: 'git push',
    description: 'Push commits to a remote repository. Mirrors: git push [--set-upstream] [<remote>] [<branch>]',
    parameters: gitPushParams,
    execute: async (_id: string, { remote = 'origin', branch = 'HEAD', setUpstream = true }: Static<typeof gitPushParams>) => {
      const options = setUpstream ? ['--set-upstream'] : []
      await git.push(remote, branch, options)
      return textResult(`Branch pushed to ${remote}/${branch}`)
    },
  }
}

/**
 * Mirrors: gh pr create --title <title> --body <body> [--base <branch>] [--draft]
 */
export function createGhPrCreateTool(worktreePath: string, github: GithubClient, defaultBranch: string): AgentTool<any> {
  const git = simpleGit({ baseDir: worktreePath })
  const parameters = ghPrCreateParams(defaultBranch)
  return {
    name: 'gh_pr_create',
    label: 'gh pr create',
    description: `Open a pull request on GitHub. Mirrors: gh pr create --title <title> --body <body> [--base <branch>] [--draft]`,
    parameters,
    execute: async (_id: string, { title, body, base = defaultBranch, draft = false }: Static<ReturnType<typeof ghPrCreateParams>>) => {
      const head = (await git.revparse(['--abbrev-ref', 'HEAD'])).trim()
      const url = await github.createPullRequest(title, body, head, base, draft)
      return textResult(url)
    },
  }
}
