export type JobStatus =
  | "queued"
  | "running"
  | "completed"
  | "error"
  | "cancelled"
  | "paused"
  | "clarification_required";

export interface JobStep {
  id: string;
  title: string;
  status: JobStatus | "pending" | "partial";
  order: number;
  tool_hint?: string | null;
}

export interface ClarificationPrompt {
  key: string;
  prompt: string;
}

export interface JobNote {
  id: string;
  role: string;
  importance: number;
  token_count: number;
}

export interface JobAssets {
  markdown_url?: string;
  pdf_url?: string;
  docx_url?: string;
  checksums?: Record<string, string>;
  citations?: { number: number; title?: string | null; url?: string | null }[];
}

export interface JobResponse {
  job_id: string;
  status: JobStatus;
  question: string;
  created_at?: string;
  updated_at?: string;
  final_report?: string | null;
  assets?: JobAssets | null;
  metadata?: Record<string, unknown> | null;
  clarification_prompts?: ClarificationPrompt[];
  steps: JobStep[];
  progress: {
    total_steps: number;
    completed_steps: number;
  };
  notes: JobNote[];
  error?: string | null;
}

export interface JobListItem {
  job_id: string;
  status: JobStatus;
  question: string;
  created_at?: string;
  updated_at?: string;
  has_report?: boolean;
}

export interface JobListResponse {
  jobs: JobListItem[];
}

export interface CreateJobPayload {
  question: string;
  options?: {
    depth?: "quick" | "normal" | "deep";
    max_steps?: number;
    max_duration_seconds?: number;
    tags?: string[];
  };
  metadata?: Record<string, unknown>;
}
