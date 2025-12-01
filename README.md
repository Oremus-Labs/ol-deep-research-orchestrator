# ol-deep-research-orchestrator

Service that coordinates the Deep Research workflow for GPT-OSS. It exposes a REST API for creating jobs, runs planning/summarization/critique agents, calls n8n workflows for search and fetching, stores raw artifacts in MinIO, embeds notes, and writes metadata to Postgres + Qdrant.

## Development

```
npm install
npm run dev
```

Environment variables (see Helm chart / 1Password secrets) must be present locally. Use `npm run migrate` to create tables.

### UI development

```
npm run dev:ui           # runs Vite dev server on http://localhost:5173 (proxying to :8080)
npm run build            # builds server + UI bundle
npm run start:ui         # starts the standalone UI proxy (uses DEEP_RESEARCH_API_* envs)
```

The production container serves the UI at `/ui/` and exposes proxy endpoints under `/ui-api/*` so the browser never handles the orchestrator API key.

## API

- `POST /research` – enqueue a job.
- `GET /research/:id` – check status & report.
- `POST /research/:id/cancel` – cancel queued/running job.
- `GET /healthz` – readiness probe.
- `POST /ui-api/research` & `GET /ui-api/research/:id` – server-side proxies consumed by the Deep Research UI (no `X-API-Key` required).

All orchestrator endpoints (except `/healthz`, `/metrics`, `/ui`, and `/ui-api/*`) require an `X-API-Key` header matching `ORCH_API_KEY`. The `/ui-api` routes proxy authenticated calls on behalf of the browser UI.
