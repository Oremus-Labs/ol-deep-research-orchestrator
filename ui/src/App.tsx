import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import type {
  CreateJobPayload,
  JobAssets,
  JobListItem,
  JobListResponse,
  JobResponse,
  JobStatus,
  JobStep,
} from "./types";

type DepthOption = "quick" | "normal" | "deep";

type LogEntry = {
  id: string;
  timestamp: string;
  message: string;
};

type JobAction = "pause" | "start" | "cancel" | "delete";

const resolveStepOrder = (order: JobStep["order"], fallbackIndex: number) => {
  if (typeof order === "number" && Number.isFinite(order) && order > 0) {
    return order;
  }
  return fallbackIndex + 1;
};

const POLL_INTERVAL_MS = 5000;
const TERMINAL_STATUSES: JobStatus[] = ["completed", "error", "cancelled"];
const STATUS_LABEL: Record<JobStatus, string> = {
  queued: "Queued",
  running: "In Progress",
  completed: "Completed",
  error: "Error",
  cancelled: "Cancelled",
  paused: "Paused",
  clarification_required: "Needs Clarification",
};

const REQUIRED_METADATA_KEYS = [
  "time_horizon",
  "region_focus",
  "data_modalities",
  "integration_targets",
  "quality_constraints",
] as const;

interface FormState {
  question: string;
  depth: DepthOption;
  maxSteps: number;
  maxDuration: number;
  tags: string;
}

const createDefaultFormState = (): FormState => ({
  question: "",
  depth: "normal",
  maxSteps: 8,
  maxDuration: 1800,
  tags: "",
});

const formatDateTime = (value?: string | null) => {
  if (!value) return "—";
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return "—";
  return date.toLocaleString();
};

const formatDuration = (start?: string | null, end?: string | null) => {
  if (!start || !end) return "—";
  const ms = new Date(end).getTime() - new Date(start).getTime();
  if (Number.isNaN(ms) || ms < 0) {
    return "—";
  }
  const seconds = Math.floor(ms / 1000);
  const minutes = Math.floor(seconds / 60);
  const remainingSeconds = seconds % 60;
  return `${minutes}m ${remainingSeconds}s`;
};

const isTerminal = (status: JobStatus) => TERMINAL_STATUSES.includes(status);

const truncateText = (value: string, maxLength = 90) => {
  if (!value) return "";
  return value.length > maxLength ? `${value.slice(0, maxLength - 1)}…` : value;
};

const formatMetadataLabel = (value: string) => {
  return value
    .replace(/[_-]+/g, " ")
    .replace(/\s+/g, " ")
    .trim()
    .replace(/\b\w/g, (char) => char.toUpperCase());
};

function StatusBadge({ status }: { status: JobStatus }) {
  return (
    <span className={`status-badge status-${status}`}>
      <span className="status-dot" />
      {STATUS_LABEL[status]}
    </span>
  );
}

function EmptyState() {
  return (
    <div className="card placeholder-card">
      <h2>Waiting for a job</h2>
      <p className="secondary-text">
        Submit a question from the left panel to trigger the Deep Research workflow. Live status,
        logs, and the final report will appear here once the job starts running.
      </p>
    </div>
  );
}

