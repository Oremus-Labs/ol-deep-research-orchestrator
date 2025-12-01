import { QdrantClient } from "@qdrant/js-client-rest";
import { config } from "../config";
import { logger } from "../logger";

const qdrantOptions: { url: string; apiKey?: string } = {
  url: config.qdrant.url,
};
if (config.qdrant.apiKey) {
  qdrantOptions.apiKey = config.qdrant.apiKey;
}

export const qdrant = new QdrantClient(qdrantOptions);

export async function ensureCollection(vectorSize = 768) {
  try {
    await qdrant.getCollection(config.qdrant.collection);
  } catch (error) {
    logger.info({ collection: config.qdrant.collection }, "Creating Qdrant collection");
    await qdrant.createCollection(config.qdrant.collection, {
      vectors: {
        size: vectorSize,
        distance: "Cosine",
      },
    });
  }
}

export async function upsertNoteVector(
  noteId: string,
  vector: number[],
  payload: Record<string, unknown>,
) {
  await qdrant.upsert(config.qdrant.collection, {
    wait: false,
    points: [
      {
        id: noteId,
        vector,
        payload,
      },
    ],
  });
}

export async function querySimilarNotes(params: {
  vector: number[];
  limit: number;
  minImportance: number;
  excludeJobId?: string;
}) {
  const filter: Record<string, unknown> = {
    must: [
      {
        key: "importance",
        range: { gte: params.minImportance },
      },
      {
        key: "role",
        match: { any: ["step_summary", "cross_job_summary"] },
      },
    ],
  };
  if (params.excludeJobId) {
    (filter as Record<string, unknown>).must_not = [
      {
        key: "job_id",
        match: { value: params.excludeJobId },
      },
    ];
  }

  const response = await qdrant.search(config.qdrant.collection, {
    vector: params.vector,
    limit: params.limit,
    filter,
    with_payload: true,
    with_vector: false,
  });

  return response
    .map((item) => ({
      id: item.id,
      score: item.score,
      payload: item.payload ?? {},
    }))
    .filter((item) => Boolean(item.payload?.content));
}
