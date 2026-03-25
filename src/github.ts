import { App, Octokit } from 'octokit'
import type { Config } from './config.js'

export interface GithubIssue {
  number: number
  title: string
  body: string | null
  user: string
  updated_at: string
  state: 'open' | 'closed'
  isPR: boolean
}

export interface GithubComment {
  id: number
  user: string
  body: string
  created_at: string
}

export interface GithubRepoComment extends GithubComment {
  issueNumber: number
}

export interface PullRequestInfo {
  number: number
  title: string
  body: string
  state: 'open' | 'closed' | 'merged'
  branch: string
  url: string
}

export interface GithubAppInstallation {
  installationId: number
  owner: string
  repo: string
  fullName: string
  defaultBranch: string
}

export class GithubAppClient {
  private readonly app: App

  constructor(config: Config) {
    this.app = new App({
      appId: config.githubAppId,
      privateKey: config.githubAppPrivateKey,
    })
  }

  async getBotLogin(): Promise<string> {
    const { data } = await this.app.octokit.rest.apps.getAuthenticated()
    const app = data as unknown as { slug?: string; name: string }
    return `${app.slug ?? app.name}[bot]`
  }

  async listAllInstallations(): Promise<GithubAppInstallation[]> {
    const result: GithubAppInstallation[] = []
    for await (const { installation } of this.app.eachInstallation.iterator()) {
      for await (const { repository } of this.app.eachRepository.iterator({ installationId: installation.id })) {
        result.push({
          installationId: installation.id,
          owner: repository.owner.login,
          repo: repository.name,
          fullName: `${repository.owner.login}/${repository.name}`,
          defaultBranch: repository.default_branch,
        })
      }
    }
    return result
  }

  async createRepoClient(installation: GithubAppInstallation): Promise<GithubClient> {
    const octokit = await this.app.getInstallationOctokit(installation.installationId)
    return new GithubClient(octokit, installation)
  }
}

export class GithubClient {
  private readonly octokit: Octokit
  private readonly owner: string
  private readonly repo: string

  constructor(octokit: Octokit, installation: GithubAppInstallation) {
    this.octokit = octokit
    this.owner = installation.owner
    this.repo = installation.repo
  }

  async getToken(): Promise<string> {
    const { token } = (await this.octokit.auth({ type: 'installation' })) as { token: string }
    return token
  }

  private mapIssues(
    data: Array<{
      number: number
      title: string
      body?: string | null
      updated_at: string
      state: string
      user?: { type?: string; login?: string } | null
      pull_request?: unknown
    }>
  ): GithubIssue[] {
    return data
      .filter((i) => i.user?.type !== 'Bot')
      .map((i) => ({
        number: i.number,
        title: i.title,
        body: i.body ?? null,
        user: i.user?.login ?? 'unknown',
        updated_at: i.updated_at,
        state: i.state === 'open' ? 'open' : 'closed',
        isPR: !!i.pull_request,
      }))
  }

  private mapComment(c: {
    id: number
    user?: { login?: string } | null
    body: string
    created_at: string
  }): GithubComment {
    return { id: c.id, user: c.user?.login ?? 'unknown', body: c.body, created_at: c.created_at }
  }

  async getIssue(issueNumber: number): Promise<GithubIssue | null> {
    try {
      const { data } = await this.octokit.rest.issues.get({
        owner: this.owner,
        repo: this.repo,
        issue_number: issueNumber,
      })
      return {
        number: data.number,
        title: data.title,
        body: data.body ?? null,
        user: data.user?.login ?? 'unknown',
        updated_at: data.updated_at,
        state: data.state === 'open' ? 'open' : 'closed',
        isPR: !!data.pull_request,
      }
    } catch {
      return null
    }
  }

  async getIssuesUpdatedSince(since: string): Promise<GithubIssue[]> {
    const data = await this.octokit.paginate(this.octokit.rest.issues.listForRepo, {
      owner: this.owner,
      repo: this.repo,
      state: 'open',
      since,
      per_page: 100,
    })
    return this.mapIssues(data)
  }