function AssetsTable({ job }: { job: JobResponse }) {
  if (!job.assets) return null;
  const assetEntries = [
    { label: "Markdown", format: "markdown" as const, checksum: job.assets.checksums?.markdown },
    { label: "PDF", format: "pdf" as const, checksum: job.assets.checksums?.pdf },
    { label: "DOCX", format: "docx" as const, checksum: job.assets.checksums?.docx },
  ];
  const rows = assetEntries.reduce(
    (acc, entry) => {
      const assetUrl = job.assets?.[`${entry.format}_url` as keyof JobAssets];
      if (!assetUrl) {
        return acc;
      }
      acc.push({
        label: entry.label,
        format: entry.format,
        checksum: entry.checksum,
      });
      return acc;
    },
    [] as { label: string; format: "markdown" | "pdf" | "docx"; checksum?: string }[],
  );

  if (!rows.length) {
    return null;
  }

  const buildDownloadUrl = (format: "markdown" | "pdf" | "docx") =>
    `/ui-api/research/${job.job_id}/report/${format}`;

  return (
    <div className="card">
      <h3>Report Artifacts</h3>
      <table className="assets-table">
        <thead>
          <tr>
            <th>Format</th>
            <th>Checksum</th>
            <th />
          </tr>
        </thead>
        <tbody>
          {rows.map((row) => (
            <tr key={row.label}>
              <td>{row.label}</td>
              <td className="secondary-text">{row.checksum ?? "—"}</td>
              <td>
                <a
                  href={buildDownloadUrl(row.format)}
                  target="_blank"
                  rel="noreferrer"
                  className="asset-link"
                >
                  Download
                </a>
              </td>
            </tr>
          ))}
        </tbody>
      </table>
      {job.assets.citations?.length ? (
        <>
          <h4>Citations</h4>
          <ul className="citations-list">
            {job.assets.citations.map((citation) => (
              <li key={citation.number}>
                <strong>[{citation.number}]</strong>{" "}
                {citation.url ? (
                  <a href={citation.url} target="_blank" rel="noreferrer">
                    {citation.title ?? citation.url}
                  </a>
                ) : (
                  citation.title ?? "Untitled source"
                )}
              </li>
            ))}
          </ul>
        </>
      ) : null}
    </div>
  );
}

function LogPanel({ logs }: { logs: LogEntry[] }) {
  if (!logs.length) {
    return (
      <div className="log-panel">
        <p className="secondary-text">Logs will appear here once a job is running.</p>
      </div>
    );
  }
  return (
    <div className="log-panel">
      {logs.map((log) => (
        <div key={log.id} className="log-entry">
          <span>{formatDateTime(log.timestamp)}</span>
          <p>{log.message}</p>
        </div>
      ))}
    </div>
  );
}

