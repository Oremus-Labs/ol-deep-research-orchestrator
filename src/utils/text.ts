import { config } from "../config";

const MIN_TOKENS = 16;

export function estimateTokens(text: string) {
  if (!text.trim()) {
    return 0;
  }
  return Math.ceil(
    text
      .split(/\s+/)
      .filter(Boolean)
      .length * 1.3,
  );
}

export function clampForEmbedding(text: string, tokenLimit = config.embedding.maxTokens ?? 512) {
  const safeLimit = Math.max(MIN_TOKENS, Math.floor(tokenLimit * 0.8));
  const charLimit = safeLimit * 4;
  const words = text.split(/\s+/).filter(Boolean);
  if (!words.length) {
    return text;
  }

  let end = Math.min(words.length, Math.max(MIN_TOKENS, safeLimit));
  let truncated = words.slice(0, end).join(" ");

  while ((estimateTokens(truncated) > safeLimit || truncated.length > charLimit) && end > MIN_TOKENS) {
    end = Math.max(MIN_TOKENS, Math.floor(end * 0.9));
    truncated = words.slice(0, end).join(" ");
  }

  if (truncated.length >= text.length) {
    return truncated;
  }

  return `${truncated.trim()} …`;
}
