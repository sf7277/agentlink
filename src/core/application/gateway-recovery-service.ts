import type {
  Clock,
  ProcessRegistry,
  StateStore
} from "../contracts/ports.js";

export interface GatewayRecoveryReport {
  readonly reclaimedRuntimeIds: readonly string[];
  readonly explicitResumeSessionIds: readonly string[];
}

/**
 * Startup is deliberately conservative: persisted OPEN/RUNNING facts are not
 * trusted, and inherited stdio children cannot be transparently reattached.
 */
export class GatewayRecoveryService {
  public constructor(
    private readonly store: StateStore,
    private readonly processes: ProcessRegistry,
    private readonly clock: Clock
  ) {}

  public async recover(): Promise<GatewayRecoveryReport> {
    this.store.reconcileStartup(this.clock.now());
    const snapshots = await this.processes.snapshots();
    const reclaimedRuntimeIds: string[] = [];
    const explicitResumeSessionIds = new Set<string>();
    for (const snapshot of snapshots) {
      for (const sessionId of snapshot.affectedSessionIds) {
        explicitResumeSessionIds.add(sessionId);
      }
      if (snapshot.alive) {
        await this.processes.stop(snapshot.runtimeId);
        reclaimedRuntimeIds.push(snapshot.runtimeId);
      }
    }
    return {
      reclaimedRuntimeIds,
      explicitResumeSessionIds: [...explicitResumeSessionIds].sort()
    };
  }
}