export default function App() {
  const [formState, setFormState] = useState<FormState>(() => createDefaultFormState());
  const [jobId, setJobId] = useState<string | null>(null);
  const [job, setJob] = useState<JobResponse | null>(null);
  const [isSubmitting, setIsSubmitting] = useState(false);
  const [uiError, setUiError] = useState<string | null>(null);
  const [logs, setLogs] = useState<LogEntry[]>([]);
  const [jobList, setJobList] = useState<JobListItem[]>([]);
  const [isLoadingJobs, setIsLoadingJobs] = useState(false);
  const [jobListError, setJobListError] = useState<string | null>(null);
  const [jobActionError, setJobActionError] = useState<string | null>(null);
  const [actionInFlight, setActionInFlight] = useState<JobAction | null>(null);
  const [clarificationDraft, setClarificationDraft] = useState<Record<string, string>>({});
  const [clarificationSubmitting, setClarificationSubmitting] = useState(false);
  const [clarificationError, setClarificationError] = useState<string | null>(null);
  const prevStepStatuses = useRef(new Map<string, string>());
  const prevJobStatus = useRef<JobStatus | null>(null);
  const activeJobId = job?.job_id ?? jobId;

  const handleInputChange = (
    event: React.ChangeEvent<HTMLInputElement | HTMLTextAreaElement | HTMLSelectElement>,
  ) => {
    const { name, value } = event.target;
    setFormState((prev) => {
      if (name === "maxSteps") {
        return { ...prev, maxSteps: Number(value) };
      }
      if (name === "maxDuration") {
        return { ...prev, maxDuration: Number(value) };
      }
      if (name === "depth") {
        return { ...prev, depth: value as DepthOption };
      }
      return {
        ...prev,
        [name]: value,
      };
    });
  };

  const refreshJobList = useCallback(async (options?: { showSpinner?: boolean }) => {
    if (options?.showSpinner) {
      setIsLoadingJobs(true);
    }
    try {
      const response = await fetch("/ui-api/research?limit=25");
      if (!response.ok) {
        throw new Error(`Job list status ${response.status}`);
      }
      const payload = (await response.json()) as JobListResponse;
      setJobList(payload.jobs ?? []);
      setJobListError(null);
    } catch (error) {
      setJobListError("Failed to load job history");
      console.error(error);
    } finally {
      if (options?.showSpinner) {
        setIsLoadingJobs(false);
      }
    }
  }, []);

  const handleSubmit = async (event: React.FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (!formState.question.trim()) {
      setUiError("Please enter a research question.");
      return;
    }
    setUiError(null);
    setIsSubmitting(true);
    try {
      const payload: CreateJobPayload = {
        question: formState.question.trim(),
        options: {
          depth: formState.depth,
          max_steps: Number.isNaN(formState.maxSteps) ? undefined : formState.maxSteps,
          max_duration_seconds: Number.isNaN(formState.maxDuration)
            ? undefined
            : formState.maxDuration,
        },
        metadata: {
          source: "deep-research-ui",
          ui_version: "v1",
        },
      };
      const tags = formState.tags
        .split(",")
        .map((tag) => tag.trim())
        .filter(Boolean);
      if (tags.length) {
        payload.options = payload.options ?? {};
        payload.options.tags = tags;
      }
      const response = await fetch("/ui-api/research", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(payload),
      });
      if (!response.ok) {
        const message = await response.text();
        throw new Error(message || "Failed to submit job");
      }
      const result = (await response.json()) as { job_id: string; status: JobStatus };
      const timestamp = new Date().toISOString();
      setJobId(result.job_id);
      setJob({
        job_id: result.job_id,
        status: result.status,
        question: payload.question,
        created_at: timestamp,
        updated_at: timestamp,
        final_report: null,
        assets: null,
        metadata: payload.metadata ?? {},
        clarification_prompts: [],
        steps: [],
        progress: { total_steps: 0, completed_steps: 0 },
        notes: [],
      });
      prevStepStatuses.current.clear();
      prevJobStatus.current = null;
      setLogs([
        {
          id: `${result.job_id}-queued`,
          timestamp,
          message: `Job ${result.job_id} queued`,
        },
      ]);
      setJobActionError(null);
      setActionInFlight(null);
      void refreshJobList();
    } catch (error) {
      setUiError(error instanceof Error ? error.message : "Failed to submit job");
    } finally {
      setIsSubmitting(false);
    }
  };

  const resetJobView = () => {
    setJobId(null);
    setJob(null);
    setLogs([]);
    setUiError(null);
    setFormState(createDefaultFormState());
    prevStepStatuses.current.clear();
    prevJobStatus.current = null;
    setJobActionError(null);
    setActionInFlight(null);
    setClarificationDraft({});
    setClarificationError(null);
    setClarificationSubmitting(false);
  };

  const handleSelectExistingJob = (selectedId: string) => {
    if (!selectedId) return;
    setUiError(null);
    setJobActionError(null);
    setActionInFlight(null);
    setJobId(selectedId);
    if (job?.job_id !== selectedId) {
      setJob(null);
      setLogs([]);
      prevStepStatuses.current.clear();
      prevJobStatus.current = null;
    }
  };

  const handleManualJobRefresh = () => {
    void refreshJobList({ showSpinner: true });
  };

  const handleJobAction = useCallback(
    async (action: JobAction) => {
      if (!job) return;
      if (action === "delete") {
        const confirmed = window.confirm("Delete this job and all related artifacts?");
        if (!confirmed) {
          return;
        }
      }
      setJobActionError(null);
      setActionInFlight(action);
      try {
        const endpoint =
          action === "delete"
            ? `/ui-api/research/${job.job_id}`
            : `/ui-api/research/${job.job_id}/${action}`;
        const method = action === "delete" ? "DELETE" : "POST";
        const response = await fetch(endpoint, { method });
        if (!response.ok) {
          const text = await response.text();
          throw new Error(text || `Action ${action} failed`);
        }
        if (action === "delete") {
          resetJobView();
          await refreshJobList({ showSpinner: true });
          return;
        }
        const detail = await fetch(`/ui-api/research/${job.job_id}`);
        if (detail.ok) {
          const payload = (await detail.json()) as JobResponse;
          setJob(payload);
        }
        await refreshJobList();
      } catch (error) {
        setJobActionError(error instanceof Error ? error.message : "Job action failed");
      } finally {
        setActionInFlight(null);
      }
    },
    [job, refreshJobList],
  );

  const handleClarificationInputChange = (key: string, value: string) => {
    setClarificationDraft((prev) => ({ ...prev, [key]: value }));
  };

  const handleClarificationSubmit = async () => {
    if (!job) return;
    const prompts = job.clarification_prompts ?? [];
    const responses: Record<string, string> = {};
    prompts.forEach((prompt) => {
      const value = clarificationDraft[prompt.key]?.trim();
      if (value) {
        responses[prompt.key] = value;
      }
    });
    if (!Object.keys(responses).length) {
      setClarificationError("Provide clarification details before submitting.");
      return;
    }
    setClarificationSubmitting(true);
    try {
      const response = await fetch(`/ui-api/research/${job.job_id}/clarify`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ responses }),
      });
      if (!response.ok) {
        const message = await response.text();
        throw new Error(message || "Failed to submit clarification");
      }
      const payload = (await response.json()) as JobResponse;
      setJob(payload);
      setClarificationError(null);
    } catch (error) {
      setClarificationError(
        error instanceof Error ? error.message : "Failed to submit clarifications",
      );
    } finally {
      setClarificationSubmitting(false);
    }
  };

  useEffect(() => {
    void refreshJobList();
    const interval = window.setInterval(() => {
      void refreshJobList();
    }, 15000);
    return () => {
      window.clearInterval(interval);
    };
  }, [refreshJobList]);

  useEffect(() => {
    if (!jobId) return undefined;
    let cancelled = false;
    let timer: number | undefined;

    const poll = async () => {
      try {
        const response = await fetch(`/ui-api/research/${jobId}`);
        if (!response.ok) {
          throw new Error(`Status ${response.status}`);
        }
        const payload = (await response.json()) as JobResponse;
        if (!cancelled) {
          setJob(payload);
          setUiError(null);
          if (!isTerminal(payload.status)) {
            timer = window.setTimeout(poll, POLL_INTERVAL_MS);
          }
        }
      } catch (error) {
        if (!cancelled) {
          setUiError("Failed to fetch job status. Retrying…");
          timer = window.setTimeout(poll, POLL_INTERVAL_MS * 2);
        }
      }
    };

    poll();
    return () => {
      cancelled = true;
      if (timer) {
        window.clearTimeout(timer);
      }
    };
  }, [jobId]);

  useEffect(() => {
    if (!job) return;
    const newEntries: LogEntry[] = [];
    if (prevJobStatus.current !== job.status) {
      newEntries.push({
        id: `${job.job_id}-${job.status}-${Date.now()}`,
        timestamp: job.updated_at ?? new Date().toISOString(),
        message: `Job status changed to ${STATUS_LABEL[job.status]}`,
      });
      prevJobStatus.current = job.status;
    }
    job.steps.forEach((step, index) => {
      const displayOrder = resolveStepOrder(step.order, index);
      const previous = prevStepStatuses.current.get(step.id);
      if (!previous) {
        prevStepStatuses.current.set(step.id, step.status);
        if (step.status !== "pending") {
          newEntries.push({
            id: `${step.id}-${step.status}`,
            timestamp: job.updated_at ?? new Date().toISOString(),
            message: `Step ${displayOrder}: "${step.title}" is ${step.status}`,
          });
        }
      } else if (previous !== step.status) {
        prevStepStatuses.current.set(step.id, step.status);
        newEntries.push({
          id: `${step.id}-${step.status}-${Date.now()}`,
          timestamp: job.updated_at ?? new Date().toISOString(),
          message: `Step ${displayOrder} is now ${step.status}`,
        });
      }
    });
    if (newEntries.length) {
      setLogs((prev) => [...newEntries, ...prev].slice(0, 200));
    }
  }, [job]);

  const metadataEntries = useMemo(() => {
    if (!job?.metadata) return [] as { key: string; label: string; value: string }[];
    return Object.entries(job.metadata)
      .filter(([_, value]) => {
        if (value === null || value === undefined) {
          return false;
        }
        if (typeof value === "string") {
          return value.trim().length > 0;
        }
        if (Array.isArray(value)) {
          return value.length > 0;
        }
        if (typeof value === "object") {
          return Object.keys(value as Record<string, unknown>).length > 0;
        }
        return true;
      })
      .map(([key, value]) => {
        let rendered = "";
        if (Array.isArray(value)) {
          rendered = value.map((entry) => String(entry)).join(", ");
        } else if (typeof value === "object") {
          rendered = JSON.stringify(value);
        } else {
          rendered = String(value);
        }
        const priorityIndex = REQUIRED_METADATA_KEYS.indexOf(
          key as (typeof REQUIRED_METADATA_KEYS)[number],
        );
        return {
          key,
          label: formatMetadataLabel(key),
          value: rendered,
          priority: priorityIndex >= 0 ? priorityIndex : REQUIRED_METADATA_KEYS.length,
        };
      })
      .sort((a, b) => {
        if (a.priority !== b.priority) {
          return a.priority - b.priority;
        }
        return a.label.localeCompare(b.label);
      });
  }, [job]);

  const noteStats = useMemo(() => {
    if (!job) return [];
    const map = new Map<string, { count: number; tokens: number }>();
    job.notes.forEach((note) => {
      const current = map.get(note.role) ?? { count: 0, tokens: 0 };
      current.count += 1;
      current.tokens += note.token_count ?? 0;
      map.set(note.role, current);
    });
    return Array.from(map.entries()).map(([role, stats]) => ({
      role,
      ...stats,
    }));
  }, [job]);

  const allStepsCompleted = useMemo(() => {
    if (!job || !job.steps.length) return false;
    return job.steps.every((step) => step.status === "completed" || step.status === "partial");
  }, [job]);

  const orderedSteps = useMemo(() => {
    if (!job) return [] as { step: JobStep; displayOrder: number }[];
    return job.steps
      .map((step, index) => ({ step, displayOrder: resolveStepOrder(step.order, index) }))
      .sort((a, b) => a.displayOrder - b.displayOrder);
  }, [job]);

  const progressPercent = useMemo(() => {
    if (!job) return 0;
    if (!job.progress.total_steps && job.status === "completed") {
      return 100;
    }
    if (!job.progress.total_steps) {
      return job.status === "running" ? 10 : 0;
    }
    return Math.min(
      100,
      Math.round((job.progress.completed_steps / job.progress.total_steps) * 100),
    );
  }, [job]);

  const isFinalizing = useMemo(() => {
    if (!job) return false;
    return job.status === "running" && allStepsCompleted && !job.final_report;
  }, [job, allStepsCompleted]);

  const adjustedProgressPercent = useMemo(() => {
    if (!job) return 0;
    if (job.status === "completed") return 100;
    if (isFinalizing) {
      return Math.min(progressPercent, 95);
    }
    return progressPercent;
  }, [job, isFinalizing, progressPercent]);

  const jobPhase = useMemo(() => {
    if (!job) return "";
    if (job.status === "completed") {
      return "Report finalized";
    }
    if (job.status === "error") {
      return "Job encountered an error";
    }
    if (job.status === "clarification_required") {
      return "Awaiting clarification responses";
    }
    if (!job.steps.length) {
      return "Planning steps…";
    }
    const activeStep = orderedSteps.find((entry) => {
      return !["completed", "partial"].includes(entry.step.status);
    });
    if (activeStep) {
      const originalIndex = job.steps.findIndex((step) => step.id === activeStep.step.id);
      const order = resolveStepOrder(
        activeStep.step.order,
        originalIndex >= 0 ? originalIndex : 0,
      );
      return `Running step ${order}`;
    }
    if (isFinalizing) {
      return "Finalizing report (critic & artifacts)…";
    }
    return "";
  }, [job, orderedSteps, isFinalizing]);

  const metadataSignature = useMemo(() => JSON.stringify(job?.metadata ?? {}), [job?.metadata, job?.job_id]);
  const promptSignature = useMemo(
    () => JSON.stringify(job?.clarification_prompts ?? []),
    [job?.clarification_prompts, job?.job_id],
  );

  useEffect(() => {
    if (!job) {
      setClarificationDraft({});
      setClarificationError(null);
      return;
    }
    if (!job.clarification_prompts?.length) {
      setClarificationDraft({});
      if (job.status !== "clarification_required") {
        setClarificationError(null);
      }
      return;
    }
    setClarificationDraft((prev) => {
      const next: Record<string, string> = {};
      job.clarification_prompts?.forEach((prompt) => {
        const metadataValue = job.metadata?.[prompt.key];
        if (typeof metadataValue === "string") {
          next[prompt.key] = metadataValue;
          return;
        }
        if (Array.isArray(metadataValue)) {
          next[prompt.key] = metadataValue.map((value) => String(value)).join(", ");
          return;
        }
        if (metadataValue !== undefined && metadataValue !== null) {
          next[prompt.key] = String(metadataValue);
          return;
        }
        next[prompt.key] = prev[prompt.key] ?? "";
      });
      return next;
    });
    setClarificationError(null);
  }, [job, metadataSignature, promptSignature]);

  const requiresClarification = job?.status === "clarification_required";
  const outstandingPrompts = job?.clarification_prompts ?? [];

  const canSubmitNewJob =
    !job || isTerminal(job.status) || job.status === "paused" || job.status === "clarification_required";
  const canPause = job ? job.status === "running" || job.status === "queued" : false;
  const canStart = job?.status === "paused";
  const canCancel = job ? ["running", "queued", "paused", "clarification_required"].includes(job.status) : false;
  const canDelete = job ? job.status !== "running" : false;

  return (
    <div className="app-shell">
      <aside className="sidebar">
        <section className="section">
          <h1>Deep Research UI</h1>
          <p className="secondary-text">
            Trigger Deep Research jobs, monitor every step, and read the final report without
            reaching for curl.
          </p>
        </section>
        <form className="card" onSubmit={handleSubmit}>
          <h3>New Job</h3>
          <div className="form-field">
            <label htmlFor="question">Question</label>
            <textarea
              id="question"
              name="question"
              rows={4}
              placeholder="What do you want to research?"
              value={formState.question}
              onChange={handleInputChange}
              disabled={isSubmitting}
            />
          </div>
          <div className="form-field">
            <label htmlFor="depth">Depth</label>
            <select
              id="depth"
              name="depth"
              value={formState.depth}
              onChange={handleInputChange}
              disabled={isSubmitting}
            >
              <option value="quick">Quick</option>
              <option value="normal">Normal</option>
              <option value="deep">Deep</option>
            </select>
          </div>
          <div className="form-field">
            <label htmlFor="maxSteps">Max Steps</label>
            <input
              type="number"
              id="maxSteps"
              name="maxSteps"
              min={1}
              value={formState.maxSteps}
              onChange={handleInputChange}
              disabled={isSubmitting}
            />
          </div>
          <div className="form-field">
            <label htmlFor="maxDuration">Max Duration (seconds)</label>
            <input
              type="number"
              id="maxDuration"
              name="maxDuration"
              min={60}
              step={60}
              value={formState.maxDuration}
              onChange={handleInputChange}
              disabled={isSubmitting}
            />
          </div>
          <div className="form-field">
            <label htmlFor="tags">Tags (comma separated)</label>
            <input
              id="tags"
              name="tags"
              placeholder="compliance, architecture"
              value={formState.tags}
              onChange={handleInputChange}
              disabled={isSubmitting}
            />
          </div>
          {uiError ? <p className="error-text">{uiError}</p> : null}
          <div className="form-actions">
            <button className="primary-btn" type="submit" disabled={isSubmitting || !canSubmitNewJob}>
              {isSubmitting ? "Submitting…" : "Submit Job"}
            </button>
        {job ? (
          <button type="button" className="ghost-btn" onClick={resetJobView}>
            Reset
          </button>
        ) : null}
      </div>
    </form>
        <section className="section">
          <div className="card job-list-card">
            <div className="card-header">
              <h3>Recent Jobs</h3>
              <button
                type="button"
                className="ghost-btn ghost-btn-sm"
                onClick={handleManualJobRefresh}
                disabled={isLoadingJobs}
              >
                {isLoadingJobs ? "Refreshing…" : "Refresh"}
              </button>
            </div>
            {jobListError ? <p className="error-text">{jobListError}</p> : null}
            {jobList.length ? (
              <ul className="job-list">
                {jobList.map((item) => (
                  <li key={item.job_id}>
                    <button
                      type="button"
                      className={`job-list-item ${activeJobId === item.job_id ? "active" : ""}`}
                      onClick={() => handleSelectExistingJob(item.job_id)}
                    >
                      <div className="job-list-title">{truncateText(item.question)}</div>
                      <div className="job-list-meta">
                        <span className={`status-pill status-${item.status}`}>{item.status}</span>
                        <span>{formatDateTime(item.updated_at ?? item.created_at)}</span>
                      </div>
                    </button>
                  </li>
                ))}
              </ul>
            ) : (
              <p className="secondary-text">No jobs yet. Submit a question to get started.</p>
            )}
          </div>
        </section>
        <section className="section">
          <h3>Job Logs</h3>
          <LogPanel logs={logs} />
        </section>
      </aside>
      <main className="main-content">
        {job ? (
          <>
            <div className="card">
              <div className="status-header">
                <StatusBadge status={job.status} />
                <span className="job-id">{job.job_id}</span>
              </div>
              <h2>{job.question}</h2>
              <div className="metadata-grid">
                <div className="metadata-item">
                  <span>Created</span>
                  <strong>{formatDateTime(job.created_at)}</strong>
                </div>
                <div className="metadata-item">
                  <span>Updated</span>
                  <strong>{formatDateTime(job.updated_at)}</strong>
                </div>
                <div className="metadata-item">
                  <span>Duration</span>
                  <strong>{formatDuration(job.created_at, job.updated_at)}</strong>
                </div>
                <div className="metadata-item">
                  <span>Progress</span>
                  <strong>
                    {job.progress.completed_steps}/{job.progress.total_steps || "?"} steps
                  </strong>
                </div>
              </div>
              <div className="progress-meta">
                <div className="progress-bar">
                  <span style={{ width: `${adjustedProgressPercent}%` }} />
                </div>
                {jobPhase ? <span className="progress-message">{jobPhase}</span> : null}
              </div>
              <div className="job-actions">
                {canStart ? (
                  <button
                    type="button"
                    className="ghost-btn ghost-btn-sm"
                    onClick={() => handleJobAction("start")}
                    disabled={actionInFlight !== null}
                  >
                    {actionInFlight === "start" ? "Starting…" : "Start / Resume"}
                  </button>
                ) : null}
                {canPause ? (
                  <button
                    type="button"
                    className="ghost-btn ghost-btn-sm"
                    onClick={() => handleJobAction("pause")}
                    disabled={actionInFlight !== null}
                  >
                    {actionInFlight === "pause" ? "Pausing…" : "Pause"}
                  </button>
                ) : null}
                {canCancel ? (
                  <button
                    type="button"
                    className="danger-btn"
                    onClick={() => handleJobAction("cancel")}
                    disabled={actionInFlight !== null}
                  >
                    {actionInFlight === "cancel" ? "Cancelling…" : "Cancel"}
                  </button>
                ) : null}
                {canDelete ? (
                  <button
                    type="button"
                    className="danger-btn"
                    onClick={() => handleJobAction("delete")}
                    disabled={actionInFlight !== null}
                  >
                    {actionInFlight === "delete" ? "Deleting…" : "Delete"}
                  </button>
                ) : null}
            </div>
            {jobActionError ? <p className="error-text job-action-error">{jobActionError}</p> : null}
            {job.error ? <p className="error-text">Job error: {job.error}</p> : null}
          </div>
          {requiresClarification || metadataEntries.length ? (
            <div className="card clarification-panel">
              {requiresClarification && outstandingPrompts.length ? (
                <>
                  <h3>Clarifications Needed</h3>
                  <p className="secondary-text">
                    Provide the missing metadata so the orchestrator can plan the research. Jobs remain
                    paused until every field below is answered.
                  </p>
                  <div className="clarification-fields">
                    {outstandingPrompts.map((prompt) => (
                      <div className="clarification-field" key={prompt.key}>
                        <label htmlFor={`clarify-${prompt.key}`}>{formatMetadataLabel(prompt.key)}</label>
                        <p className="secondary-text">{prompt.prompt}</p>
                        <textarea
                          id={`clarify-${prompt.key}`}
                          rows={3}
                          value={clarificationDraft[prompt.key] ?? ""}
                          onChange={(event) =>
                            handleClarificationInputChange(prompt.key, event.target.value)
                          }
                          disabled={clarificationSubmitting}
                        />
                      </div>
                    ))}
                  </div>
                  {clarificationError ? <p className="error-text">{clarificationError}</p> : null}
                  <div className="form-actions">
                    <button
                      type="button"
                      className="primary-btn"
                      onClick={handleClarificationSubmit}
                      disabled={clarificationSubmitting}
                    >
                      {clarificationSubmitting ? "Submitting…" : "Submit Clarifications"}
                    </button>
                  </div>
                </>
              ) : null}
              {metadataEntries.length ? (
                <>
                  <h3>Research Metadata</h3>
                  <div className="metadata-grid metadata-details">
                    {metadataEntries.map((entry) => (
                      <div className="metadata-item" key={entry.key}>
                        <span>{entry.label}</span>
                        <strong>{entry.value}</strong>
                      </div>
                    ))}
                  </div>
                </>
              ) : null}
            </div>
          ) : null}
          <div className="card">
            <h3>Step Timeline</h3>
            {orderedSteps.length ? (
              <ul className="steps-list">
                {orderedSteps.map(({ step, displayOrder }) => (
                    <li key={step.id}>
                      <div className="step-row">
                        <strong>
                          Step {displayOrder}: {step.title}
                        </strong>
                        <span className={`status-pill status-${step.status}`}>
                          {step.status}
                        </span>
                      </div>
                      {step.tool_hint ? (
                        <p className="secondary-text">Tool hint: {step.tool_hint}</p>
                      ) : null}
                      {step.theme ? (
                        <p className="secondary-text">
                          Theme: {formatMetadataLabel(step.theme)}
                          {typeof step.iteration === "number" && step.iteration > 0
                            ? ` • Iteration ${step.iteration}`
                            : ""}
                        </p>
                      ) : null}
                    </li>
                  ))}
                  {isFinalizing ? (
                    <li key="finalizing">
                      <div className="step-row">
                        <strong>Final synthesis & artifact build</strong>
                        <span className="status-pill status-running">running</span>
                      </div>
                      <p className="secondary-text">
                        Critic evaluation, citation stitching, and pandoc exports in progress…
                      </p>
                    </li>
                  ) : null}
                </ul>
              ) : (
                <p className="secondary-text">
                  {requiresClarification
                    ? "Planner will publish steps once clarifications are submitted."
                    : "Planner has not published steps yet."}
                </p>
              )}
          </div>
            <div className="card">
              <h3>Report Preview</h3>
              {job.final_report ? (
                <div className="report-container">
                  <ReactMarkdown remarkPlugins={[remarkGfm]}>{job.final_report}</ReactMarkdown>
                </div>
              ) : (
                <p className="markdown-empty">
                  Final report not available yet. It will render here once synthesis finishes.
                </p>
              )}
            </div>
            <AssetsTable job={job} />
            {noteStats.length ? (
              <div className="card">
                <h3>Notes Summary</h3>
                <div className="metadata-grid">
                  {noteStats.map((note) => (
                    <div className="metadata-item" key={note.role}>
                      <span>{note.role}</span>
                      <strong>
                        {note.count} notes • {note.tokens} tokens
                      </strong>
                    </div>
                  ))}
                </div>
              </div>
            ) : null}
          </>
        ) : (
          <EmptyState />
        )}
      </main>
    </div>
  );
}
