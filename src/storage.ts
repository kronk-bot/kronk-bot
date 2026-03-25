import type { Database as DB } from 'better-sqlite3'
import Database from 'better-sqlite3'

export type TriggerSourceType = 'issue_body' | 'issue_comment' | 'pr_body' | 'pr_comment'
export type TriggerStatus = 'pending' | 'processing' | 'done' | 'failed' | 'superseded'

export type NewTriggerData = Omit<Trigger, 'status' | 'started_at' | 'completed_at' | 'error'>

export interface Trigger {
  id: string
  repo: string
  source_type: TriggerSourceType
  source_id: string
  issue_number: number
  is_pr: boolean
  trigger_text: string
  status: TriggerStatus
  created_at: string
  started_at: string | null
  completed_at: string | null
  error: string | null
}

export interface Comment {
  id: string
  trigger_id: string
  issue_number: number
  comment_index: number
  github_comment_id: number
  body: string
  created_at: string
  updated_at: string | null
}

const MIGRATIONS: string[] = [
  // v1: initial schema
  `
  CREATE TABLE IF NOT EXISTS runs (
    id     INTEGER PRIMARY KEY,
    repo   TEXT NOT NULL,
    ran_at TEXT NOT NULL
  );
  `,
  // v2: triggers table
  `
  CREATE TABLE IF NOT EXISTS triggers (
    id                     TEXT    PRIMARY KEY,
    repo                   TEXT    NOT NULL,
    source_type            TEXT    NOT NULL,
    source_id              TEXT    NOT NULL,
    issue_number           INTEGER NOT NULL,
    is_pr                  INTEGER NOT NULL,
    trigger_text           TEXT    NOT NULL,
    status                 TEXT    NOT NULL DEFAULT 'pending',
    created_at             TEXT    NOT NULL,
    started_at             TEXT,
    completed_at           TEXT,
    placeholder_comment_id INTEGER,
    error                  TEXT,

    UNIQUE (repo, source_type, source_id)
  );

  CREATE INDEX IF NOT EXISTS idx_triggers_repo_status ON triggers (repo, status);
  CREATE INDEX IF NOT EXISTS idx_triggers_issue       ON triggers (repo, issue_number, status);
  `,
  // v3: comments table
  `
  CREATE TABLE IF NOT EXISTS comments (
    id                TEXT    PRIMARY KEY,
    trigger_id        TEXT    NOT NULL,
    issue_number      INTEGER NOT NULL,
    comment_index     INTEGER NOT NULL,
    github_comment_id INTEGER NOT NULL,
    body              TEXT    NOT NULL,
    created_at        TEXT    NOT NULL,
    updated_at        TEXT,

    FOREIGN KEY (trigger_id) REFERENCES triggers(id)
  );

  CREATE UNIQUE INDEX IF NOT EXISTS idx_comments_trigger_issue_index 
    ON comments(trigger_id, issue_number, comment_index);
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

  // --- runs ---

  getLastRunAt(repo: string): string {
    const row = this.db.prepare('SELECT ran_at FROM runs WHERE repo = ? ORDER BY id DESC LIMIT 1').get(repo) as
      | { ran_at: string }
      | undefined
    if (row) return row.ran_at
    return new Date().toISOString()
  }

  recordRun(repo: string, ranAt: string): void {
    this.db.transaction(() => {
      this.db.prepare('DELETE FROM runs WHERE repo = ?').run(repo)
      this.db.prepare('INSERT INTO runs (repo, ran_at) VALUES (?, ?)').run(repo, ranAt)
    })()
  }

  // --- triggers ---

  insertTrigger(trigger: NewTriggerData): boolean {
    return this.db.transaction(() => {
      const result = this.db
        .prepare(
          `
        INSERT OR IGNORE INTO triggers
          (id, repo, source_type, source_id, issue_number, is_pr, trigger_text, created_at)
        VALUES
          (@id, @repo, @source_type, @source_id, @issue_number, @is_pr, @trigger_text, @created_at)
      `
        )
        .run({ ...trigger, is_pr: trigger.is_pr ? 1 : 0 })

      if (result.changes === 0) return false

      // Supersede older pending triggers for the same issue
      this.db
        .prepare(
          `
        UPDATE triggers SET status = 'superseded'
        WHERE repo = ? AND issue_number = ? AND status = 'pending' AND id != ?
      `
        )
        .run(trigger.repo, trigger.issue_number, trigger.id)

      return true
    })()
  }

  getPendingTriggers(repo: string): Trigger[] {
    const rows = this.db
      .prepare(
        `
      SELECT * FROM triggers
      WHERE repo = ? AND status = 'pending'
        AND issue_number NOT IN (
          SELECT issue_number FROM triggers
          WHERE repo = ? AND status = 'processing'
        )
      ORDER BY created_at ASC
    `
      )
      .all(repo, repo) as (Omit<Trigger, 'is_pr'> & { is_pr: number })[]

    return rows.map((r) => this.coerceTrigger(r))
  }

  getStaleTriggers(repo: string, timeoutMs: number): Trigger[] {
    const cutoff = new Date(Date.now() - timeoutMs).toISOString()
    const rows = this.db
      .prepare(
        `
      SELECT * FROM triggers
      WHERE repo = ? AND status = 'processing' AND started_at < ?
    `
      )
      .all(repo, cutoff) as (Omit<Trigger, 'is_pr'> & { is_pr: number })[]

    return rows.map((r) => this.coerceTrigger(r))
  }

  markProcessing(id: string, startedAt: string): void {
    this.db
      .prepare(
        `
      UPDATE triggers SET status = 'processing', started_at = ? WHERE id = ?
    `
      )
      .run(startedAt, id)
  }

  markDone(id: string, completedAt: string): void {
    this.db
      .prepare(
        `
      UPDATE triggers SET status = 'done', completed_at = ? WHERE id = ?
    `
      )
      .run(completedAt, id)
  }

  markFailed(id: string, completedAt: string, error: string): void {
    this.db
      .prepare(
        `
      UPDATE triggers SET status = 'failed', completed_at = ?, error = ? WHERE id = ?
    `
      )
      .run(completedAt, error, id)
  }

  recoverStaleAndInsert(repo: string, staleIds: string[], newTriggers: NewTriggerData[]): void {
    this.db.transaction(() => {
      // Reset stale triggers to pending, preserving placeholder_comment_id for reuse
      const resetStmt = this.db.prepare(`UPDATE triggers SET status = 'pending', started_at = NULL WHERE id = ?`)
      for (const id of staleIds) {
        resetStmt.run(id)
      }

      // Insert new triggers with supersession
      const insertStmt = this.db.prepare(`
        INSERT OR IGNORE INTO triggers
          (id, repo, source_type, source_id, issue_number, is_pr, trigger_text, created_at)
        VALUES (@id, @repo, @source_type, @source_id, @issue_number, @is_pr, @trigger_text, @created_at)
      `)
      const supersedeStmt = this.db.prepare(`
        UPDATE triggers SET status = 'superseded'
        WHERE repo = ? AND issue_number = ? AND status = 'pending' AND id != ?
      `)
      for (const t of newTriggers) {
        const result = insertStmt.run({ ...t, is_pr: t.is_pr ? 1 : 0 })
        if (result.changes === 0) continue
        supersedeStmt.run(t.repo, t.issue_number, t.id)
      }
    })()
  }

  // --- comments ---

  insertComment(comment: Omit<Comment, 'id' | 'created_at' | 'updated_at'>): string {
    const id = crypto.randomUUID()
    const createdAt = new Date().toISOString()
    this.db
      .prepare(
        `
      INSERT INTO comments (id, trigger_id, issue_number, comment_index, github_comment_id, body, created_at)
      VALUES (?, ?, ?, ?, ?, ?, ?)
    `
      )
      .run(
        id,
        comment.trigger_id,
        comment.issue_number,
        comment.comment_index,
        comment.github_comment_id,
        comment.body,
        createdAt
      )
    return id
  }

  updateComment(triggerId: string, issueNumber: number, commentIndex: number, body: string): void {
    const updatedAt = new Date().toISOString()
    this.db
      .prepare(
        `
      UPDATE comments SET body = ?, updated_at = ?
      WHERE trigger_id = ? AND issue_number = ? AND comment_index = ?
    `
      )
      .run(body, updatedAt, triggerId, issueNumber, commentIndex)
  }

  getComments(triggerId: string, issueNumber?: number): Comment[] {
    if (issueNumber !== undefined) {
      return this.db
        .prepare(
          `
        SELECT * FROM comments 
        WHERE trigger_id = ? AND issue_number = ?
        ORDER BY comment_index ASC
      `
        )
        .all(triggerId, issueNumber) as Comment[]
    } else {
      return this.db
        .prepare(
          `
        SELECT * FROM comments 
        WHERE trigger_id = ?
        ORDER BY issue_number, comment_index ASC
      `
        )
        .all(triggerId) as Comment[]
    }
  }

  getNextCommentIndex(triggerId: string, issueNumber: number): number {
    const row = this.db
      .prepare(
        `
      SELECT MAX(comment_index) as max_index FROM comments
      WHERE trigger_id = ? AND issue_number = ?
    `
      )
      .get(triggerId, issueNumber) as { max_index: number | null } | undefined
    return (row?.max_index ?? 0) + 1
  }

  // --- lifecycle ---

  close(): void {
    this.db.close()
  }

  private coerceTrigger(row: Omit<Trigger, 'is_pr'> & { is_pr: number }): Trigger {
    return { ...row, is_pr: row.is_pr === 1 }
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
