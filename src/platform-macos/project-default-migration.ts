import { lstat } from "node:fs/promises";
import Database from "better-sqlite3";
import { gatewayConfigSchema, type GatewayConfig } from "../composition/config-schema.js";
import { runMigrations } from "../storage-sqlite/migrations.js";
import { AtomicConfigStore } from "./atomic-config-store.js";

export interface ProjectDefaultMigrationResult {
  readonly configChanged: boolean;
  readonly databaseChanged: boolean;
}

export async function migrateProjectDefaults(input: {
  readonly configPath: string;
  readonly databasePath: string;
  readonly migrationsDirectory: string;
}): Promise<ProjectDefaultMigrationResult> {
  const configStore = new AtomicConfigStore(input.configPath);
  const raw = await configStore.loadDocument();
  const current = gatewayConfigSchema.safeParse(raw);
  const migrated = current.success ? current.data : migrateConfigDocument(raw);
  const databaseChanged = await migrateDatabase(
    input.databasePath,
    input.migrationsDirectory
  );
  if (!current.success) await configStore.save(migrated);
  return { configChanged: !current.success, databaseChanged };
}

function migrateConfigDocument(raw: unknown): GatewayConfig {
  if (raw === null || typeof raw !== "object" || Array.isArray(raw)) {
    throw new Error("Legacy AgentLink config must be an object");
  }
  const document = raw as Record<string, unknown>;
  if (!Array.isArray(document["projects"])) {
    throw new Error("Legacy AgentLink config projects must be an array");
  }
  const projects = document["projects"].map((value, index) => {
    if (value === null || typeof value !== "object" || Array.isArray(value)) {
      throw new Error(`Legacy Project at index ${index} must be an object`);
    }
    const project = value as Record<string, unknown>;
    if (project["defaultAgent"] !== undefined) return project;
    const allowedAgents = project["allowedAgents"];
    if (
      !Array.isArray(allowedAgents) ||
      allowedAgents.length === 0 ||
      allowedAgents.some((agent) => typeof agent !== "string" || agent === "")
    ) {
      throw new Error(`Legacy Project at index ${index} has invalid allowedAgents`);
    }
    return {
      ...project,
      defaultAgent: chooseDefaultAgent(
        allowedAgents,
        typeof project["slug"] === "string" ? project["slug"] : `index ${index}`
      )
    };
  });
  return gatewayConfigSchema.parse({ ...document, projects });
}

async function migrateDatabase(
  path: string,
  migrationsDirectory: string
): Promise<boolean> {
  if (await exists(path) === false) return false;
  const database = new Database(path);
  try {
    const projectTable = database.prepare(`
      SELECT 1 AS present FROM sqlite_master
      WHERE type = 'table' AND name = 'projects'
    `).get() as { present: 1 } | undefined;
    if (projectTable === undefined) {
      runMigrations(database, migrationsDirectory);
      return true;
    }
    const columns = database.prepare("PRAGMA table_info(projects)").all() as {
      name: string;
    }[];
    if (columns.some((column) => column.name === "default_agent")) {
      runMigrations(database, migrationsDirectory);
      return false;
    }
    const rows = database.prepare(
      "SELECT slug, allowed_agents_json FROM projects ORDER BY slug"
    ).all() as { slug: string; allowed_agents_json: string }[];
    for (const row of rows) {
      let agents: unknown;
      try {
        agents = JSON.parse(row.allowed_agents_json) as unknown;
      } catch {
        throw new Error(`Stored Project ${row.slug} has invalid allowed Agents JSON`);
      }
      if (
        !Array.isArray(agents) ||
        agents.length === 0 ||
        agents.some((agent) => typeof agent !== "string" || agent === "")
      ) {
        throw new Error(`Stored Project ${row.slug} has invalid allowed Agents`);
      }
      chooseDefaultAgent(agents as string[], row.slug);
    }
    runMigrations(database, migrationsDirectory);
    return true;
  } finally {
    database.close();
  }
}

function chooseDefaultAgent(allowedAgents: readonly string[], project: string): string {
  const unique = [...new Set(allowedAgents)];
  if (unique.length === 1) return unique[0]!;
  if (unique.includes("codex")) return "codex";
  throw new Error(
    `Project ${project} allows multiple Agents without Codex; choose --default-agent before upgrade`
  );
}

async function exists(path: string): Promise<boolean> {
  return lstat(path).then(
    () => true,
    (error: NodeJS.ErrnoException) => {
      if (error.code === "ENOENT") return false;
      throw error;
    }
  );
}
