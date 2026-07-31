import type Database from "better-sqlite3";

export interface StoredProject {
  readonly id: string;
  readonly slug: string;
  readonly canonicalPath: string;
  readonly allowedAgents: readonly string[];
  readonly defaultAgent: string;
  readonly enabled: boolean;
  readonly createdAt: string;
}

interface ProjectRow {
  id: string;
  slug: string;
  canonical_path: string;
  allowed_agents_json: string;
  default_agent: string;
  enabled: 0 | 1;
  created_at: string;
}

export class ProjectRepository {
  public constructor(private readonly database: Database.Database) {}

  public put(project: StoredProject): void {
    this.database.prepare(`
      INSERT INTO projects(
        id, slug, canonical_path, allowed_agents_json, default_agent, enabled, created_at
      )
      VALUES (?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(id) DO UPDATE SET
        slug = excluded.slug,
        canonical_path = excluded.canonical_path,
        allowed_agents_json = excluded.allowed_agents_json,
        default_agent = excluded.default_agent,
        enabled = excluded.enabled
    `).run(
      project.id,
      project.slug,
      project.canonicalPath,
      JSON.stringify(project.allowedAgents),
      project.defaultAgent,
      project.enabled ? 1 : 0,
      project.createdAt
    );
  }

  public findBySlug(slug: string): StoredProject | undefined {
    const row = this.database.prepare("SELECT * FROM projects WHERE slug = ?").get(slug) as
      | ProjectRow
      | undefined;
    return row === undefined ? undefined : {
      id: row.id,
      slug: row.slug,
      canonicalPath: row.canonical_path,
      allowedAgents: JSON.parse(row.allowed_agents_json) as string[],
      defaultAgent: row.default_agent,
      enabled: row.enabled === 1,
      createdAt: row.created_at
    };
  }

  public findById(id: string): StoredProject | undefined {
    const row = this.database.prepare("SELECT * FROM projects WHERE id = ?").get(id) as
      | ProjectRow
      | undefined;
    return row === undefined ? undefined : projectFromRow(row);
  }

  public list(): readonly StoredProject[] {
    return (this.database.prepare("SELECT * FROM projects ORDER BY slug").all() as ProjectRow[])
      .map(projectFromRow);
  }
}

function projectFromRow(row: ProjectRow): StoredProject {
  return {
    id: row.id,
    slug: row.slug,
    canonicalPath: row.canonical_path,
    allowedAgents: JSON.parse(row.allowed_agents_json) as string[],
    defaultAgent: row.default_agent,
    enabled: row.enabled === 1,
    createdAt: row.created_at
  };
}
