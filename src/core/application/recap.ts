import type { AgentSession, Turn } from "../domain/model.js";
import { summarizeText } from "./mobile-text.js";

export function renderRecap(
  session: AgentSession,
  turns: readonly Turn[],
  displaySessionId = session.id
): string {
  const ordered = [...turns].sort((left, right) => left.inputSequence - right.inputSequence);
  const completed = ordered.filter((turn) => turn.state === "COMPLETED");
  const last = completed.at(-1);
  const active = ordered.find((turn) =>
    turn.state === "DISPATCHED" ||
    turn.state === "RUNNING" ||
    turn.state === "WAITING_AGENT_APPROVAL"
  );
  const queued = ordered.filter((turn) => turn.state === "QUEUED" || turn.state === "PAUSED").length;
  return [
    `Session：${session.displayName}（${displaySessionId}）· ${session.state}`,
    `Runtime：${session.runtimeState}`,
    `当前：${active === undefined ? "空闲" : `${turnStateLabel(active.state)} · ${summarizeText(active.text)}`}`,
    `队列：${queued}`,
    `上次结果：${last?.finalResponse ?? "无"}`
  ].join("\n");
}

function turnStateLabel(state: Turn["state"]): string {
  if (state === "WAITING_AGENT_APPROVAL") return "等待审批";
  if (state === "DISPATCHED") return "提交中";
  return "执行中";
}
