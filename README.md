# ol-deep-research-orchestrator

Service that coordinates the Deep Research workflow for GPT-OSS. It exposes a REST API for creating jobs, runs planning/summarization/critique agents, calls n8n workflows for search and fetching, stores raw artifacts in MinIO, embeds notes, and writes metadata to Postgres + Qdrant.

## Development

```
npm install
npm run dev
```

Environment variables (see Helm chart / 1Password secrets) must be present locally. Use `npm run migrate` to create tables.

## API

- `POST /research` – enqueue a job.
- `GET /research/:id` – check status & report.
- `POST /research/:id/cancel` – cancel queued/running job.
- `GET /healthz` – readiness probe.

All endpoints (except `/healthz`) require `X-API-Key` header matching `ORCH_API_KEY`.
