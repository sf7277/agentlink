export type ReloadableWechatChannelStatus =
  | "HEALTHY"
  | "AUTHENTICATION_REQUIRED"
  | "DISABLED"
  | "UNKNOWN";

export function shouldReloadWechatChannel(input: {
  readonly stopping: boolean;
  readonly applicationReady: boolean;
  readonly channelPresent: boolean;
  readonly channelStatus: ReloadableWechatChannelStatus;
  readonly reloadInProgress: boolean;
}): boolean {
  if (input.stopping || !input.applicationReady || input.reloadInProgress) return false;
  return !input.channelPresent || input.channelStatus === "AUTHENTICATION_REQUIRED";
}
