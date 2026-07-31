import assert from "node:assert/strict";
import { test } from "node:test";
import {
  approvalWaitingMessage,
  renderApprovalListItem,
  renderApprovalRequest,
  WechatTextRenderer
} from "../../src/channel-wechat/rendering/text-renderer.js";
import { WechatStatusAggregator } from "../../src/channel-wechat/rendering/status-aggregator.js";
import {
  WechatCommandHandler,
  type WechatCommandOperations
} from "../../src/composition/wechat-command-handler.js";

function operations(): WechatCommandOperations & { calls: string[] } {
  const calls: string[] = [];
  return {
    calls,
    projects: async () => [{ number: 1, slug: "agentlink", allowedAgents: ["codex"] }],
    supportedAgents: () => ["codex", "grok"],
    create: async (agent, project) => {
      calls.push(`create:${agent}:${project}`);
      return { id: "s-123456", displayName: "AgentLink 验收" };
    },
    imports: async (agent, project, limit) => {
      calls.push(`imports:${agent}:${project}:${limit}`);
      return [{
        number: 1,
        displayName: "既有 Codex 会话",
        relativeTime: "3h ago",
        archived: false
      }];
    },
    importSession: async (reference) => {
      calls.push(`import:${reference}`);
      return { id: "s-654321", displayName: "既有 Codex 会话" };
    },
    sessions: async () => [{
      number: 1,
      id: "s-123456",
      displayName: "AgentLink 验收",
      state: "已打开",
      project: "agentlink",
      agent: "codex",
      nativeLifecycleOwner: "AGENTLINK",
      active: true,
      relativeTime: "2m ago"
    }],
    use: async (id) => {
      calls.push(`use:${id}`);
      return "已切换：AgentLink 验收";
    },
    attach: async (id) => {
      calls.push(`attach:${id}`);
      return `已重新连接 ${id}`;
    },
    resume: async (id) => {
      calls.push(`session-resume:${id}`);
      return `已恢复 ${id}`;
    },
    requestDelete: async (id) => {
      calls.push(`delete:${id}`);
      return `待确认删除 ${id}`;
    },
    confirmDelete: async (id) => {
      calls.push(`delete-confirm:${id}`);
      return `已删除 ${id}`;
    },
    status: async () => "OPEN RUNNING",
    recap: async () => "Last result: done",
    input: async (text) => {
      calls.push(`input:${text}`);
      return { state: "RUNNING", text: "do work" };
    },
    steer: async (text) => { calls.push(`steer:${text}`); },
    queue: async () => [{ number: 1, stateLabel: "等待中", summary: "整理验收结果…" }],
    cancelQueued: async (id) => id === undefined ? "已取消唯一项" : `已取消 ${id}`,
    resumeQueue: async () => { calls.push("resume"); },
    approvals: async () => "暂无待审批操作",
    resolveApproval: async (id, decision) => {
      calls.push(`approval:${decision}:${id}`);
      return "审批已提交";
    },
    stop: async () => "已停止",
    close: async () => "已关闭"
  };
}

