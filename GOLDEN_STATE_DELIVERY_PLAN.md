# Golden-State Delivery Plan

This document is the definitive playbook for taking our current Deep Research system to the ChatGPT-grade “golden state.” It captures the latest verified status, the exact work items ahead (code + UI + devops), and the validation evidence required before each phase is marked complete. By following it line-by-line we can maintain context, avoid regressions, and continue after a context reset without ambiguity.

> **Prerequisite:** Always review the primary reference design, `Designing a Production-Ready Multi-Phase Deep Research Pipeline for Enterprises.docx.md`, and the THOUGHTFLOW transcript before executing any phase. This plan derives every requirement from those sources; reading them first prevents misinterpretation.

### How to Use This Document
1. **Read the Current Baseline** (Section 0) so you know what code/tag is live.
2. **Identify the phase** you are executing (e.g., “Phase 1 – Clarification & Intake”).
3. For that phase, perform:
   - Code edits listed (paths + files).
   - Deployment steps (docker tag, Helm/AppSet updates, Argo sync).
   - Validation steps (capture job IDs, metrics, screenshots).
4. **Before declaring the phase complete**, append evidence to Section 10 (Phase Closure Checklist). This ensures future runs know precisely what was done, how it was tested, and what remains.
5. Repeat for the next phase. If requirements change mid-phase, update the relevant section here so the plan always reflects reality.

### Common Commands Reference
- **Git workflow (each repo)**  
  ```bash
  git status
  git add <files>
  git commit -m "Phase <n>: <summary>"
  git push origin main
  git log -1 --oneline   # record SHA in Section 10
  ```
  *Repositories to update for most phases:*
  - `~/source/repos/ol-deep-research-orchestrator`
  - `~/source/repos/ol-kubernetes-cluster`
  - `~/source/repos/ol-n8n` (when workflows change)

- **Build & push image**
  ```bash
  npm run build
  docker build -t ghcr.io/oremus-labs/ol-deep-research-orchestrator:<tag> .
  docker push ghcr.io/oremus-labs/ol-deep-research-orchestrator:<tag>
  ```
- **Update Helm values**: edit `apps/workloads/deep-research-{orchestrator,ui}/chart/values.yaml` and bump `image.tag`.
- **Update ApplicationSet**: edit `clusters/oremus-labs/mgmt/root/appsets/workloads.yaml` and set `imageTag` to `<tag>`.
- **Verify ApplicationSet change**: run `rg <tag> clusters/oremus-labs/mgmt/root/appsets/workloads.yaml` to confirm the file references the new tag before applying.
- **Apply + sync**
  ```bash
  kubectl apply -f clusters/oremus-labs/mgmt/root/appsets/workloads.yaml
  ARGO_SERVER=$(kubectl -n argocd get pods -l app.kubernetes.io/name=argocd-server -o jsonpath='{.items[0].metadata.name}')
  kubectl -n argocd exec $ARGO_SERVER -- argocd app sync workloads-deep-research-orchestrator
  kubectl -n argocd exec $ARGO_SERVER -- argocd app sync workloads-deep-research-ui
  ```
- **Validate deployment**
  ```bash
  kubectl -n deep-research get pods
  kubectl -n deep-research logs deployment/deep-research-orchestrator
  ```
- **Prometheus scraping check**
  ```bash
  kubectl port-forward -n deep-research deployment/deep-research-orchestrator 8080:8080 &
  curl -s http://localhost:8080/metrics | grep <metric_name>
  kill %1
  ```
- **Loki logs (Grafana Loki + kubectl)**  
  ```bash
  kubectl -n deep-research logs deployment/deep-research-orchestrator --since=10m | tee /tmp/orchestrator.log
  ```

### n8n Workflow Update Procedure
Some phases require updating n8n workflows. Follow the bi-directional sync contract described in `ol-n8n/docs/workflow-sync.md`:

