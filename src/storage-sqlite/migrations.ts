import { createHash } from "node:crypto";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import type Database from "better-sqlite3";

interface MigrationRow {
  readonly version: number;
  readonly hash: string;
}

export function runMigrations(database: Database.Database, directory: string): void {
  database.exec(`
    CREATE TABLE IF NOT EXISTS schema_migrations (
      version INTEGER PRIMARY KEY,
      filename TEXT NOT NULL UNIQUE,
      hash TEXT NOT NULL,
      applied_at TEXT NOT NULL
    )
  `);
  const applied = new Map(
    (database.prepare("SELECT version, hash FROM schema_migrations").all() as MigrationRow[])
      .map((row) => [row.version, row.hash])
  );
  const files = readdirSync(directory)
    .filter((name) => /^\d{3}_[a-z0-9_]+\.sql$/u.test(name))
    .sort();

  for (const filename of files) {
    const version = Number.parseInt(filename.slice(0, 3), 10);
    const sql = readFileSync(join(directory, filename), "utf8");
    const hash = createHash("sha256").update(sql).digest("hex");
    const existing = applied.get(version);
    if (existing !== undefined) {
      if (existing !== hash) throw new Error(`Applied migration ${filename} has changed`);
      continue;
    }
    database.transaction(() => {
      database.exec(sql);
      database.prepare(`
        INSERT INTO schema_migrations(version, filename, hash, applied_at)
        VALUES (?, ?, ?, ?)
      `).run(version, filename, hash, new Date().toISOString());
    })();
  }
}
