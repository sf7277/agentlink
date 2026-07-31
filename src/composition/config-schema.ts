import { z } from "zod";

export const gatewayConfigSchema = z.object({
  queueLimit: z.number().int().min(1).max(256).default(32),
  maxInputBytes: z.number().int().min(1024).max(1024 * 1024).default(64 * 1024),
  maxOutputBytes: z.number().int().min(1024).max(2 * 1024 * 1024).default(256 * 1024),
  requestsPerMinute: z.number().int().min(1).max(10_000).default(120),
  approvalLeaseMs: z.number().int().min(30_000).max(15 * 60_000).default(5 * 60_000),
  codex: z.object({
    command: z.string().min(1).default("codex"),
    maxActiveTurns: z.number().int().min(1).max(16).default(4),
    requestPermissionsTool: z.boolean().default(true),
    experimentalApi: z.boolean().default(false)
  }).strict().optional(),
  grok: z.object({
    command: z.string().min(1).default("grok"),
    isolatedHomeRoot: z.string().min(1).optional(),
    maxActiveTurns: z.number().int().min(1).max(16).default(4)
  }).strict().optional(),
  claude: z.object({
    command: z.string().min(1).default("claude"),
    maxActiveTurns: z.number().int().min(1).max(16).default(4)
  }).strict().optional(),
  wechat: z.object({
    accountId: z.string().min(1),
    baseUrl: z.string().url(),
    credentialReference: z.string().regex(/^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/u),
    controllers: z.array(z.object({
      senderId: z.string().min(1),
      gatewayUserId: z.string().min(1)
    }).strict()).min(1)
  }).strict().optional(),
  projects: z.array(z.object({
    id: z.string().min(1),
    slug: z.string().regex(/^[a-z][a-z0-9-]{0,62}$/u),
    path: z.string().min(1),
    allowedAgents: z.array(z.string().min(1)).min(1),
    defaultAgent: z.string().min(1),
    enabled: z.boolean().default(true)
  }).strict()).default([])
}).strict().superRefine((value, context) => {
  for (const [index, project] of value.projects.entries()) {
    if (!project.allowedAgents.includes(project.defaultAgent)) {
      context.addIssue({
        code: "custom",
        path: ["projects", index, "defaultAgent"],
        message: "project defaultAgent must be included in allowedAgents"
      });
    }
    const configuredAdapter =
      project.defaultAgent === "codex" ? value.codex :
      project.defaultAgent === "grok" ? value.grok :
      project.defaultAgent === "claude" ? value.claude :
      undefined;
    if (configuredAdapter === undefined) {
      context.addIssue({
        code: "custom",
        path: ["projects", index, "defaultAgent"],
        message: "project defaultAgent must reference a configured adapter"
      });
    }
  }
});

export type GatewayConfig = z.infer<typeof gatewayConfigSchema>;
export type GatewayConfigInput = z.input<typeof gatewayConfigSchema>;
