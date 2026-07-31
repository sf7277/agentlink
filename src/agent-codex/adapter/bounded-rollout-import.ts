import { createReadStream } from "node:fs";
import { lstat, readdir, realpath } from "node:fs/promises";
import { homedir } from "node:os";
import { join, relative, sep } from "node:path";
import { createInterface } from "node:readline";

export const LARGE_ROLLOUT_THRESHOLD_BYTES = 8 * 1024 * 1024;
export const MAX_IMPORT_TOKENS = 65_536;
export const TRUNCATION_MARKER =
  "因原始会话过长，更早的会话内容已被截断。以下是按时间顺序保留的真实会话内容。";
const PAIR_TRUNCATION_MARKER = "[该问答本身超过导入预算，内容已截断并仅保留末尾]";
const MAX_SEARCH_ENTRIES = 20_000;
const MAX_ROLLOUT_BYTES = 512 * 1024 * 1024;
const MAX_ROLLOUT_LINE_BYTES = 8 * 1024 * 1024;
const NATIVE_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/iu;

interface QuestionAnswerPair {
  question: string;
  answer: string;
}

export interface BoundedRolloutImport {
  readonly sourcePath: string;
  readonly sourceBytes: number;
  readonly contextWindow: number;
  readonly tokenBudget: number;
  readonly retainedPairs: number;
  readonly totalPairs: number;
  readonly items: readonly Record<string, unknown>[];
}

export interface BoundedRolloutOptions {
  readonly searchRoot?: string;
  readonly largeThresholdBytes?: number;
}

export async function prepareBoundedRolloutImport(
  nativeSessionId: string,
  projectRoot: string,
  options: BoundedRolloutOptions = {}
): Promise<BoundedRolloutImport | undefined> {
  if (!NATIVE_ID.test(nativeSessionId)) return undefined;
  const searchRoots = await rolloutSearchRoots(options.searchRoot);
  const matches: string[] = [];
  for (const root of searchRoots) {
    const match = await findRollout(root, nativeSessionId);
    if (match !== undefined) matches.push(match);
  }
  if (matches.length === 0) throw new Error("Codex rollout file could not be located safely");
  if (matches.length > 1) throw new Error("Multiple Codex rollouts matched the native Session ID");
  const sourcePath = matches[0]!;
  const sourceStat = await lstat(sourcePath);
  if (!sourceStat.isFile() || sourceStat.isSymbolicLink()) {
    throw new Error("Codex rollout is not a regular file");
  }
  if (typeof process.getuid === "function" && sourceStat.uid !== process.getuid()) {
    throw new Error("Codex rollout is not owned by the current user");
  }
  if ((sourceStat.mode & 0o022) !== 0) {
    throw new Error("Codex rollout is writable by another user");
  }
  if (sourceStat.size > MAX_ROLLOUT_BYTES) throw new Error("Codex rollout exceeds the safe import limit");
  if (sourceStat.size <= (options.largeThresholdBytes ?? LARGE_ROLLOUT_THRESHOLD_BYTES)) {
    return undefined;
  }

  const parsed = await parseRollout(sourcePath, nativeSessionId, await realpath(projectRoot));
  const afterStat = await lstat(sourcePath);
  if (
    afterStat.dev !== sourceStat.dev || afterStat.ino !== sourceStat.ino ||
    afterStat.size !== sourceStat.size || afterStat.mtimeMs !== sourceStat.mtimeMs
  ) {
    throw new Error("Codex rollout changed while it was being imported");
  }
  const tokenBudget = Math.min(
    MAX_IMPORT_TOKENS,
    Math.max(1, Math.floor(parsed.contextWindow * 0.25))
  );
  const retained = selectNewestPairs(parsed.pairs, tokenBudget);
  return {
    sourcePath,
    sourceBytes: sourceStat.size,
    contextWindow: parsed.contextWindow,
    tokenBudget,
    retainedPairs: retained.length,
    totalPairs: parsed.pairs.length,
    items: pairsToResponseItems(retained)
  };
}

async function rolloutSearchRoots(configured?: string): Promise<string[]> {
  const candidates = configured === undefined
    ? [
        join(process.env["CODEX_HOME"] ?? join(homedir(), ".codex"), "sessions"),
        join(process.env["CODEX_HOME"] ?? join(homedir(), ".codex"), "archived_sessions")
      ]
    : [configured];
  const roots: string[] = [];
  for (const candidate of candidates) {
    try {
      roots.push(await realpath(candidate));
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    }
  }
  return roots;
}

async function findRollout(root: string, nativeSessionId: string): Promise<string | undefined> {
  const suffix = `${nativeSessionId}.jsonl`;
  const pending = [root];
  const matches: string[] = [];
  let visited = 0;
  while (pending.length > 0) {
    const directory = pending.pop()!;
    for (const entry of await readdir(directory, { withFileTypes: true })) {
      visited += 1;
      if (visited > MAX_SEARCH_ENTRIES) throw new Error("Codex rollout search limit exceeded");
      const path = join(directory, entry.name);
      if (entry.isDirectory()) pending.push(path);
      else if (entry.isFile() && entry.name.startsWith("rollout-") && entry.name.endsWith(suffix)) {
        matches.push(path);
      }
    }
  }
  if (matches.length > 1) throw new Error("Multiple Codex rollouts matched the native Session ID");
  if (matches.length === 0) return undefined;
  const resolved = await realpath(matches[0]!);
  const rel = relative(root, resolved);
  if (rel === "" || rel === ".." || rel.startsWith(`..${sep}`)) {
    throw new Error("Codex rollout resolved outside the trusted sessions directory");
  }
  return resolved;
}