1. **Authoring in n8n:** make changes via the UI. Ensure the workflow has `availableInMCP: true` and isn’t tagged `no-sync`/`helper`.
2. **Export (n8n ➜ repo):**
   - From n8n UI, export the workflow JSON.
   - Save under `ol-n8n/workflows/<slug>/workflow.json`. If a custom folder is needed, set `workflow.settings.gitSyncPath`.
   - Update documentation (`ol-n8n/docs/workflow-sync.md`) if the process changes.
   - Run the n8n-to-Repo sync workflow (UI or MCP `execute_workflow` call with ID `WCmzFI4sbs3AbgEF`).
   - Pull the repo to ensure files match what the workflow wrote, then `git add workflows/<...>/workflow.json docs/workflow-sync.md`.
3. **Repo ➜ n8n:** after committing/pushing, run the Git Sync workflow (ID `QNoVZU40nl4mmTEN`, via UI or MCP) so n8n reflects the committed JSON.
4. **Verification:** follow the End-to-End checklist (repo➜n8n, n8n➜repo, round-trip, MCP health) before moving to the next phase.

---

## 0. Current Verified Baseline (tag `cl3-proxy1`)

| Area | Status | Evidence |
| --- | --- | --- |
| Repos | `ol-deep-research-orchestrator@main` (post-proxy download patch) and `ol-kubernetes-cluster@main` with ApplicationSet targeting `cl3-proxy1`. | `git log -1` in both repos shows latest proxy work. |
| Container | `ghcr.io/oremus-labs/ol-deep-research-orchestrator:cl3-proxy1` pushed and deployed. | `kubectl -n deep-research get deploy deep-research-{orchestrator,ui}` shows image `cl3-proxy1`. |
| Helm/AppSet | `apps/workloads/deep-research-{orchestrator,ui}` values + `clusters/.../appsets/workloads.yaml` point to `cl3-proxy1`. | `rg cl3-proxy1 ol-kubernetes-cluster -n`. |
| Features | Multi-tool retrieval, MinIO raw artifacts, Markdown/PDF/DOCX + download proxy, UI showing step timeline & job actions, basic job logs, no citation ledger yet. | UI + `/research/<job>` tests. |
| Gaps | No clarification workflow, no ledger/section drafts, no hybrid retrieval, limited QA, no Prometheus metrics beyond basics, no appendix. | Observed during job `960b1d31-...`. |

Whenever we roll back or branch from another tag, update this table first so everyone knows the baseline.

---

## 1. Clarification & Intake Workflow

**Objective:** Match THOUGHTFLOW’s initial question clarification behavior before research starts.

**Reference:** THOUGHTFLOW transcript lines 1-200.

### Code Changes
1. `ol-deep-research-orchestrator/src/index.ts`
   - Add new route `POST /ui-api/research/:id/clarify` to accept operator answers.
   - Modify `createJobFromPayload` to mark jobs as `clarification_required` when required metadata (time horizon, region, modalities, integration goals, quality constraints) is missing.
   - Update `buildJobResponse` to include `clarification_prompts` array and `metadata` field.
2. `src/services/worker.ts`
   - Ensure worker exits early if job status is `clarification_required`.
3. UI (`ui/src/App.tsx`)
   - Render outstanding clarification questions with textareas and “Submit clarification” button calling new endpoint, then polling job until status moves to `queued`.
4. `README.md` (or new `docs/clarification.md`)
   - Document the clarification lifecycle and required metadata fields.

### Deployment
1. `npm run build` in orchestrator repo.
2. `docker build -t ghcr.io/oremus-labs/ol-deep-research-orchestrator:<tag>` + `docker push`.
3. Update `apps/workloads/deep-research-{orchestrator,ui}/chart/values.yaml` image tags to `<tag>`.
4. Update ApplicationSet `clusters/.../workloads.yaml` to `<tag>` and commit the change.
5. `kubectl apply -f clusters/.../workloads.yaml` then `kubectl -n argocd exec ... -- argocd app sync workloads-deep-research-{orchestrator,ui}`.

### Validation
- Trigger a job without metadata via UI; confirm UI shows clarification prompts and orchestrator status `clarification_required`.
- Submit answers; job should move to `queued` automatically.
- Ensure logs show metadata stored and worker only starts after clarification.

**Document completion:** Append a “Clarification workflow ✅” section to this file summarizing the tests performed, including job IDs used.

---

