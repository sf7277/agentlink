import { normalizeInlineText } from "../../core/application/mobile-text.js";
import type {
  AgentApprovalRequest,
  MobileApprovalLease
} from "../../core/domain/model.js";

export interface WechatTextRendererOptions {
  readonly maxChunkCharacters?: number;
}

export class WechatTextRenderer {
  readonly #maxChunkCharacters: number;

  public constructor(options: WechatTextRendererOptions = {}) {
    this.#maxChunkCharacters = options.maxChunkCharacters ?? 1_800;
    if (!Number.isInteger(this.#maxChunkCharacters) || this.#maxChunkCharacters < 16) {
      throw new Error("WeChat chunk limit must be an integer of at least 16");
    }
  }

  public chunks(text: string): readonly string[] {
    const normalized = text.replace(/\r\n?/gu, "\n").trim();
    if (normalized === "") return ["（无文本输出）"];
    const raw = splitWithoutBreakingCodePoints(normalized, this.#maxChunkCharacters);
    if (raw.length === 1) return raw;
    return raw.map((chunk, index) => `[${index + 1}/${raw.length}]\n${chunk}`);
  }
}

export const approvalWaitingMessage =
  "Agent正在等待审批。单项可直接 /approve、/deny 或 /cancel；多项请先使用 /approvals。";

export function renderApprovalRequest(
  request: AgentApprovalRequest,
  lease: MobileApprovalLease,
  context: {
    readonly sessionName: string;
    readonly project: string;
    readonly now: string;
    readonly multiple: boolean;
  }
): string {
  const commands = context.multiple
    ? "当前有多项待审批，请 /approvals 后指定编号"
    : "允许 /approve · 拒绝 /deny · 停止 /cancel";
  return [
    `审批 · ${riskLabel(request.risk)} · ${context.sessionName}`,
    `项目：${context.project}`,
    `操作：${normalizeApprovalText(request.summary)}`,
    renderApprovalExpiry(lease.expiresAt, context.now),
    commands
  ].join("\n");
}

export function renderApprovalListItem(
  number: number,
  request: AgentApprovalRequest,
  _lease: MobileApprovalLease,
  sessionName: string,
  _now: string
): string {
  const summary = normalizeInlineText(request.summary)
    .replace(/^Codex请求permissions权限：/u, "Codex请求权限：");
  return `${number}. ${riskLabel(request.risk)} · ${sessionName} · ` +
    summary;
}

function riskLabel(risk: AgentApprovalRequest["risk"]): string {
  if (risk === "high") return "高风险";
  if (risk === "medium") return "中风险";
  return "低风险";
}

function normalizeApprovalText(text: string): string {
  const normalized = text
    .replace(/\r\n?/gu, "\n")
    .replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/gu, " ")
    .trim();
  return normalized === "" ? "（空操作）" : normalized;
}

function renderApprovalExpiry(expiresAt: string, now: string): string {
  const formatter = new Intl.DateTimeFormat("en-GB", {
    timeZone: "Asia/Shanghai",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    hourCycle: "h23"
  });
  const parts = Object.fromEntries(
    formatter.formatToParts(new Date(expiresAt))
      .map((part) => [part.type, part.value])
  );
  const remaining = remainingLabel(expiresAt, now).replace(/m$/u, "min");
  return `${remaining}内有效,${parts["year"]}-${parts["month"]}-${parts["day"]} ` +
    `${parts["hour"]}:${parts["minute"]}(UTC+8)到期`;
}

function remainingLabel(expiresAt: string, now: string): string {
  const remainingMs = Math.max(0, Date.parse(expiresAt) - Date.parse(now));
  if (remainingMs < 60_000) return "<1m";
  return `${Math.ceil(remainingMs / 60_000)}m`;
}

function splitWithoutBreakingCodePoints(text: string, limit: number): string[] {
  const result: string[] = [];
  let remaining = text;
  while ([...remaining].length > limit) {
    const codePoints = [...remaining];
    const candidate = codePoints.slice(0, limit).join("");
    const newline = candidate.lastIndexOf("\n");
    const whitespace = candidate.search(/\s+\S*$/u);
    const cut = newline >= Math.floor(limit / 2)
      ? newline + 1
      : whitespace >= Math.floor(limit / 2)
        ? whitespace + 1
        : candidate.length;
    result.push(remaining.slice(0, cut).trimEnd());
    remaining = remaining.slice(cut).trimStart();
  }
  if (remaining !== "") result.push(remaining);
  return result;
}
