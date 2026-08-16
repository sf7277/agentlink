export const WINDOWS_FOREGROUND_READY_NOTICE =
  "AgentLink服务已启动，请保持本窗口开启状态，退出请按 Ctrl+C。\n";

export function writeWindowsForegroundReadyNotice(
  output: { write(chunk: string): unknown } = process.stdout
): void {
  output.write(WINDOWS_FOREGROUND_READY_NOTICE);
}
