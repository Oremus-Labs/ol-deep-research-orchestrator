import { chatCompletion } from "./llmClient";
import { prompts } from "../prompts";
import { logger } from "../logger";
import { ClarificationPromptRecord } from "../types/job";

const FALLBACK_PROMPTS: ClarificationPromptRecord[] = [
  {
    key: "time_horizon",
    prompt:
      "What time horizon should this research focus on (e.g., current state, 12-18 months, 3-5 year outlook)?",
    required: true,
  },
  {
    key: "region_focus",
    prompt: "Which geographic regions or regulatory domains are in scope (e.g., US, EU/GDPR, APAC)?",
    required: true,
  },
  {
    key: "data_modalities",
    prompt: "List the data modalities that must be analyzed (blogs, PDFs, scraped HTML, structured CSV/JSON, etc.).",
    required: true,
  },
  {
    key: "integration_targets",
    prompt: "Which enterprise systems must consume this report (knowledge graph, SharePoint, MDM, ticketing, etc.)?",
    required: true,
  },
  {
    key: "quality_constraints",
    prompt:
      "Specify any tone, compliance, or quality constraints (red lines, citation expectations, reviewer needs).",
    required: true,
  },
];

function normalizeKey(value: string | undefined, index: number) {
  if (!value) {
    return `clarification_${index + 1}`;
  }
  return value
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "_")
    .replace(/^_+|_+$/g, "")
    .replace(/_{2,}/g, "_") || `clarification_${index + 1}`;
}

function sanitizePrompts(raw: unknown): ClarificationPromptRecord[] {
  if (!raw) {
    return [];
  }
  const entries: ClarificationPromptRecord[] = [];
  const source = Array.isArray(raw) ? raw : Array.isArray((raw as Record<string, unknown>).prompts)
    ? ((raw as Record<string, unknown>).prompts as unknown[])
    : [
        ...(Array.isArray((raw as Record<string, unknown>).required)
          ? ((raw as Record<string, unknown>).required as unknown[]).map((entry) => ({
              ...(entry as Record<string, unknown>),
              required: true,
            }))
          : []),
        ...(Array.isArray((raw as Record<string, unknown>).optional)
          ? ((raw as Record<string, unknown>).optional as unknown[])
          : []),
      ];

  source.forEach((entry, idx) => {
    if (!entry || typeof entry !== "object") {
      return;
    }
    const bag = entry as Record<string, unknown>;
    const prompt = String(bag.prompt ?? bag.question ?? bag.text ?? "").trim();
    if (!prompt) {
      return;
    }
    entries.push({
      key: normalizeKey(String(bag.key ?? bag.name ?? bag.field ?? ""), idx),
      prompt,
      required: bag.required !== undefined ? Boolean(bag.required) : true,
    });
  });

  const deduped: ClarificationPromptRecord[] = [];
  const seen = new Set<string>();
  for (const entry of entries) {
    if (seen.has(entry.key)) {
      let suffix = 2;
      let nextKey = `${entry.key}_${suffix}`;
      while (seen.has(nextKey)) {
        suffix += 1;
        nextKey = `${entry.key}_${suffix}`;
      }
      entry.key = nextKey;
    }
    seen.add(entry.key);
    deduped.push(entry);
    if (deduped.length >= 6) {
      break;
    }
  }
  return deduped;
}

export function hasMetadataValue(value: unknown): boolean {
  if (value === null || value === undefined) {
    return false;
  }
  if (typeof value === "string") {
    return value.trim().length > 0;
  }
  if (typeof value === "number" || typeof value === "boolean") {
    return true;
  }
  if (Array.isArray(value)) {
    return value.some((entry) => hasMetadataValue(entry));
  }
  if (typeof value === "object") {
    return Object.keys(value as Record<string, unknown>).length > 0;
  }
  return false;
}

export function filterOutstandingPrompts(
  promptsList: ClarificationPromptRecord[],
  metadata: Record<string, unknown>,
) {
  return promptsList.filter((prompt) => !hasMetadataValue(metadata?.[prompt.key]));
}

export async function generateClarificationPrompts(
  question: string,
  metadata: Record<string, unknown>,
): Promise<ClarificationPromptRecord[]> {
  try {
    const response = await chatCompletion([
      { role: "system", content: prompts.clarifier },
      {
        role: "user",
        content: JSON.stringify({
          question,
          metadata,
        }),
      },
    ]);
    const parsed = JSON.parse(response);
    const promptsList = sanitizePrompts(parsed);
    if (promptsList.length) {
      return promptsList;
    }
  } catch (error) {
    logger.warn({ error }, "Failed to generate clarification prompts from LLM");
  }
  return FALLBACK_PROMPTS;
}
