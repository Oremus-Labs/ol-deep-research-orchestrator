export type JobStatus = "queued" | "running" | "completed" | "error" | "cancelled";

export interface ResearchJob {
  id: string;
  question: string;
  options: Record<string, unknown>;
  metadata: Record<string, unknown>;
  status: JobStatus;
  final_report: string | null;
  report_assets?: ReportAssets | null;
  created_at: string;
  updated_at: string;
  depth?: string | null;
  max_steps?: number | null;
  max_duration_seconds?: number | null;
  started_at?: string | null;
  completed_at?: string | null;
  error?: string | null;
}

export interface ResearchStep {
  id: string;
  job_id: string;
  title: string;
  tool_hint?: string | null;
  status: JobStatus | "pending" | "partial";
  step_order: number;
  result?: Record<string, unknown> | null;
}

export interface NoteRecord {
  id: string;
  job_id: string;
  step_id?: string | null;
  role: string;
  importance: number;
  token_count: number;
  content: string;
  source_url?: string | null;
}

export interface SourceRecord {
  id: string;
  note_id: string;
  url?: string | null;
  title?: string | null;
  snippet?: string | null;
  raw_storage_url?: string | null;
}

export interface ReportAssets {
  markdown_url: string;
  pdf_url: string;
  docx_url: string;
  checksums: {
    markdown: string;
    pdf: string;
    docx: string;
  };
  citations: {
    number: number;
    title?: string | null;
    url?: string | null;
  }[];
}
