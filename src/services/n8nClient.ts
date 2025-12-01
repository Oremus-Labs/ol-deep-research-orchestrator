import { fetch } from "undici";
import { config } from "../config";
import { logger } from "../logger";
import { recordToolError, startToolTimer } from "../metrics";

interface SearchResult {
  title: string;
  url: string;
  snippet?: string;
}

export async function n8nWebSearch(query: string, numResults = 5) {
  const url = `${config.n8n.baseUrl}${config.n8n.webSearchPath}`;
  const stopTimer = startToolTimer("n8n_search");
  try {
    const response = await fetch(url, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        ...(config.n8n.apiKey ? { "x-api-key": config.n8n.apiKey } : {}),
      },
      body: JSON.stringify({ query, num_results: numResults }),
    });

    if (!response.ok) {
      const text = await response.text();
      logger.error({ url, status: response.status, text }, "n8n web search failed");
      recordToolError("n8n_search", "workflow");
      throw new Error(`n8n web search failed (${response.status})`);
    }

    const data = (await response.json()) as { results: SearchResult[]; error?: string };
    if (data.error) {
      recordToolError("n8n_search", "result");
      throw new Error(data.error);
    }
    return data.results ?? [];
  } finally {
    stopTimer();
  }
}

export async function n8nFetchUrl(targetUrl: string) {
  const url = `${config.n8n.baseUrl}${config.n8n.fetchUrlPath}`;
  const stopTimer = startToolTimer("n8n_fetch");
  try {
    const response = await fetch(url, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        ...(config.n8n.apiKey ? { "x-api-key": config.n8n.apiKey } : {}),
      },
      body: JSON.stringify({ url: targetUrl }),
    });

    if (!response.ok) {
      const text = await response.text();
      logger.error({ url, status: response.status, text }, "n8n fetch failed");
      recordToolError("n8n_fetch", "workflow");
      throw new Error(`n8n fetch failed (${response.status})`);
    }

    const data = (await response.json()) as {
      url: string;
      title?: string;
      content?: string;
      meta?: Record<string, unknown>;
      error?: string;
      statusCode?: number;
    };

    if (data.error) {
      recordToolError("n8n_fetch", "result");
      throw new Error(data.error);
    }

    return data;
  } finally {
    stopTimer();
  }
}
