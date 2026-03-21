import { App, Octokit } from 'octokit'
import type { Config } from './config.js'

export interface GithubIssue {
  number: number
  title: string
  body: string | null
  updated_at: string
}

export interface GithubComment {
  id: number
  user: string
  body: string
  created_at: string
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
    const { token } = await this.octokit.auth({ type: 'installation' }) as { token: string }
    return token
  }

  private mapIssues(data: Array<{ number: number; title: string; body?: string | null; updated_at: string; user?: { type?: string } | null }>): GithubIssue[] {
    return data
      .filter((i) => i.user?.type !== 'Bot')
      .map((i) => ({ number: i.number, title: i.title, body: i.body ?? null, updated_at: i.updated_at }))
  }

  async getOpenIssues(): Promise<GithubIssue[]> {
    const { data } = await this.octokit.rest.issues.listForRepo({
      owner: this.owner,
      repo: this.repo,
      state: 'open',
      per_page: 100,
    })
    return this.mapIssues(data)
  }

  async getIssuesUpdatedSince(since: string): Promise<GithubIssue[]> {
    const { data } = await this.octokit.rest.issues.listForRepo({
      owner: this.owner,
      repo: this.repo,
      state: 'open',
      since,
      per_page: 100,
    })
    return this.mapIssues(data)
  }

  async getIssueComments(issueNumber: number): Promise<GithubComment[]> {
    const { data } = await this.octokit.rest.issues.listComments({
      owner: this.owner,
      repo: this.repo,
      issue_number: issueNumber,
      per_page: 100,
    })
    return data
      .filter((c) => c.body)
      .map((c) => ({ id: c.id, user: c.user?.login ?? 'unknown', body: c.body!, created_at: c.created_at }))
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
}
