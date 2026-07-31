import { z } from "zod";

export type RpcId = number | string;

export interface RpcError {
  readonly code: number;
  readonly message: string;
  readonly data?: unknown;
}

export type RpcInbound =
  | { readonly kind: "response"; readonly id: RpcId; readonly result?: unknown; readonly error?: RpcError }
  | { readonly kind: "request"; readonly id: RpcId; readonly method: string; readonly params: unknown }
  | { readonly kind: "notification"; readonly method: string; readonly params: unknown };

const idSchema = z.union([z.number().int(), z.string().min(1)]);
const errorSchema = z.object({
  code: z.number().int(),
  message: z.string(),
  data: z.unknown().optional()
}).passthrough();
const envelopeSchema = z.object({
  jsonrpc: z.string().optional(),
  id: idSchema.optional(),
  method: z.string().min(1).optional(),
  params: z.unknown().optional(),
  result: z.unknown().optional(),
  error: errorSchema.optional()
}).passthrough();

export function parseInbound(line: string): RpcInbound {
  const parsed = envelopeSchema.parse(JSON.parse(line) as unknown);
  if (parsed.method !== undefined) {
    if (parsed.id !== undefined) {
      return {
        kind: "request",
        id: parsed.id,
        method: parsed.method,
        params: parsed.params ?? {}
      };
    }
    return { kind: "notification", method: parsed.method, params: parsed.params ?? {} };
  }
  if (parsed.id !== undefined && ("result" in parsed || parsed.error !== undefined)) {
    return {
      kind: "response",
      id: parsed.id,
      ...("result" in parsed ? { result: parsed.result } : {}),
      ...(parsed.error === undefined ? {} : { error: parsed.error })
    };
  }
  throw new Error("Invalid ACP JSON-RPC envelope");
}