## 2. Multi-Phase Orchestrator & Planner Iterations

**Objective:** Implement the agentic plan → execute → reassess loop described in the design doc (§Multi-Phase Architecture).

**Reference:** `...docx.md` lines 5-41, 31-41.
### Code Changes
1. `src/services/worker.ts`
   - Add `planSteps(job, metadata)` that creates structured `research_steps` per sub-topic (regulation, performance, cost, etc.).
   - After each step execution round, run `evaluateCoverage(job)` (see §4) and, if not satisfied, auto-insert new steps (`INSERT INTO research_steps ... status='queued'`).
2. New config keys in `src/config.ts`: `MAX_ITERATIONS`, `ITERATION_TOKEN_BUDGET`.
3. Extend `research_steps` table (migration) to include `theme` and `iteration`.

### Deployment
1. Create migration `003_step_metadata.sql`; run `npm run migrate` locally then `kubectl exec deep-research-postgres-0 -- psql -d deep_research -f migrations/003_step_metadata.sql`.
2. Build/push image, update Helm values, update `clusters/.../workloads.yaml` imageTag `<tag>` (commit the change), then apply + Argo sync as in §1.

### Validation
- Run a complex query; inspect DB to ensure steps created with themes/iterations.
- Confirm logs show iteration loop and job only finishes after coverage satisfied.
- Document job ID + logs snippet in this file.

---

## 3. Retrieval & Ingestion Enhancements

**Objective:** Meet the design doc’s ingestion requirements (OCR, HTML cleanup, structured metadata, hybrid retrieval).

**Reference:** `...docx.md` lines 5-24, 187-195.
### Code Changes
1. Add `services/ingestion/pdfOcr.ts` using Tesseract (Node binding) to convert PDFs before embedding.
2. Extend `n8n` workflows:
   - `deep-research-web-search` to capture metadata (title, authors, publish date).
   - `deep-research-fetch-url` to run readability/HTML-to-Markdown conversion (e.g., `node-readability`).
   - Follow the n8n workflow update procedure (export JSON, place under `ol-n8n/workflows/...`, update docs, commit/push).
3. Update orchestrator’s `fetchSources` function to store metadata with raw artifacts (Postgres `sources` table).
4. Implement hybrid retrieval: before hitting Qdrant, run SearXNG query with keywords derived from clarified metadata, merge results.

### Deployment
- Sync updated n8n workflows (per procedure above), commit/push in `ol-n8n`.
- Build/push new orchestrator image, update Helm values + `workloads.yaml` imageTag `<tag>`, commit changes, then `kubectl apply` + Argo sync.

### Validation
- Submit a PDF-heavy query; confirm OCR text appears in notes.
- Check `sources` table for metadata fields.
- Ensure hybrid retrieval logs show both vector and keyword hits.
- Record job IDs + evidence here.

---

## 4. Coverage, Conflict, and Quality Gates

**Objective:** Implement the QA loop (coverage matrix, conflict detection, tone/PII filters) per design doc §Quality Assurance.

**Reference:** `...docx.md` lines 11-24, 360-520.
### Code Changes
1. New module `services/qa/coverage.ts`:
   - Build matrix mapping clarified requirements → supporting notes, return boolean.
2. `services/qa/conflict.ts`:
   - Detect conflicting numeric claims in notes; return structured conflict list.
3. `services/qa/tone.ts`:
   - Simple heuristics/regex to flag subjective language or PII.
4. Integrate these in worker after each iteration; if any validation fails, plan follow-up steps or mark job `needs_review`.
5. Expose Prometheus metrics (`deep_research_qa_conflicts_total`, etc.) in `metrics.ts`.

### Deployment
- Build/push new image, update Helm values + `workloads.yaml` imageTag `<tag>` (commit), apply + Argo sync.

### Validation
- Run test job with known conflicting sources; ensure report includes “Conflicting Evidence” section.
- Verify Prometheus metrics:
  ```bash
  kubectl port-forward -n deep-research deployment/deep-research-orchestrator 8080:8080 &
  curl -s http://localhost:8080/metrics | grep deep_research_qa_conflicts_total
  kill %1
  ```
