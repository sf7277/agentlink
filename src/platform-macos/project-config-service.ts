import { randomUUID } from "node:crypto";
import { lstat } from "node:fs/promises";
import {
  gatewayConfigSchema,
  type GatewayConfig
} from "../composition/config-schema.js";
import { ProjectRegistry } from "../core/application/project-registry.js";
import { AtomicConfigStore } from "./atomic-config-store.js";

export class ProjectConfigService {
  public constructor(
    private readonly configPath: string,
    private readonly store = new AtomicConfigStore(configPath)
  ) {}

  public async list(): Promise<GatewayConfig["projects"]> {
    return (await this.load()).projects;
  }

  public async add(input: {
    readonly slug: string;
    readonly path: string;
    readonly allowedAgents: readonly string[];
    readonly defaultAgent?: string;
    readonly enabled?: boolean;
  }): Promise<GatewayConfig["projects"][number]> {
    const config = await this.load();
    if (config.projects.some((project) => project.slug === input.slug)) {
      throw new Error(`Project slug is already registered: ${input.slug}`);
    }
    const project = await this.validate({
      id: `project-${randomUUID()}`,
      ...input
    });
    if (config.projects.some((item) => item.path === project.path)) {
      throw new Error("Project path is already registered");
    }
    await this.store.save({ ...config, projects: [...config.projects, project] });
    return project;
  }

  public async update(input: {
    readonly slug: string;
    readonly path: string;
    readonly allowedAgents: readonly string[];
    readonly defaultAgent?: string;
  }): Promise<GatewayConfig["projects"][number]> {
    const config = await this.load();
    const current = config.projects.find((project) => project.slug === input.slug);
    if (current === undefined) throw new Error(`Project is not registered: ${input.slug}`);
    const project = await this.validate({
      id: current.id,
      ...input,
      defaultAgent: input.defaultAgent ?? current.defaultAgent,
      enabled: current.enabled
    });
    if (config.projects.some((item) =>
      item.id !== current.id && item.path === project.path
    )) {
      throw new Error("Project path is already registered");
    }
    await this.store.save({
      ...config,
      projects: config.projects.map((item) => item.id === current.id ? project : item)
    });
    return project;
  }

  public async remove(slug: string): Promise<void> {
    const config = await this.load();
    if (!config.projects.some((project) => project.slug === slug)) {
      throw new Error(`Project is not registered: ${slug}`);
    }
    await this.store.save({
      ...config,
      projects: config.projects.filter((project) => project.slug !== slug)
    });
  }

  public async disable(slug: string): Promise<GatewayConfig["projects"][number]> {
    return this.setEnabled(slug, false);
  }

  public async enable(slug: string): Promise<GatewayConfig["projects"][number]> {
    return this.setEnabled(slug, true);
  }

  private async validate(input: {
    readonly id: string;
    readonly slug: string;
    readonly path: string;
    readonly allowedAgents: readonly string[];
    readonly defaultAgent?: string;
    readonly enabled?: boolean;
  }): Promise<GatewayConfig["projects"][number]> {
    if (input.allowedAgents.length === 0) throw new Error("At least one Agent is required");
    const allowedAgents = [...new Set(input.allowedAgents)];
    const defaultAgent = input.defaultAgent ??
      (allowedAgents.length === 1 ? allowedAgents[0] : undefined);
    if (defaultAgent === undefined) {
      throw new Error("--default-agent is required when a Project allows multiple Agents");
    }
    if (!allowedAgents.includes(defaultAgent)) {
      throw new Error("Project default Agent must be included in allowed Agents");
    }
    const config = await this.load();
    if (config[defaultAgent as "codex" | "grok"] === undefined) {
      throw new Error(`Project default Agent is not configured: ${defaultAgent}`);
    }
    const registry = new ProjectRegistry();
    const registered = await registry.register({
      ...input,
      allowedAgents,
      defaultAgent
    });
    return {
      id: registered.id,
      slug: registered.slug,
      path: registered.canonicalPath,
      allowedAgents: [...registered.allowedAgents],
      defaultAgent: registered.defaultAgent,
      enabled: input.enabled ?? true
    };
  }

  private async setEnabled(
    slug: string,
    enabled: boolean
  ): Promise<GatewayConfig["projects"][number]> {
    const config = await this.load();
    const current = config.projects.find((project) => project.slug === slug);
    if (current === undefined) throw new Error(`Project is not registered: ${slug}`);
    const validated = await this.validate({ ...current, enabled });
    await this.store.save({
      ...config,
      projects: config.projects.map((project) =>
        project.id === current.id ? validated : project
      )
    });
    return validated;
  }

  private async load(): Promise<GatewayConfig> {
    const exists = await lstat(this.configPath).then(
      () => true,
      (error: NodeJS.ErrnoException) => {
        if (error.code === "ENOENT") return false;
        throw error;
      }
    );
    return exists ? this.store.load() : gatewayConfigSchema.parse({});
  }
}
