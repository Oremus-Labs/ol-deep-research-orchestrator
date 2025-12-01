import fs from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import crypto from "node:crypto";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import {
  ResearchJob,
  NoteRecord,
  SourceRecord,
  ReportAssets,
  CitationLedgerRecord,
} from "../types/job";
import { putObject } from "./minioClient";
import { logger } from "../logger";

const execFileAsync = promisify(execFile);

interface BuildParams {
  job: ResearchJob;
  finalReport: string;
  notes: NoteRecord[];
  sources: SourceRecord[];
  citationLedger?: CitationLedgerRecord[];
}

export async function buildReportArtifacts(params: BuildParams): Promise<ReportAssets> {
  const citations = buildCitationEntries(params.citationLedger, params.sources);
  const markdown = renderMarkdown(params.job, params.finalReport, params.notes, citations);
  const tmpDir = path.join(os.tmpdir(), "deep-research-reports", params.job.id);
  await fs.mkdir(tmpDir, { recursive: true });
  await ensurePandocAvailable();

  const mdPath = path.join(tmpDir, "report.md");
  const pdfPath = path.join(tmpDir, "report.pdf");
  const docxPath = path.join(tmpDir, "report.docx");

  await fs.writeFile(mdPath, markdown, "utf8");
  await runPandoc([mdPath, "-o", pdfPath, "--from", "markdown", "--pdf-engine=xelatex"], "pdf");
  await runPandoc([mdPath, "-o", docxPath, "--from", "markdown"], "docx");

  const [mdBuffer, pdfBuffer, docxBuffer] = await Promise.all([
    fs.readFile(mdPath),
    fs.readFile(pdfPath),
    fs.readFile(docxPath),
  ]);

  const markdownUrl = await putObject(
    `reports/${params.job.id}/report.md`,
    mdBuffer,
    "text/markdown; charset=utf-8",
  );
  const pdfUrl = await putObject(
    `reports/${params.job.id}/report.pdf`,
    pdfBuffer,
    "application/pdf",
  );
  const docxUrl = await putObject(
    `reports/${params.job.id}/report.docx`,
    docxBuffer,
    "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
  );

  await fs.rm(tmpDir, { recursive: true, force: true });

  return {
    markdown_url: markdownUrl,
    pdf_url: pdfUrl,
    docx_url: docxUrl,
    checksums: {
      markdown: sha256(mdBuffer),
      pdf: sha256(pdfBuffer),
      docx: sha256(docxBuffer),
    },
    citations: citations.map((entry) => ({
      number: entry.number,
      title: entry.title,
      url: entry.url,
    })),
  };
}

function renderMarkdown(
  job: ResearchJob,
  finalReport: string,
  notes: NoteRecord[],
  citations: CitationEntry[],
) {
  const generated = new Date().toISOString();
  const summaryNotes = notes.filter((n) => n.role === "step_summary").slice(0, 5);
  const criticNotes = notes.filter((n) => n.role === "critic_note");

  const sections: string[] = [];
  sections.push(`# Deep Research Report`);
  sections.push(`**Job ID:** ${job.id}`);
  sections.push(`**Question:** ${job.question}`);
  sections.push(`**Generated:** ${generated}`);
  sections.push(``);
  sections.push(`## Executive Summary`);
  sections.push(finalReport.trim());

  if (summaryNotes.length) {
    sections.push(`## Key Findings`);
    sections.push(
      summaryNotes
        .map(
          (note) =>
            `- ${note.content.replace(/\s+/g, " ").trim()}`,
        )
        .join("\n"),
    );
  }

  if (criticNotes.length) {
    sections.push(`## Critic Notes`);
    sections.push(
      criticNotes
        .map((note) => `- ${note.content.replace(/\s+/g, " ").trim()}`)
        .join("\n"),
    );
  }

  if (citations.length) {
    sections.push(`## References`);
    sections.push(
      citations
        .map((entry) => {
          const title = entry.title ?? entry.url ?? "Untitled Source";
          const anchor = `ref-${entry.number}`;
          const renderedLink = entry.url ? `[${title}](${entry.url})` : title;
          return `<a id="${anchor}"></a>[${entry.number}] ${renderedLink}`;
        })
        .join("\n"),
    );
  }

  return sections.join("\n\n");
}

interface CitationEntry {
  key: string;
  number: number;
  title?: string | null;
  url?: string | null;
}

function buildCitationEntries(
  ledger: CitationLedgerRecord[] | undefined,
  sources: SourceRecord[],
): CitationEntry[] {
  if (ledger && ledger.length) {
    return ledger
      .map((entry) => ({
        key: `${entry.job_id}:${entry.citation_number}`,
        number: entry.citation_number,
        title: entry.title ?? entry.url ?? null,
        url: entry.url ?? null,
      }))
      .sort((a, b) => a.number - b.number);
  }
  return buildFallbackCitationLedger(sources);
}

function buildFallbackCitationLedger(sources: SourceRecord[]): CitationEntry[] {
  const ledger = new Map<string, CitationEntry>();
  let counter = 1;
  for (const source of sources) {
    const key = source.url ?? source.raw_storage_url ?? source.id;
    if (!key) {
      continue;
    }
    if (!ledger.has(key)) {
      ledger.set(key, {
        key,
        number: counter++,
        title: source.title ?? source.snippet ?? source.url ?? "Untitled Source",
        url: source.url ?? undefined,
      });
    }
  }
  return Array.from(ledger.values()).sort((a, b) => a.number - b.number);
}

function sha256(buffer: Buffer) {
  return crypto.createHash("sha256").update(buffer).digest("hex");
}

let pandocCheck: Promise<void> | null = null;

async function ensurePandocAvailable() {
  if (!pandocCheck) {
    pandocCheck = execFileAsync("pandoc", ["--version"]) // warm up binary presence
      .then(() => undefined)
      .catch((error) => {
        pandocCheck = null;
        logger.error({ error }, "pandoc binary missing or unusable");
        throw new Error("pandoc binary missing; ensure Docker image installs pandoc/texlive");
      });
  }
  return pandocCheck;
}

async function runPandoc(args: string[], artifact: string) {
  try {
    await execFileAsync("pandoc", args);
  } catch (error) {
    logger.error({ error, args }, "pandoc conversion failed");
    throw new Error(`pandoc conversion failed while producing ${artifact}`);
  }
}
