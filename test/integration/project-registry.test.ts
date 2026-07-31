import assert from "node:assert/strict";
import { mkdir, realpath, rename, symlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { mkdtemp } from "node:fs/promises";
import { test } from "node:test";
import { ProjectRegistry } from "../../src/core/application/project-registry.js";
import { DomainError } from "../../src/core/domain/errors.js";

test("Project Registry rejects traversal, symlink aliases and directory replacement", async (context) => {
  const root = await mkdtemp(join(tmpdir(), "agentlink-project-"));
  context.after(async () => {
    const { rm } = await import("node:fs/promises");
    await rm(root, { recursive: true, force: true });
  });
  const project = join(root, "project");
  const alias = join(root, "alias");
  await mkdir(project);
  await symlink(project, alias);
  const registry = new ProjectRegistry();
  await assert.rejects(
    registry.register({
      id: "p0", slug: "traversal", path: `${project}/../project`,
      allowedAgents: ["fake"], defaultAgent: "fake"
    }),
    (error) => error instanceof DomainError && error.code === "project_path_invalid"
  );
  await assert.rejects(
    registry.register({
      id: "p1", slug: "alias", path: alias,
      allowedAgents: ["fake"], defaultAgent: "fake"
    }),
    (error) => error instanceof DomainError && error.code === "project_symlink_rejected"
  );
  await registry.register({
    id: "p2", slug: "real", path: project,
    allowedAgents: ["fake"], defaultAgent: "fake"
  });
  assert.equal((await registry.resolve("real", "fake")).canonicalPath, await realpath(project));
  await rename(project, `${project}-old`);
  await mkdir(project);
  await assert.rejects(
    registry.resolve("real"),
    (error) => error instanceof DomainError && error.code === "project_identity_changed"
  );
});
