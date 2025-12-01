import path from "node:path";
import fs from "node:fs";
import Fastify, { FastifyReply } from "fastify";
import fastifyStatic from "@fastify/static";
import sensible from "fastify-sensible";
import { fetch } from "undici";

const REQUIRED_ENVS = ["DEEP_RESEARCH_API_BASE", "DEEP_RESEARCH_API_KEY"] as const;

for (const key of REQUIRED_ENVS) {
  if (!process.env[key]) {
    throw new Error(`Missing required env var ${key}`);
  }
}

const apiBase = (process.env.DEEP_RESEARCH_API_BASE as string).replace(/\/$/, "");
const apiKey = process.env.DEEP_RESEARCH_API_KEY as string;
const port = Number(process.env.PORT ?? 8080);
const host = process.env.HOST ?? "0.0.0.0";

const hopByHopHeaders = new Set([
  "connection",
  "content-length",
  "keep-alive",
  "proxy-authenticate",
  "proxy-authorization",
  "te",
  "trailer",
  "transfer-encoding",
  "upgrade",
]);

async function start() {
  const app = Fastify({
    logger: {
      level: process.env.LOG_LEVEL ?? "info",
    },
  });
  await app.register(sensible);

  const uiDistPath = path.join(__dirname, "..", "ui-dist");
  if (fs.existsSync(uiDistPath)) {
    await app.register(fastifyStatic, {
      root: uiDistPath,
      prefix: "/ui/",
      list: false,
    });
    app.get("/", async (_request, reply) => reply.redirect("/ui/"));
    app.get("/ui", async (_request, reply) => reply.sendFile("index.html"));
    app.get("/ui/*", async (_request, reply) => reply.sendFile("index.html"));
  } else {
    app.log.warn({ uiDistPath }, "UI build directory missing");
  }

  app.get("/healthz", async () => ({ status: "ok" }));

  app.post("/ui-api/research", async (request, reply) => {
    const target = `${apiBase}/research`;
    const payload = JSON.stringify(request.body ?? {});
    return proxyRequest(target, "POST", payload, reply);
  });

  app.get("/ui-api/research/:id", async (request, reply) => {
    const { id } = request.params as { id: string };
    const target = `${apiBase}/research/${id}`;
    return proxyRequest(target, "GET", undefined, reply);
  });

  app.listen({ port, host }, (err, address) => {
    if (err) {
      app.log.error(err, "failed to start UI server");
      process.exit(1);
    }
    app.log.info({ address }, "Deep Research UI proxy listening");
  });
}

async function proxyRequest(
  url: string,
  method: "GET" | "POST",
  body: string | undefined,
  reply: FastifyReply,
) {
  const response = await fetch(url, {
    method,
    headers: {
      "x-api-key": apiKey,
      ...(method === "POST" ? { "content-type": "application/json" } : {}),
    },
    body,
  });

  reply.code(response.status);
  for (const [key, value] of response.headers.entries()) {
    if (hopByHopHeaders.has(key.toLowerCase())) {
      continue;
    }
    reply.header(key, value);
  }
  const text = await response.text();
  const contentType = response.headers.get("content-type") ?? "";
  if (!text) {
    return null;
  }
  if (contentType.includes("application/json")) {
    try {
      return JSON.parse(text);
    } catch (error) {
      reply.log.warn({ error }, "failed to parse JSON from orchestrator response");
    }
  }
  return text;
}

start().catch((error) => {
  // eslint-disable-next-line no-console
  console.error(error);
  process.exit(1);
});