  async getIssueComments(issueNumber: number): Promise<GithubComment[]> {
    const data = await this.octokit.paginate(this.octokit.rest.issues.listComments, {
      owner: this.owner,
      repo: this.repo,
      issue_number: issueNumber,
      per_page: 100,
    })
    return data.filter((c): c is typeof c & { body: string } => !!c.body).map((c) => this.mapComment(c))
  }

  async listNewComments(since: string): Promise<GithubRepoComment[]> {
    const data = await this.octokit.paginate(this.octokit.rest.issues.listCommentsForRepo, {
      owner: this.owner,
      repo: this.repo,
      since,
      per_page: 100,
    })
    return data
      .filter((c): c is typeof c & { body: string } => !!c.body)
      .map((c) => ({ ...this.mapComment(c), issueNumber: parseInt(c.issue_url.split('/').pop()!, 10) }))
  }

  async addComment(issueNumber: number, body: string): Promise<number> {
    const { data } = await this.octokit.rest.issues.createComment({
      owner: this.owner,
      repo: this.repo,
      issue_number: issueNumber,
      body,
    })
    return data.id
  }

  async editComment(commentId: number, body: string): Promise<void> {
    await this.octokit.rest.issues.updateComment({
      owner: this.owner,
      repo: this.repo,
      comment_id: commentId,
      body,
    })
  }

  async deleteBranch(branch: string): Promise<void> {
    await this.octokit.rest.git
      .deleteRef({
        owner: this.owner,
        repo: this.repo,
        ref: `heads/${branch}`,
      })
      .catch(() => {}) // ignore if branch doesn't exist
  }

  async getPullRequestInfo(prNumber: number): Promise<PullRequestInfo | null> {
    try {
      const { data: pr } = await this.octokit.rest.pulls.get({
        owner: this.owner,
        repo: this.repo,
        pull_number: prNumber,
      })
      return {
        number: pr.number,
        title: pr.title,
        body: pr.body ?? '',
        state: pr.merged_at ? 'merged' : pr.state === 'closed' ? 'closed' : 'open',
        branch: pr.head.ref,
        url: pr.html_url,
      }
    } catch {
      return null
    }
  }

  async listBotPullRequestsForIssue(issueNumber: number, botLogin: string): Promise<PullRequestInfo[]> {
    const prefix = `kronk/${issueNumber}-`
    const data = await this.octokit.paginate(this.octokit.rest.pulls.list, {
      owner: this.owner,
      repo: this.repo,
      state: 'all',
      per_page: 100,
    })
    return data
      .filter((pr) => pr.user?.login === botLogin && pr.head.ref.startsWith(prefix))
      .map((pr) => ({
        number: pr.number,
        title: pr.title,
        body: pr.body ?? '',
        state: pr.merged_at ? 'merged' : pr.state === 'closed' ? 'closed' : 'open',
        branch: pr.head.ref,
        url: pr.html_url,
      }))
  }

  async getCheckRuns(
    ref: string
  ): Promise<{ name: string; status: string; conclusion: string | null; output: string | null }[]> {
    const data = await this.octokit.paginate(this.octokit.rest.checks.listForRef, {
      owner: this.owner,
      repo: this.repo,
      ref,
      per_page: 100,
    })
    return data.map((run) => ({
      name: run.name,
      status: run.status,
      conclusion: run.conclusion ?? null,
      output: run.output?.summary ? run.output.summary.slice(0, 2000) : null,
    }))
  }

  async updatePullRequest(prNumber: number, title: string, body: string): Promise<void> {
    await this.octokit.rest.pulls.update({
      owner: this.owner,
      repo: this.repo,
      pull_number: prNumber,
      title,
      body,
    })
  }

  async createPullRequest(title: string, body: string, head: string, base: string, draft = false): Promise<string> {
    const { data } = await this.octokit.rest.pulls.create({
      owner: this.owner,
      repo: this.repo,
      title,
      body,
      head,
      base,
      draft,
    })
    return data.html_url
  }
}