test("WeChat command handler covers the MVP text command surface", async () => {
  const ops = operations();
  const handler = new WechatCommandHandler(ops);
  const callsBeforeHelp = [...ops.calls];
  const help = await handler.handle("/help");
  assert.match(help ?? "", /AgentLink 帮助/u);
  assert.match(help ?? "", /\/projects/u);
  assert.match(help ?? "", /\/new \[codex\|grok\|claude\] <项目>/u);
  assert.match(help ?? "", /Grok 不支持导入既有会话/u);
  // Claude's real limits must be stated, including the read-only bypass, so the
  // help never implies every tool call raises an approval.
  assert.match(help ?? "", /Claude 不支持 \/steer 和 \/close/u);
  assert.match(help ?? "", /只读命令由 Claude 自身放行、不弹审批/u);
  assert.deepEqual(ops.calls, callsBeforeHelp);
  assert.match((await handler.handle("/projects")) ?? "", /agentlink/u);
  assert.equal(
    await handler.handle("/new codex agentlink"),
    "已创建并绑定：AgentLink 验收（s-123456）"
  );
  assert.match((await handler.handle("/imports agentlink")) ?? "", /1\. 既有 Codex 会话 · 3h ago/u);
  assert.equal(
    await handler.handle("/import 1"),
    "已导入并绑定：既有 Codex 会话（s-654321）"
  );
  assert.match(
    (await handler.handle("/sessions")) ?? "",
    /1\. \* AgentLink 验收 · 已打开 · codex · AGL · agentlink/u
  );
  assert.match((await handler.handle("/sessions")) ?? "", /s-123456/u);
  assert.equal(
    await handler.handle("/new grok agentlink"),
    "已创建并绑定：AgentLink 验收（s-123456）"
  );
  assert.equal(await handler.handle("/use 1"), "已切换：AgentLink 验收");
  assert.equal(await handler.handle("/attach s-1"), "已重新连接 s-1");
  assert.equal(await handler.handle("/resume s-1"), "已恢复 s-1");
  assert.equal(await handler.handle("/delete s-1"), "待确认删除 s-1");
  assert.equal(await handler.handle("/delete confirm s-1"), "已删除 s-1");
  assert.equal(await handler.handle("/status"), "OPEN RUNNING");
  assert.equal(await handler.handle("/recap"), "Last result: done");
  assert.equal(await handler.handle("do work"), undefined);
  assert.equal(await handler.handle("/continue more"), undefined);
  assert.equal(await handler.handle("/steer constrain"), "已向当前 Turn 追加约束");
  assert.match((await handler.handle("/queue")) ?? "", /1\. 等待中 · 整理验收结果…/u);
  assert.equal(await handler.handle("/queue cancel"), "已取消唯一项");
  assert.equal(await handler.handle("/queue cancel 1"), "已取消 1");
  assert.equal(await handler.handle("/queue resume"), "队列已显式恢复");
  assert.equal(await handler.handle("/approvals"), "暂无待审批操作");
  assert.equal(await handler.handle("/approve"), "审批已提交");
  assert.equal(await handler.handle("/approve A7F3"), "审批已提交");
  assert.equal(await handler.handle("/deny B8E4"), "审批已提交");
  assert.equal(await handler.handle("/cancel C9D5"), "审批已提交");
  assert.equal(await handler.handle("/stop"), "已停止");
  assert.equal(await handler.handle("/close"), "已关闭");
  assert.deepEqual(ops.calls, [
    "create:codex:agentlink",
    "imports:undefined:agentlink:5",
    "import:1",
    "create:grok:agentlink",
    "use:1",
    "attach:s-1",
    "session-resume:s-1",
    "delete:s-1",
    "delete-confirm:s-1",
    "input:do work",
    "input:more",
    "steer:constrain",
    "resume",
    "approval:allow_once:undefined",
    "approval:allow_once:A7F3",
    "approval:deny:B8E4",
    "approval:cancel:C9D5"
  ]);
});

test("/close preserves the explicit empty Session deletion notice", async () => {
  const ops = operations();
  ops.close = async () => "该session为空，系统默认删除。";
  const handler = new WechatCommandHandler(ops);
  assert.equal(await handler.handle("/close"), "该session为空，系统默认删除。");
});

test("/sessions displays at most 32 graphemes plus an ellipsis", async () => {
  const ops = operations();
  ops.sessions = async () => [{
    number: 1,
    id: "s-123456",
    displayName: "12345678901234567890123456789012X",
    state: "OPEN",
    project: "agentlink",
    agent: "codex",
    nativeLifecycleOwner: "AGENTLINK",
    active: true,
    relativeTime: "now"
  }];
  const output = await new WechatCommandHandler(ops).handle("/sessions");
  assert.equal(
    output,
    "1. * 12345678901234567890123456789012… · OPEN · codex · AGL · agentlink · now(s-123456)"
  );
});

