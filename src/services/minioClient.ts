import { PutObjectCommand, S3Client, GetObjectCommand } from "@aws-sdk/client-s3";
import { getSignedUrl } from "@aws-sdk/s3-request-presigner";
import { config } from "../config";
import { recordMinioUpload } from "../metrics";

const endpointUrl = new URL(config.minio.endpoint);

export const s3 = new S3Client({
  region: "us-east-1",
  endpoint: config.minio.endpoint,
  forcePathStyle: true,
  credentials: {
    accessKeyId: config.minio.accessKey,
    secretAccessKey: config.minio.secretKey,
  },
});

((s3.config as unknown) as Record<string, unknown>).requestChecksumMode = "DISABLED";

export async function putObject(
  key: string,
  body: string | Uint8Array,
  contentType = "application/json",
) {
  try {
    await s3.send(
      new PutObjectCommand({
        Bucket: config.minio.bucket,
        Key: key,
        Body: typeof body === "string" ? Buffer.from(body) : body,
        ContentType: contentType,
      }),
    );
    recordMinioUpload("success");
  } catch (error) {
    recordMinioUpload("error");
    throw error;
  }
  const protocol = config.minio.useSSL ? "https" : "http";
  return `${protocol}://${endpointUrl.host}/${config.minio.bucket}/${key}`;
}

export async function getSignedObjectUrl(key: string, expiresInSeconds?: number) {
  const expires = clampExpiry(expiresInSeconds ?? config.minio.signedUrlTTL);
  const command = new GetObjectCommand({ Bucket: config.minio.bucket, Key: key });
  return getSignedUrl(s3, command, { expiresIn: expires });
}

export async function getSignedUrlForStoredObject(objectUrl: string) {
  const key = extractKeyFromUrl(objectUrl);
  if (!key) {
    return objectUrl;
  }
  try {
    return await getSignedObjectUrl(key);
  } catch (error) {
    return objectUrl;
  }
}

function extractKeyFromUrl(objectUrl: string): string | null {
  try {
    const parsed = new URL(objectUrl);
    const pathname = decodeURIComponent(parsed.pathname);
    const bucketPrefix = `/${config.minio.bucket}/`;
    if (pathname.startsWith(bucketPrefix)) {
      return pathname.slice(bucketPrefix.length);
    }
    return pathname.replace(/^\//, "");
  } catch (error) {
    return null;
  }
}

function clampExpiry(value: number) {
  const max = 604800; // 7 days
  const min = 60;
  if (!Number.isFinite(value)) return max;
  return Math.max(min, Math.min(max, Math.floor(value)));
}