async function parseRollout(path: string, nativeSessionId: string, projectRoot: string): Promise<{
  contextWindow: number;
  pairs: QuestionAnswerPair[];
}> {
  let sawMatchingMetadata = false;
  let contextWindow = 0;
  let pendingQuestion: string | undefined;
  const pairs: QuestionAnswerPair[] = [];
  const lines = createInterface({ input: createReadStream(path, { encoding: "utf8" }), crlfDelay: Infinity });
  for await (const line of lines) {
    if (line.trim() === "") continue;
    if (Buffer.byteLength(line, "utf8") > MAX_ROLLOUT_LINE_BYTES) {
      throw new Error("Codex rollout contains an oversized record");
    }
    const record = JSON.parse(line) as Record<string, unknown>;
    const payload = record["payload"] as Record<string, unknown> | undefined;
    if (record["type"] === "session_meta" && payload !== undefined) {
      if (payload["id"] !== nativeSessionId) throw new Error("Codex rollout Session ID mismatch");
      const cwd = payload["cwd"];
      if (typeof cwd !== "string" || await realpath(cwd) !== projectRoot) {
        throw new Error("Codex rollout project path mismatch");
      }
      sawMatchingMetadata = true;
    } else if (record["type"] === "event_msg" && payload !== undefined) {
      if (payload["type"] === "task_started") {
        const value = payload["model_context_window"];
        if (typeof value === "number" && Number.isSafeInteger(value) && value > 0) contextWindow = value;
      } else if (payload["type"] === "user_message") {
        pendingQuestion = typeof payload["message"] === "string" ? payload["message"] : undefined;
      } else if (
        payload["type"] === "agent_message" &&
        payload["phase"] === "final_answer" &&
        pendingQuestion !== undefined &&
        typeof payload["message"] === "string"
      ) {
        pairs.push({ question: pendingQuestion, answer: payload["message"] });
        pendingQuestion = undefined;
      }
    }
  }
  if (!sawMatchingMetadata) throw new Error("Codex rollout has no matching Session metadata");
  if (contextWindow <= 0) throw new Error("Codex rollout has no valid model context window");
  if (pairs.length === 0) throw new Error("Codex rollout has no complete question-answer pairs");
  return { contextWindow, pairs };
}

function selectNewestPairs(pairs: readonly QuestionAnswerPair[], budget: number): QuestionAnswerPair[] {
  const markerCost = estimateTokens(TRUNCATION_MARKER);
  let remaining = Math.max(1, budget - markerCost);
  const retained: QuestionAnswerPair[] = [];
  for (let index = pairs.length - 1; index >= 0; index -= 1) {
    const pair = pairs[index]!;
    const cost = estimatePairTokens(pair);
    if (cost <= remaining) {
      retained.unshift(pair);
      remaining -= cost;
      continue;
    }
    if (retained.length === 0) retained.unshift(truncatePairToBudget(pair, remaining));
    break;
  }
  return retained;
}

function truncatePairToBudget(pair: QuestionAnswerPair, budget: number): QuestionAnswerPair {
  const marker = PAIR_TRUNCATION_MARKER;
  const available = Math.max(16, budget - estimateTokens(marker));
  const questionBudget = Math.max(8, Math.floor(available * 0.35));
  const answerBudget = Math.max(8, available - questionBudget);
  return {
    question: `${marker}\n${takeTailByTokens(pair.question, questionBudget)}`,
    answer: `${marker}\n${takeTailByTokens(pair.answer, answerBudget)}`
  };
}

function takeTailByTokens(text: string, budget: number): string {
  const chars = [...text];
  let low = 0;
  let high = chars.length;
  while (low < high) {
    const middle = Math.ceil((low + high) / 2);
    if (estimateTokens(chars.slice(chars.length - middle).join("")) <= budget) low = middle;
    else high = middle - 1;
  }
  return chars.slice(chars.length - low).join("");
}

function estimatePairTokens(pair: QuestionAnswerPair): number {
  return estimateTokens(pair.question) + estimateTokens(pair.answer) + 12;
}

/** Deterministic conservative estimate calibrated so 64K is about 40K CJK characters. */
export function estimateTokens(text: string): number {
  let cjk = 0;
  let other = "";
  for (const char of text) {
    if (/\p{Script=Han}|\p{Script=Hiragana}|\p{Script=Katakana}|\p{Script=Hangul}/u.test(char)) cjk += 1;
    else other += char;
  }
  return Math.ceil(cjk * 1.6 + Buffer.byteLength(other, "utf8") / 4);
}

function pairsToResponseItems(pairs: readonly QuestionAnswerPair[]): Record<string, unknown>[] {
  const items: Record<string, unknown>[] = [{
    type: "message",
    role: "user",
    content: [{ type: "input_text", text: TRUNCATION_MARKER }]
  }];
  for (const pair of pairs) {
    items.push({
      type: "message",
      role: "user",
      content: [{ type: "input_text", text: pair.question }]
    });
    items.push({
      type: "message",
      role: "assistant",
      phase: "final_answer",
      content: [{ type: "output_text", text: pair.answer }]
    });
  }
  return items;
}
