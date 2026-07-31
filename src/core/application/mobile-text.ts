const graphemeSegmenter = new Intl.Segmenter("zh", { granularity: "grapheme" });

export function normalizeInlineText(text: string): string {
  return text.replace(/\s+/gu, " ").trim();
}

export function summarizeText(text: string, limit = 20): string {
  if (!Number.isSafeInteger(limit) || limit < 1) throw new Error("Summary limit must be positive");
  const normalized = normalizeInlineText(text);
  if (normalized === "") return "（空消息）";
  const graphemes = [...graphemeSegmenter.segment(normalized)].map((item) => item.segment);
  return graphemes.length <= limit
    ? normalized
    : `${graphemes.slice(0, limit).join("")}…`;
}

export function sanitizeDisplayName(value: string, fallback: string, limit = 48): string {
  const withoutControls = value.replace(/[\p{Cc}\p{Cf}]/gu, " ");
  const normalized = normalizeInlineText(withoutControls);
  return summarizeText(normalized === "" ? fallback : normalized, limit);
}

export function formatRelativeTime(timestamp: string, now: string): string {
  const timestampMs = Date.parse(timestamp);
  const nowMs = Date.parse(now);
  if (!Number.isFinite(timestampMs) || !Number.isFinite(nowMs)) return "unknown";
  const seconds = Math.max(0, Math.floor((nowMs - timestampMs) / 1_000));
  if (seconds < 60) return "now";
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}h ago`;
  const days = Math.floor(hours / 24);
  if (days < 30) return `${days}d ago`;
  const months = Math.floor(days / 30);
  if (months < 12) return `${months}mo ago`;
  return `${Math.floor(months / 12)}y ago`;
}
