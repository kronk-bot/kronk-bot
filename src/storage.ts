import Database from 'better-sqlite3'
import type { Database as DB } from 'better-sqlite3'

const MIGRATIONS: string[] = [
  // v1: initial schema
  `
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