test("/sessions distinguishes AgentLink-created and imported Sessions", async () => {
  const ops = operations();
  ops.sessions = async () => [
    {
      number: 1,
      id: "s-created",
      displayName: "移动端新建",
      state: "OPEN",
      project: "lingxi",
      agent: "codex",
      nativeLifecycleOwner: "AGENTLINK",
      active: true,
      relativeTime: "now"
    },
    {
      number: 2,
      id: "s-imported",
      displayName: "原生导入",
      state: "UNKNOWN",
      project: "agentlink",
      agent: "codex",
      nativeLifecycleOwner: "EXTERNAL",
      active: false,
      relativeTime: "1d ago"
    }
  ];
  const output = await new WechatCommandHandler(ops).handle("/sessions");
  assert.match(output ?? "", /codex · AGL · lingxi/u);
  assert.match(output ?? "", /codex · ORG · agentlink/u);
});

test("renderer chunks by Unicode code points and status updates coalesce", async () => {
  const renderer = new WechatTextRenderer({ maxChunkCharacters: 16 });
  const chunks = renderer.chunks("一二三四五六七八九十🙂甲乙丙丁戊己庚辛壬癸");
  assert.equal(chunks.length, 2);
  assert.match(chunks[0] ?? "", /^\[1\/2\]/u);
  assert.ok(chunks.every((chunk) => !chunk.includes("\uFFFD")));
  const sent: string[] = [];
  const status = new WechatStatusAggregator(async (_conversationId, text) => {
    sent.push(text);
  }, 1_000);
  status.update("conversation", "RUNNING 1");
  status.update("conversation", "RUNNING 2");
  await status.flush("conversation");
  assert.deepEqual(sent, ["RUNNING 2"]);
  assert.match(approvalWaitingMessage, /单项可直接|多项请先/u);
});

test("approval rendering is compact for one request and numbered for multiple requests", () => {
  const request = {
    id: "request-1",
    nativeRequestId: "native-request-1",
    nativeItemId: "item-1",
    sessionId: "session-1",
    turnId: "turn-1",
    actionKind: "command",
    actionDigest: "sha256:example",
    summary: "执行测试命令",
    risk: "high" as const,
    observedAt: "2026-07-19T00:00:00.000Z"
  };
  const lease = {
    id: "A7F3",
    requestId: "request-1",
    controllerEndpointId: "wechat-owner",
    actionDigest: "sha256:example",
    state: "ACTIVE" as const,
    expiresAt: "2026-07-19T00:05:00.000Z"
  };
  const text = renderApprovalRequest({
    ...request
  }, {
    ...lease
  }, {
    sessionName: "AgentLink 验收",
    project: "agentlink",
    now: "2026-07-19T00:00:00.000Z",
    multiple: false
  });
  assert.match(text, /允许 \/approve · 拒绝 \/deny · 停止 \/cancel/u);
  assert.match(text, /5min内有效,2026-07-19 08:05\(UTC\+8\)到期/u);
  assert.doesNotMatch(text, /A7F3/u);
  assert.doesNotMatch(text, /sha256/u);

  const multiple = renderApprovalRequest(request, lease, {
    sessionName: "AgentLink 验收",
    project: "agentlink",
    now: "2026-07-19T00:00:00.000Z",
    multiple: true
  });
  assert.match(multiple, /\/approvals/u);

  const listItem = renderApprovalListItem(
    1,
    {
      ...request,
      summary: "Codex请求permissions权限：删除用户指定的两个测试文件：test.txt 和 test2.txt"
    },
    lease,
    "AgentLink 验收",
    "2026-07-19T00:00:00.000Z"
  );
  assert.equal(
    listItem,
    "1. 高风险 · AgentLink 验收 · " +
      "Codex请求权限：删除用户指定的两个测试文件：test.txt 和 test2.txt"
  );
  assert.doesNotMatch(listItem, /…|5m/u);
});
