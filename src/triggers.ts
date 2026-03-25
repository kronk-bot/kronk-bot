import { randomUUID } from 'crypto'
import type { Config } from './config.js'
import type { GithubClient } from './github.js'
import type { NewTriggerData } from './storage.js'
import { logger } from './logger.js'

function isAllowed(user: string, config: Config): boolean {
  return config.allowedUsers.length === 0 || config.allowedUsers.includes(user)
}

export async function fetchBodyTriggers(
  config: Config,
  github: GithubClient,
  repoFullName: string,
  since: string
): Promise<NewTriggerData[]> {
  const triggerWord = config.triggerWord
  const updatedIssues = await github.getIssuesUpdatedSince(since)
  const results: NewTriggerData[] = []

  for (const issue of updatedIssues) {
    if (!isAllowed(issue.user, config)) continue
    if (!issue.body?.includes(triggerWord)) continue
    results.push({
      id: randomUUID(),
      repo: repoFullName,
      source_type: issue.isPR ? 'pr_body' : 'issue_body',
      source_id: String(issue.number),
      issue_number: issue.number,
      is_pr: issue.isPR,
      trigger_text: issue.body,
      created_at: issue.updated_at,
    })
  }

  return results
}

export async function fetchCommentTriggers(
  config: Config,
  github: GithubClient,
  botLogin: string,
  repoFullName: string,
  since: string
): Promise<NewTriggerData[]> {
  const triggerWord = config.triggerWord

  const newComments = await github.listNewComments(since)
  const triggerComments = newComments.filter(
    (c) => c.user !== botLogin && c.body.includes(triggerWord) && isAllowed(c.user, config)
  )

  const byIssue = new Map<number, typeof newComments[number][]>()
  for (const comment of triggerComments) {
    const group = byIssue.get(comment.issueNumber) ?? []
    group.push(comment)
    byIssue.set(comment.issueNumber, group)
  }

  const grouped = await Promise.all(
    [...byIssue.entries()].map(async ([issueNumber, comments]) => {
      const issue = await github.getIssue(issueNumber)
      if (!issue) {
        logger.warn({ repo: repoFullName, issueNumber }, 'issue not found, skipping comment triggers')
        return []
      }
      return comments.map(
        (comment): NewTriggerData => ({
          id: randomUUID(),
          repo: repoFullName,
          source_type: issue.isPR ? 'pr_comment' : 'issue_comment',
          source_id: String(comment.id),
          issue_number: issueNumber,
          is_pr: issue.isPR,
          trigger_text: comment.body,
          created_at: comment.created_at,
        })
      )
    })
  )

  return grouped.flat()
}
