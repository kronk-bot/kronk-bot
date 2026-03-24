import type { PullRequestInfo } from './github.js'

export type { PullRequestInfo }

export interface CheckRun {
  name: string
  status: string
  conclusion: string | null
  output: string | null
}

export interface TriggerContext {
  issueNumber: number
  title: string
  body: string
  comments: string // all issue comments formatted as "[user]: body"
  triggerText: string // the specific comment/body that contained @kronk-bot
  processingCommentId: number // ID of the "⏳ Processing..." placeholder comment
  outputFile: string // absolute path where the agent must write its JSON response
  triggerSource: 'issue' | 'pr' // whether the bot was triggered from an issue or a PR comment
  pullRequests: PullRequestInfo[] // all PRs (open, closed, merged) for this issue's branch
  checkRuns?: CheckRun[] // CI check run statuses for the open PR, if any
}