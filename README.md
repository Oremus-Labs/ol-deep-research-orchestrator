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

### Feature flags

- `LONGFORM_ENABLED` (default `false`) gates the new section-draft + citation-ledger pipeline. Leave it off for production until CL‑2/CL‑3 verification passes; flip via Helm (`features.longformEnabled=true`) when ready to exercise the long-form flow.

### Planner iteration controls

- `MAX_ITERATIONS` limits how many planner → execution loops can be scheduled after the initial pass (default `2`).
- `ITERATION_TOKEN_BUDGET` is an approximate token ceiling for those follow-up steps; each additional step consumes about 750 tokens of the allowance (default `12000`).
  Tune these values in the Helm chart or environment to make the orchestrator more or less aggressive when chasing missing coverage.

## API

- `POST /research` – enqueue a job.
- `GET /research/:id` – check status & report.
- `GET /research` – list recent jobs (used by the UI dashboard).
- `POST /research/:id/cancel` – cancel queued/running job.
- `POST /research/:id/pause` – pause a queued or running job without losing progress.
- `POST /research/:id/start` – resume a paused job (it re-enters the queue and continues where it left off).
- `DELETE /research/:id` – delete a non-running job (cascades to steps/notes/sources).
- `GET /healthz` – readiness probe.
- `POST /ui-api/research`, `GET /ui-api/research` & `GET /ui-api/research/:id` – server-side proxies consumed by the Deep Research UI (no `X-API-Key` required).
- `POST /ui-api/research/:id/{clarify|cancel|pause|start}` and `DELETE /ui-api/research/:id` expose the same management actions to the web UI without requiring the API key.

All orchestrator endpoints (except `/healthz`, `/metrics`, `/ui`, and `/ui-api/*`) require an `X-API-Key` header matching `ORCH_API_KEY`. The `/ui-api` routes proxy authenticated calls on behalf of the browser UI.

## Clarification Workflow & Required Metadata

Before the planner can execute, every job must include the same context ChatGPT Deep Research collects via its clarification questions. If any of these fields are missing, the orchestrator sets the job status to `clarification_required`, the worker skips it, and the UI surfaces the prompts until an operator fills them in:

- **time_horizon** – what time window to cover (current, 12-18 months, multi-year outlook).
- **region_focus** – the primary geography/regulatory domain (US, EU/GDPR, APAC, etc.).
- **data_modalities** – which modalities are in scope (blogs, PDFs, scraped HTML, structured CSV/JSON, etc.).
- **integration_targets** – downstream systems that must ingest the report (knowledge graph, SharePoint, MDM, ticketing, etc.).
- **quality_constraints** – tone/compliance expectations, red lines, or SME sign-off requirements.

Submit clarifications via the UI panel or `POST /ui-api/research/:id/clarify` with a body such as:

```json
{
  "responses": {
    "time_horizon": "6-12 month roadmap",
    "region_focus": "US + EU",
    "data_modalities": "blogs, PDFs, CSV",
    "integration_targets": "sharepoint, knowledge-graph",
    "quality_constraints": "objective tone, cite every section"
  }
}
```

Once every required field has a value, the orchestrator automatically returns the job to the `queued` state and the worker begins planning.

## Inspecting Completed Jobs

When someone runs a Deep Research job, just share the **job ID** (for example `43c77160-3beb-4b78-8979-236cd5b8d3c2`). With that ID you can inspect the run in two ways:

1. **API / CLI**

   ```bash
   # Summary list (no key required through the UI proxy)
   curl -s https://deep-research-ui.oremuslabs.app/ui-api/research | jq

   # Detailed payload for a specific job (steps, notes, report assets)
   curl -s https://deep-research-ui.oremuslabs.app/ui-api/research/<job_id> | jq

   # Direct orchestrator API (requires ORCH_API_KEY)
   curl -s -H "x-api-key: $ORCH_API_KEY" https://deep-research.oremuslabs.app/research/<job_id> | jq
   ```

   The response includes the `final_report` text and the `assets` block with Markdown/PDF/DOCX URLs so you can download the rendered reports or cross-check citations.

2. **Browser UI**
   - Open `https://deep-research-ui.oremuslabs.app/ui/`.
   - The “Recent Jobs” panel lists the latest runs (even if the current session didn’t start them). Click any job to load its status, logs, and report preview.
   - Use the download buttons to fetch Markdown/PDF/DOCX artifacts for offline review.

Sharing the job ID is therefore enough context for future debugging or report inspection.
