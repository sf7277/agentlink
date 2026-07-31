import assert from "node:assert/strict";
import { test } from "node:test";
import { DomainError } from "../../src/core/domain/errors.js";
import type { VerifiedUpdate } from "../../src/update/signed-update-manifest.js";
import {
  AtomicInstallError,
  UpdateCoordinator,
  type ReleaseInstaller,
  type UpdateRuntimeSnapshot
} from "../../src/update/update-coordinator.js";

const update: VerifiedUpdate = {
  currentAdapterStatus: "incompatible",
  manifest: {
    schemaVersion: 1,
    product: "agentlink",
    releaseVersion: "0.2.0",
    issuedAt: "2026-07-19T00:00:00.000Z",
    expiresAt: "2026-07-20T00:00:00.000Z",
    target: { os: "darwin", arch: "arm64" },
    artifact: {
      url: "https://releases.agentlink.invalid/stable/update.bin",
      sha256: "a".repeat(64),
      size: 100
    },
    compatibilityMatrix: [{
      adapterVersion: "0.1.0",
      protocolRevision: "ilink-backend-v1",
      status: "incompatible",
      capabilities: ["text"],
      verifiedAt: "2026-07-19T00:00:00.000Z"
    }],
    requiresLocalConfirmation: true
  }
};

class FakeInstaller implements ReleaseInstaller {
  readonly calls: unknown[] = [];
  error: Error | undefined;
  public async install(input: unknown): Promise<void> {
    this.calls.push(input);
    if (this.error !== undefined) throw this.error;
  }
}

test("preparing an update closes Turn admission and waits for active Runtime", async () => {
  let snapshots: UpdateRuntimeSnapshot[] = [{
    runtimeId: "runtime-1",
    state: "ALIVE",
    activeTurn: true
  }];
  const installer = new FakeInstaller();
  const coordinator = new UpdateCoordinator(
    { snapshots: async () => snapshots },
    installer
  );
  assert.deepEqual(await coordinator.prepare({
    update,
    sourcePath: "/private/staged",
    targetPath: "/private/current"
  }), {
    state: "preparing",
    releaseVersion: "0.2.0",
    currentAdapterStatus: "incompatible",
    reason: "active_runtime"
  });
  assert.throws(
    () => coordinator.assertCanStartTurn("session", "wechat"),
    (error) => error instanceof DomainError && error.code === "update_in_progress"
  );

  snapshots = [{ runtimeId: "runtime-1", state: "ALIVE", activeTurn: false }];
  assert.equal((await coordinator.refreshPreparation()).state, "ready");
  await assert.rejects(
    coordinator.confirmInstall("mobile"),
    (error) => error instanceof DomainError && error.code === "local_confirmation_required"
  );
  assert.equal(installer.calls.length, 0);
  assert.equal((await coordinator.confirmInstall("local")).state, "installed");
  assert.equal(installer.calls.length, 1);
});

test("Runtime becoming unknown immediately before replacement fails closed", async () => {
  let snapshots: UpdateRuntimeSnapshot[] = [];
  const coordinator = new UpdateCoordinator(
    { snapshots: async () => snapshots },
    new FakeInstaller()
  );
  assert.equal((await coordinator.prepare({
    update,
    sourcePath: "/private/staged",
    targetPath: "/private/current"
  })).state, "ready");
  snapshots = [{ runtimeId: "runtime-1", state: "UNKNOWN", activeTurn: false }];
  await assert.rejects(
    coordinator.confirmInstall("local"),
    (error) => error instanceof DomainError && error.code === "runtime_unknown"
  );
  assert.deepEqual(coordinator.status(), {
    state: "preparing",
    releaseVersion: "0.2.0",
    currentAdapterStatus: "incompatible",
    reason: "runtime_unknown"
  });
});

test("rolled-back failure reopens admission but uncertain replacement remains blocked", async () => {
  const installer = new FakeInstaller();
  const coordinator = new UpdateCoordinator(
    { snapshots: async () => [] },
    installer
  );
  await coordinator.prepare({
    update,
    sourcePath: "/private/staged",
    targetPath: "/private/current"
  });
  installer.error = new AtomicInstallError("rolled_back", "health check failed");
  await assert.rejects(coordinator.confirmInstall("local"), AtomicInstallError);
  assert.equal(coordinator.status().state, "failed");
  assert.doesNotThrow(() => coordinator.assertCanStartTurn("session", "local"));

  await coordinator.prepare({
    update,
    sourcePath: "/private/staged",
    targetPath: "/private/current"
  });
  installer.error = new AtomicInstallError("unknown", "rollback failed");
  await assert.rejects(coordinator.confirmInstall("local"), AtomicInstallError);
  assert.equal(coordinator.status().state, "blocked");
  assert.throws(
    () => coordinator.assertCanStartTurn("session", "local"),
    (error) => error instanceof DomainError && error.code === "update_in_progress"
  );
});
