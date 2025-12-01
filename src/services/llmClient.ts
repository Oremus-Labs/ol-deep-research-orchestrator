import { fetch } from "undici";
import { config } from "../config";
import { logger } from "../logger";

type Message = { role: "system" | "user" | "assistant"; content: string };

export async function chatCompletion(messages: Message[], opts?: { maxTokens?: number }) {
  const body = {
    model: config.llm.model,
    messages,
    max_tokens: opts?.maxTokens ?? config.llm.maxTokens,
    temperature: 0.2,
  };

  const response = await fetch(`${config.llm.baseUrl}/chat/completions`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });

  if (!response.ok) {
    const text = await response.text();
    logger.error({ status: response.status, text }, "LLM request failed");
    throw new Error(`LLM request failed (${response.status})`);
  }

  const data = (await response.json()) as {
    choices: { message: { content: string } }[];
  };
  return data.choices?.[0]?.message.content ?? "";
}
