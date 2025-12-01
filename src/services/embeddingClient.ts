import { fetch } from "undici";
import { config } from "../config";
import { logger } from "../logger";

export async function embedText(text: string) {
  const response = await fetch(config.embedding.url, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      ...(config.embedding.apiKey ? { Authorization: `Bearer ${config.embedding.apiKey}` } : {}),
    },
    body: JSON.stringify({ inputs: [text] }),
  });

  if (!response.ok) {
    const msg = await response.text();
    logger.error({ status: response.status, msg }, "Embedding request failed");
    throw new Error("Embedding request failed");
  }

  const data = (await response.json()) as { data: { embedding: number[] }[] };
  return data.data?.[0]?.embedding ?? [];
}
