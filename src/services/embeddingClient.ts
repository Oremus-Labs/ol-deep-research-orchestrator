import { fetch } from "undici";
import { config } from "../config";
import { logger } from "../logger";
import { clampForEmbedding } from "../utils/text";

export async function embedText(text: string) {
  let payload = clampForEmbedding(text, config.embedding.maxTokens);
  let attemptLimit = Math.max(64, config.embedding.maxTokens ?? 512);

  for (let attempt = 0; attempt < 4; attempt += 1) {
    const response = await fetch(config.embedding.url, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        ...(config.embedding.apiKey ? { Authorization: `Bearer ${config.embedding.apiKey}` } : {}),
      },
      body: JSON.stringify({ inputs: [payload] }),
    });

    if (response.ok) {
      return parseEmbedding(await response.json());
    }

    const msg = await response.text();
    const tooLarge =
      response.status === 413 ||
      msg.includes("less than 512 tokens") ||
      msg.toLowerCase().includes("token");

    if (tooLarge) {
      attemptLimit = Math.max(32, Math.floor(attemptLimit * 0.75));
      const shorter = clampForEmbedding(payload, attemptLimit);
      if (shorter.length >= payload.length) {
        logger.error({ status: response.status, msg }, "Embedding clamp exhausted");
        break;
      }
      payload = shorter;
      continue;
    }

    logger.error({ status: response.status, msg }, "Embedding request failed");
    throw new Error("Embedding request failed");
  }

  throw new Error("Embedding request failed");
}

function parseEmbedding(data: any) {
  if (Array.isArray(data)) {
    return data[0] ?? [];
  }

  if (Array.isArray(data?.embeddings)) {
    return data.embeddings[0] ?? [];
  }

  if (Array.isArray(data?.data)) {
    const first = data.data[0];
    if (Array.isArray(first?.embedding)) {
      return first.embedding;
    }
  }

  logger.warn({ data }, "Unknown embedding response shape");
  return [];
}
