import type { TurnAdmissionGate } from "../core/contracts/ports.js";
import { DomainError } from "../core/domain/errors.js";
import type { VerifiedUpdate } from "./signed-update-manifest.js";

export type UpdateState =
  | "idle"
  | "preparing"
  | "ready"
  | "installing"
  | "installed"
  | "failed"
  | "blocked";

export interface UpdateRuntimeSnapshot {
  readonly runtimeId: string;
  readonly state: "ALIVE" | "EXITED" | "UNKNOWN";
  readonly activeTurn: boolean;
}

export interface UpdateRuntimeInspector {
  snapshots(): Promise<readonly UpdateRuntimeSnapshot[]>;
}

export interface ReleaseInstaller {
  install(input: {
    readonly sourcePath: string;
    readonly targetPath: string;
    readonly expectedSha256: string;
    readonly expectedSize: number;
  }): Promise<void>;
}

export interface UpdateStatus {
  readonly state: UpdateState;
  readonly releaseVersion?: string;
  readonly currentAdapterStatus?: "verified" | "incompatible";
  readonly reason?: "active_runtime" | "runtime_unknown" | "install_failed" | "replacement_unknown";
}

export class UpdateCoordinator implements TurnAdmissionGate {
  #state: UpdateState = "idle";
  #reason: UpdateStatus["reason"];
  #prepared: {
    readonly update: VerifiedUpdate;
    readonly sourcePath: string;
    readonly targetPath: string;
  } | undefined;

  public constructor(
    private readonly runtimes: UpdateRuntimeInspector,
    private readonly installer: ReleaseInstaller
  ) {}

  public status(): UpdateStatus {
    return {
      state: this.#state,
      ...(this.#prepared === undefined
        ? {}
        : {
            releaseVersion: this.#prepared.update.manifest.releaseVersion,
            currentAdapterStatus: this.#prepared.update.currentAdapterStatus
          }),
      ...(this.#reason === undefined ? {} : { reason: this.#reason })
    };
  }

  public assertCanStartTurn(_sessionId: string, _controllerEndpointId: string): void {
    if (
      this.#state === "preparing" ||
      this.#state === "ready" ||
      this.#state === "installing" ||
      this.#state === "blocked"
    ) {
      throw new DomainError("update_in_progress", "New Turns are disabled while an update is prepared");
    }
  }

  public async prepare(input: {
    readonly update: VerifiedUpdate;
    readonly sourcePath: string;
    readonly targetPath: string;
  }): Promise<UpdateStatus> {
    if (
      this.#state !== "idle" &&
      this.#state !== "failed" &&
      this.#state !== "installed"
    ) {
      throw new DomainError("update_state_invalid", "An update is already being prepared");
    }
    this.#prepared = input;
    this.#state = "preparing";
    this.#reason = undefined;
    return this.refreshPreparation();
  }

  public async refreshPreparation(): Promise<UpdateStatus> {
    if (this.#prepared === undefined || this.#state !== "preparing") {
      throw new DomainError("update_state_invalid", "No update preparation is active");
    }
    const snapshots = await this.runtimes.snapshots();
    if (snapshots.some((runtime) => runtime.state === "UNKNOWN")) {
      this.#reason = "runtime_unknown";
      return this.status();
    }
    if (snapshots.some((runtime) => runtime.activeTurn)) {
      this.#reason = "active_runtime";
      return this.status();
    }
    this.#reason = undefined;
    this.#state = "ready";
    return this.status();
  }

  public async confirmInstall(source: "local" | "mobile"): Promise<UpdateStatus> {
    if (source !== "local") {
      throw new DomainError("local_confirmation_required", "Software installation requires local confirmation");
    }
    if (this.#prepared === undefined || this.#state !== "ready") {
      throw new DomainError("update_not_ready", "Update is not ready for installation");
    }
    const snapshots = await this.runtimes.snapshots();
    if (snapshots.some((runtime) => runtime.state === "UNKNOWN")) {
      this.#state = "preparing";
      this.#reason = "runtime_unknown";
      throw new DomainError("runtime_unknown", "Runtime state is unknown; replacement is forbidden");
    }
    if (snapshots.some((runtime) => runtime.activeTurn)) {
      this.#state = "preparing";
      this.#reason = "active_runtime";
      throw new DomainError("active_runtime", "An active Turn must finish or be explicitly interrupted");
    }
    this.#state = "installing";
    try {
      await this.installer.install({
        sourcePath: this.#prepared.sourcePath,
        targetPath: this.#prepared.targetPath,
        expectedSha256: this.#prepared.update.manifest.artifact.sha256,
        expectedSize: this.#prepared.update.manifest.artifact.size
      });
      this.#state = "installed";
      this.#reason = undefined;
    } catch (error) {
      if (error instanceof AtomicInstallError && error.replacementState === "unknown") {
        this.#state = "blocked";
        this.#reason = "replacement_unknown";
      } else {
        this.#state = "failed";
        this.#reason = "install_failed";
      }
      throw error;
    }
    return this.status();
  }
}

export class AtomicInstallError extends Error {
  public constructor(
    public readonly replacementState: "unchanged" | "rolled_back" | "unknown",
    message: string,
    options?: ErrorOptions
  ) {
    super(message, options);
    this.name = "AtomicInstallError";
  }
}