- Record job ID, metric output, and any tone/PII warnings in Section 10.

---

## 5. Citation Ledger & Verification (CL-1 + CL-2)

**Objective:** Deliver deterministic `[n](#ref-n)` citations with ledger persistence, as per design doc & THOUGHTFLOW requirements.

**Reference:** `...docx.md` lines 5-8, 33-39, 187-195; THOUGHTFLOW constraints lines 6-20.
### Phase CL-1 — Schema
1. Migrations `004_citation_ledger.sql`, `005_section_drafts.sql` as outlined earlier.
2. Repository helpers (`repositories/jobRepository.ts`) to insert/update ledger entries and drafts.

### Phase CL-2 — Planner & Draft Lifecycle
1. Update planner to seed `section_drafts` rows (keys: exec_summary, background, etc.).
2. After each note batch, group by section and run summarization bounded by token limits.
3. Implement `linkifyCitations` (already partially done) to map note → ledger entry.

### Deployment
- Apply migrations locally + in cluster.
- Build/push new image, update Helm values and `clusters/.../workloads.yaml` imageTag `<tag>` (commit), `kubectl apply` + Argo sync.

### Verification
- Run job; inspect `citation_ledger` table and ensure `report_assets.citations` reflect same numbering.
- Download Markdown/PDF via proxy and confirm clickable references and appended references section identical to design doc layout.
- Record job ID + sample references in this doc.

---

## 6. Section Synthesis & Appendix

**Objective:** Mirror the reference report structure (Exec Summary → Background → Detailed Analysis sub-sections → Recommendations → Risks → References + Appendix).

**Reference:** `...docx.md` Detailed Analysis/Recommendations sections; THOUGHTFLOW appendix requirement (lines 6-20).
### Code Changes
1. Introduce `prompts/templates/*.md` with section scaffolds.
2. Worker uses section drafts to populate template, including Appendix listing datasets/tools (from ingestion metadata).
3. Update Pandoc conversion (Dockerfile includes templates) to ensure consistent styling.

### Deployment
- Build/push updated image (Pandoc templates included), update Helm values + `workloads.yaml` imageTag `<tag>` (commit), apply + Argo sync.

### Validation
- Run job with multiple tools; appendix should list each data source/tool used.
- Confirm Markdown/PDF/DOCX share identical structure.

---

## 7. Observability & Compliance

**Objective:** Implement metrics/logging/residency controls from design doc §Deployment & Integration.

**Reference:** `...docx.md` lines 161-200, 197-200; THOUGHTFLOW clarifications on governance (lines 146-195).
### Tasks
1. Annotate MinIO uploads with metadata (`region`, `compliance_tag`) using bucket policies or object tags.
2. Add Prometheus metrics for tokens per step, iteration count, download proxy hits; update Grafana dashboards.
3. Stream structured audit logs (JSON) to Loki (`logger.info({jobId, step, tool})` with correlation IDs).
4. Update `DEEP_RESERACH_PROJECT_SPECIFICS.md` to document new secrets/configs.

### Deployment
- Build/push updated image once metrics/logging changes are in place, update Helm values + `workloads.yaml` imageTag `<tag>` (commit), apply + Argo sync.

### Validation
- Prometheus:
  ```bash
  kubectl port-forward -n deep-research deployment/deep-research-orchestrator 8080:8080 &
  curl -s http://localhost:8080/metrics | grep -E \"deep_research_tokens_per_step|deep_research_job_rescues_total|deep_research_download_proxy_hits_total\"
  kill %1
  ```
- Loki/logs: `kubectl -n deep-research logs deployment/deep-research-orchestrator --since=10m | grep \"correlationId\"` and store sample JSON in `/docs/logs/phase7.txt`.
- Capture Grafana/Loki screenshots and attach paths in Section 10.

---

## 8. UI Enhancements & Operator UX

**Objective:** Provide UI parity with ChatGPT Deep Research features (clarification prompts, phase indicators, citation table, appendix viewer, download buttons hitting proxy).

