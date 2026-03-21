import Database from 'better-sqlite3'
import type { Database as DB } from 'better-sqlite3'

export interface Issue {
  repo: string
  number: number
  title: string
  body: string | null
  body_scanned: number // 0 or 1
  first_seen_at: string
  updated_at: string
}

const MIGRATIONS: string[] = [
  // v1: initial schema
  `
  CREATE TABLE IF NOT EXISTS issues (
    repo          TEXT NOT NULL,
    number        INTEGER NOT NULL,
    title         TEXT NOT NULL,
    body          TEXT,
    body_scanned  INTEGER NOT NULL DEFAULT 0,
    first_seen_at TEXT NOT NULL,
    updated_at    TEXT NOT NULL,
    PRIMARY KEY (repo, number)
  );

  CREATE TABLE IF NOT EXISTS runs (
    id     INTEGER PRIMARY KEY,
    repo   TEXT NOT NULL,
    ran_at TEXT NOT NULL
  );
  `,
]

export class Storage {
  private db: DB

  constructor(dbPath: string) {
    this.db = new Database(dbPath)
    this.db.pragma('journal_mode = WAL')
    this.db.pragma('foreign_keys = ON')
    this.migrate()
  }

  upsertIssue(repo: string, issue: { number: number; title: string; body: string | null }): void {
    const now = new Date().toISOString()
    this.db
      .prepare(
        `INSERT INTO issues (repo, number, title, body, first_seen_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?)
         ON CONFLICT(repo, number) DO UPDATE SET title = excluded.title, body = excluded.body, updated_at = excluded.updated_at`
      )
      .run(repo, issue.number, issue.title, issue.body, now, now)
  }

  getIssue(repo: string, number: number): Issue | null {
    return (this.db.prepare('SELECT * FROM issues WHERE repo = ? AND number = ?').get(repo, number) as Issue | undefined) ?? null
  }

  getUnscannedIssues(repo: string): Issue[] {
    return this.db.prepare('SELECT * FROM issues WHERE repo = ? AND body_scanned = 0').all(repo) as Issue[]
  }

  markBodyScanned(repo: string, issueNumber: number): void {
    this.db
      .prepare('UPDATE issues SET body_scanned = 1, updated_at = ? WHERE repo = ? AND number = ?')
      .run(new Date().toISOString(), repo, issueNumber)
  }

  getLastRunAt(repo: string): string {
    const row = this.db.prepare('SELECT ran_at FROM runs WHERE repo = ? ORDER BY id DESC LIMIT 1').get(repo) as
      | { ran_at: string }
      | undefined
    if (row) return row.ran_at
    return new Date().toISOString()
  }

  logRun(repo: string, ranAt: string): void {
    this.db.prepare('INSERT INTO runs (repo, ran_at) VALUES (?, ?)').run(repo, ranAt)
  }

  close(): void {
    this.db.close()
  }

  private migrate(): void {
    const version = this.db.pragma('user_version', { simple: true }) as number

    for (let i = version; i < MIGRATIONS.length; i++) {
      this.db.transaction(() => {
        this.db.exec(MIGRATIONS[i])
        this.db.pragma(`user_version = ${i + 1}`)
      })()
    }
  }
}
