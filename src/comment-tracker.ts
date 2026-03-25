import type { GithubClient } from './github.js'
import type { Storage } from './storage.js'
import { StatsProvider } from './stats-provider.js'
import { formatStatsFooter } from './utils.js'
import { logger } from './logger.js'

export class CommentTracker {
  // Map of issue_number -> Map of index -> github_comment_id
  private comments = new Map<number, Map<number, number>>()

  constructor(
    private readonly triggerId: string,
    private readonly github: GithubClient,
    private readonly storage: Storage,
    private readonly statsProvider: StatsProvider
  ) {}

  async addComment(issueNumber: number, body: string): Promise<{ index: number; githubCommentId: number }> {
    const issueComments = this.comments.get(issueNumber) ?? new Map<number, number>()
    const index = this.storage.getNextCommentIndex(this.triggerId, issueNumber)

    // Add stats footer
    const fullBody = this.appendStatsFooter(body)

    // Create GitHub comment
    const githubCommentId = await this.github.addComment(issueNumber, fullBody)

    // Track in memory
    issueComments.set(index, githubCommentId)
    this.comments.set(issueNumber, issueComments)

    // Persist to database
    this.storage.insertComment({
      trigger_id: this.triggerId,
      issue_number: issueNumber,
      comment_index: index,
      github_comment_id: githubCommentId,
      body: fullBody,
    })

    logger.info({ triggerId: this.triggerId, issueNumber, index, githubCommentId }, 'comment added')

    return { index, githubCommentId }
  }

  async editComment(issueNumber: number, index: number, body: string): Promise<void> {
    const issueComments = this.comments.get(issueNumber)
    if (!issueComments) {
      throw new Error(`No comments found for issue ${issueNumber}`)
    }

    const githubCommentId = issueComments.get(index)
    if (!githubCommentId) {
      throw new Error(`Comment ${index} not found for issue ${issueNumber}`)
    }

    // Add stats footer
    const fullBody = this.appendStatsFooter(body)

    // Edit GitHub comment
    await this.github.editComment(githubCommentId, fullBody)

    // Update in database
    this.storage.updateComment(this.triggerId, issueNumber, index, fullBody)

    logger.info({ triggerId: this.triggerId, issueNumber, index, githubCommentId }, 'comment edited')
  }

  listComments(issueNumber: number): { index: number; bodyPreview: string }[] {
    const stored = this.storage.getComments(this.triggerId, issueNumber)
    return stored.map((c) => ({
      index: c.comment_index,
      bodyPreview: c.body.slice(0, 200) + (c.body.length > 200 ? '...' : ''),
    }))
  }

  private appendStatsFooter(body: string): string {
    return body + formatStatsFooter(this.statsProvider.getStats())
  }
}