**Reference:** THOUGHTFLOW log (clarification + progress UI expectations) and deliverable spec (lines 6-20).
### Changes
1. `ui/src/App.tsx`:
   - Add clarification panel, coverage/conflict indicators, citation list, appendix component.
   - Show progress phases (Planning, Retrieval, Synthesis, Finalizing) based on job status fields.
   - Link downloads to `/ui-api/research/:id/report/{markdown|pdf|docx}` (already done) and add fallback messages.
2. CSS updates for new panels.
3. UI tests: run `npm --prefix ui run build` and manual verification.

### Deployment
- `npm --prefix ui run build`, `npm run build` overall, build/push new image, update Helm values + `workloads.yaml` imageTag `<tag>` (commit), apply + Argo sync.

### Validation
- Trigger job requiring clarification; UI should prompt and then transition through phases.
- After completion, UI shows citation table and appendix.
- Document with screenshots stored in repo (`docs/screenshots/ui-clarification.png`, etc.).

---

## 9. Publishing & Integration Hooks

**Objective:** Integrate with SharePoint/Confluence and provide diagnostics bundle.

**Reference:** `...docx.md` lines 167-177 (knowledge repository integration).
### Tasks
1. Add optional configuration to push final reports + assets to SharePoint via API (use secrets from OnePassword).
2. Implement `/research/:id/diagnostics` endpoint returning JSON bundle (job metadata, citation ledger entries, MinIO paths).
3. Document integration steps in `docs/publishing.md`.

### Deployment
- Build/push image, update Helm values + `workloads.yaml` imageTag `<tag>` (commit), apply + Argo sync.
- For SharePoint/Confluence connectors, ensure corresponding secrets/OnePassword items are added and committed via Helm chart before applying.

---

## 10. Phase Closure Checklist

For each phase, append an entry in this format:
```
### Phase <n> – <Title> ✅
- Code commits:
  - ol-deep-research-orchestrator: <sha>
  - ol-kubernetes-cluster: <sha>
  - ol-n8n: <sha or N/A>
- Docker image: ghcr.io/oremus-labs/ol-deep-research-orchestrator:<tag>
- Helm/AppSet updates: workloads.yaml imageTag=<tag>; values.yaml updated and committed.
- kubectl apply output: <summary or link to log snippet>.
- Argo sync commands: paste the commands used with server pod name.
- Validation:
  - Job IDs tested: <id1>, <id2>
  - Metrics commands/output: `curl ... | grep ...`
  - Screenshots/log paths: <path>
- Outstanding follow-ups: <none or details>
```

### Phase 0 – Baseline Verification ✅
- Code commits:
  - ol-deep-research-orchestrator: 38a7f31
  - ol-kubernetes-cluster: f2383f9
  - ol-n8n: N/A
- Docker image: ghcr.io/oremus-labs/ol-deep-research-orchestrator:cl3-proxy1
- Helm/AppSet updates: workloads.yaml imageTag=cl3-proxy1 (verified via `rg cl3-proxy1 clusters/oremus-labs/mgmt/root/appsets/workloads.yaml`)
- kubectl apply output: N/A (baseline already deployed)
- Argo sync commands: N/A (not run; deployments already healthy)
- Validation:
  - Deployment images checked via `kubectl -n deep-research get deploy deep-research-{orchestrator,ui} -o jsonpath='{.spec.template.spec.containers[0].image}'` → both `cl3-proxy1`
  - Repo state confirmed via `git log -1 --oneline` (orchestrator `38a7f31`, cluster `f2383f9`)
- Outstanding follow-ups: none

Always include the exact commands run (or reference to saved logs/screenshots) so future readers can reproduce the verification.

---

## Reference Mapping

- **Design Doc:** “Designing a Production-Ready Multi-Phase Deep Research Pipeline for Enterprises.docx.md” – primary architectural requirements (lines cited throughout plan).
- **THOUGHTFLOW Transcript:** “Designing a Production-Ready...-GPT-THOUGHTFLOW.md” – clarification workflow + agent behavior reference.
- **CHATGPT_DEEP_RESEARCH_ENHANCEMENTS.md:** Backlog tracker; this plan is embedded there so enhancements are always aligned.

Keep this plan synchronized with actual work. If scope changes or additional phases are needed, update both the relevant section and the Phase Closure Checklist.
