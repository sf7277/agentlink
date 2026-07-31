import { z } from "zod";

const messageItemSchema = z.object({
  type: z.number().int(),
  text_item: z.object({ text: z.string() }).passthrough().optional(),
  image_item: z.unknown().optional(),
  voice_item: z.unknown().optional(),
  file_item: z.unknown().optional(),
  video_item: z.unknown().optional(),
  ref_msg: z.unknown().optional()
}).passthrough();

export const weixinMessageSchema = z.object({
  seq: z.number().int().optional(),
  message_id: z.union([
    z.string().regex(/^\d+$/u),
    z.number().int().nonnegative().transform(String)
  ]),
  from_user_id: z.string().min(1),
  to_user_id: z.string().min(1).optional(),
  client_id: z.string().optional(),
  create_time_ms: z.number().int().nonnegative(),
  session_id: z.string(),
  message_type: z.number().int(),
  message_state: z.number().int().optional(),
  item_list: z.array(messageItemSchema),
  context_token: z.string().min(1)
}).passthrough();

export const getUpdatesResponseSchema = z.object({
  ret: z.number().int().optional(),
  errcode: z.number().int().optional(),
  errmsg: z.string().optional(),
  msgs: z.array(weixinMessageSchema).optional(),
  get_updates_buf: z.string().optional(),
  longpolling_timeout_ms: z.number().int().min(1_000).max(120_000).optional()
}).passthrough().superRefine((value, context) => {
  if (value.errcode === undefined && value.msgs === undefined) {
    context.addIssue({
      code: "custom",
      path: ["msgs"],
      message: "getupdates response must contain msgs or an error code"
    });
  }
}).transform((value) => ({
  ...value,
  ret: value.ret ?? 0,
  msgs: value.msgs ?? []
}));

export const sendMessageResponseSchema = z.object({
  ret: z.number().int().default(0),
  errmsg: z.string().optional()
}).passthrough();

export const qrStartSchema = z.object({
  qrcode: z.string().min(1),
  qrcode_img_content: z.string().url()
}).passthrough();

export const qrStatusSchema = z.object({
  status: z.enum([
    "wait",
    "scaned",
    "confirmed",
    "expired",
    "scaned_but_redirect",
    "need_verifycode",
    "verify_code_blocked",
    "binded_redirect"
  ]),
  bot_token: z.string().min(1).optional(),
  ilink_bot_id: z.string().min(1).optional(),
  baseurl: z.string().url().optional(),
  ilink_user_id: z.string().min(1).optional(),
  redirect_host: z.string().min(1).optional()
}).passthrough();

export type GetUpdatesResponse = z.infer<typeof getUpdatesResponseSchema>;
export type WeixinMessage = z.infer<typeof weixinMessageSchema>;
