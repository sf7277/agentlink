import { z } from "zod";
import type { LocalControlEvent } from "../core/contracts/ports.js";

const turnRequestSchema = z.object({
  endpointId: z.string().min(1).max(128),
  sessionId: z.string().min(1).max(128),
  text: z.string().max(32 * 1024),
  kind: z.enum(["input", "steer", "stop", "close"])
}).strict();

const requestSchema = z.discriminatedUnion("kind", [
  turnRequestSchema,
  z.object({
    endpointId: z.string().min(1).max(128),
    kind: z.literal("session_discover"),
    project: z.string().min(1).max(63),
    agent: z.enum(["codex", "grok"]).optional()
  }).strict(),
  z.object({
    endpointId: z.string().min(1).max(128),
    kind: z.literal("session_import"),
    project: z.string().min(1).max(63),
    reference: z.string().regex(/^[1-9]\d*$/u),
    agent: z.enum(["codex", "grok"]).optional()
  }).strict(),
  z.object({
    endpointId: z.string().min(1).max(128),
    kind: z.literal("session_list"),
    project: z.string().min(1).max(63).optional(),
    scope: z.enum(["active", "archived", "all"])
  }).strict(),
  z.object({
    endpointId: z.string().min(1).max(128),
    kind: z.enum([
      "session_show",
      "session_archive",
      "session_unarchive",
      "session_delete",
      "session_detach"
    ]),
    sessionId: z.string().min(1).max(128)
  }).strict(),
  z.object({
    endpointId: z.string().min(1).max(128),
    kind: z.enum(["project_disable", "project_enable", "project_remove"]),
    project: z.string().min(1).max(63)
  }).strict(),
  z.object({
    endpointId: z.string().min(1).max(128),
    kind: z.enum(["channel_status", "channel_disconnect"]),
    channel: z.literal("wechat")
  }).strict()
]);

export function parseLocalControlEvent(value: unknown): LocalControlEvent {
  return requestSchema.parse(value) as LocalControlEvent;
}
