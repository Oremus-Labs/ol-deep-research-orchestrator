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
