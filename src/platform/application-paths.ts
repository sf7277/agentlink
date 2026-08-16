export interface ApplicationPaths {
  readonly applicationSupport: string;
  readonly caches: string;
  readonly logs: string;
  readonly runtime: string;
  readonly releases: string;
  readonly backups: string;
  readonly config: string;
  readonly database: string;
  readonly socket: string;
  /** macOS LaunchAgent path; Windows keeps a deterministic marker path and never uses it. */
  readonly launchAgent: string;
}
