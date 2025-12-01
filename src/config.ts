import { z } from "zod";

const envSchema = z.object({
  NODE_ENV: z.string().optional().default("development"),
  PORT: z.coerce.number().optional().default(8080),
  PGHOST: z.string(),
  PGPORT: z.coerce.number().default(5432),
  POSTGRES_USER: z.string(),
  POSTGRES_PASSWORD: z.string(),
  POSTGRES_DB: z.string(),
  ORCH_API_KEY: z.string(),
  LLM_BASE_URL: z.string(),
  LLM_MODEL_NAME: z.string(),
  EMBEDDING_URL: z.string(),
  EMBEDDING_API_KEY: z.string().optional(),
  QDRANT_URL: z.string(),
  QDRANT_API_KEY: z.string().optional(),
  SEARCH_API_BASE_URL: z.string().optional(),
  DUCKDUCKGO_MCP_SERVER: z.string().optional(),
  FIRECRAWL_MCP_SERVER: z.string().optional(),
  N8N_BASE_URL: z.string(),
  N8N_WEB_SEARCH_PATH: z.string(),
  N8N_FETCH_URL_PATH: z.string(),
  N8N_API_KEY: z.string().optional(),
  MINIO_ENDPOINT: z.string(),
  MINIO_ACCESS_KEY: z.string(),
  MINIO_SECRET_KEY: z.string(),
  MINIO_BUCKET: z.string().optional().default("deep-research"),
  MINIO_USE_SSL: z
    .string()
    .optional()
    .transform((value) => value?.toLowerCase() === "true")
    .default("false" as unknown as boolean),
  MAX_CONCURRENT_JOBS: z.coerce.number().optional().default(1),
  MAX_STEPS: z.coerce.number().optional().default(8),
  MAX_JOB_SECONDS: z.coerce.number().optional().default(3600),
  MAX_LLM_TOKENS: z.coerce.number().optional().default(4000),
  MAX_EMBED_TOKENS: z.coerce.number().optional().default(512),
  MAX_NOTES_FOR_SYNTH: z.coerce.number().optional().default(64),
  MAX_CONTEXT: z.coerce.number().optional().default(131072),
  WARM_NOTES_LIMIT: z.coerce.number().optional().default(6),
  WARM_NOTES_IMPORTANCE_MIN: z.coerce.number().optional().default(3),
});

const env = envSchema.parse(process.env);

export const config = {
  env: env.NODE_ENV,
  port: env.PORT,
  apiKey: env.ORCH_API_KEY,
  database: {
    host: env.PGHOST,
    port: env.PGPORT,
    user: env.POSTGRES_USER,
    password: env.POSTGRES_PASSWORD,
    database: env.POSTGRES_DB,
  },
  llm: {
    baseUrl: env.LLM_BASE_URL.replace(/\/$/, ""),
    model: env.LLM_MODEL_NAME,
    maxTokens: env.MAX_LLM_TOKENS,
    maxContext: env.MAX_CONTEXT,
  },
  embedding: {
    url: env.EMBEDDING_URL,
    apiKey: env.EMBEDDING_API_KEY,
    maxTokens: env.MAX_EMBED_TOKENS,
  },
  qdrant: {
    url: env.QDRANT_URL.replace(/\/$/, ""),
    apiKey: env.QDRANT_API_KEY,
    collection: "dr_notes",
  },
  search: {
    searxBaseUrl: env.SEARCH_API_BASE_URL?.replace(/\/$/, ""),
    ddgMcpServer: env.DUCKDUCKGO_MCP_SERVER,
    firecrawlMcpServer: env.FIRECRAWL_MCP_SERVER,
  },
  n8n: {
    baseUrl: env.N8N_BASE_URL.replace(/\/$/, ""),
    webSearchPath: env.N8N_WEB_SEARCH_PATH,
    fetchUrlPath: env.N8N_FETCH_URL_PATH,
    apiKey: env.N8N_API_KEY,
  },
  minio: {
    endpoint: env.MINIO_ENDPOINT,
    accessKey: env.MINIO_ACCESS_KEY,
    secretKey: env.MINIO_SECRET_KEY,
    bucket: env.MINIO_BUCKET,
    useSSL: Boolean(env.MINIO_USE_SSL),
  },
  worker: {
    maxConcurrent: env.MAX_CONCURRENT_JOBS,
    maxSteps: env.MAX_STEPS,
    maxJobSeconds: env.MAX_JOB_SECONDS,
    maxNotesForSynth: env.MAX_NOTES_FOR_SYNTH,
    warmNotesLimit: env.WARM_NOTES_LIMIT,
    warmImportanceMin: env.WARM_NOTES_IMPORTANCE_MIN,
  },
};

export type AppConfig = typeof config;
