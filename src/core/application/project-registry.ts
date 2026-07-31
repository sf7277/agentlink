import { lstat, realpath, stat } from "node:fs/promises";
import { isAbsolute, relative, resolve, sep } from "node:path";
import { DomainError } from "../domain/errors.js";

export interface ProjectDefinition {
  readonly id: string;
  readonly slug: string;
  readonly canonicalPath: string;
  readonly allowedAgents: readonly string[];
  readonly defaultAgent: string;
  readonly identity: {
    readonly device: bigint;
    readonly inode: bigint;
  };
}

export interface ProjectInput {
  readonly id: string;
  readonly slug: string;
  readonly path: string;
  readonly allowedAgents: readonly string[];
  readonly defaultAgent: string;
}

const slugPattern = /^[a-z][a-z0-9-]{0,62}$/u;

export class ProjectRegistry {
  readonly #projects = new Map<string, ProjectDefinition>();

  public async register(input: ProjectInput): Promise<ProjectDefinition> {
    if (!slugPattern.test(input.slug)) throw new DomainError("project_slug_invalid", "Invalid project slug");
    if (!isAbsolute(input.path)) throw new DomainError("project_path_invalid", "Project path must be absolute");
    if (input.path.split(sep).includes("..")) {
      throw new DomainError("project_path_invalid", "Project path must not contain parent traversal");
    }
    const lexical = resolve(input.path);
    const link = await lstat(lexical);
    if (link.isSymbolicLink()) {
      throw new DomainError("project_symlink_rejected", "Project path must not be a symbolic link");
    }
    const canonicalPath = await realpath(lexical);
    const metadata = await stat(canonicalPath, { bigint: true });
    if (!metadata.isDirectory()) {
      throw new DomainError("project_path_invalid", "Project path must be a real directory");
    }
    const definition: ProjectDefinition = {
      id: input.id,
      slug: input.slug,
      canonicalPath,
      allowedAgents: [...input.allowedAgents],
      defaultAgent: input.defaultAgent,
      identity: { device: metadata.dev, inode: metadata.ino }
    };
    this.#projects.set(input.slug, definition);
    return definition;
  }

  public async resolve(slug: string, agentKind?: string): Promise<ProjectDefinition> {
    const project = this.#projects.get(slug);
    if (project === undefined) throw new DomainError("project_not_registered", "Project is not registered");
    const currentPath = await realpath(project.canonicalPath);
    const metadata = await stat(currentPath, { bigint: true });
    if (
      currentPath !== project.canonicalPath ||
      metadata.dev !== project.identity.device ||
      metadata.ino !== project.identity.inode
    ) {
      throw new DomainError("project_identity_changed", "Registered project directory was replaced");
    }
    if (agentKind !== undefined && !project.allowedAgents.includes(agentKind)) {
      throw new DomainError("agent_not_allowed", "Agent is not allowed for this project");
    }
    return project;
  }

  public list(): readonly ProjectDefinition[] {
    return [...this.#projects.values()].sort((left, right) => left.slug.localeCompare(right.slug));
  }

  public unregister(slug: string): ProjectDefinition | undefined {
    const project = this.#projects.get(slug);
    this.#projects.delete(slug);
    return project;
  }

  public static isWithin(root: string, candidate: string): boolean {
    const child = relative(root, candidate);
    return child === "" || (!child.startsWith(`..${sep}`) && child !== ".." && !isAbsolute(child));
  }
}
