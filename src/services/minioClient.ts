import { PutObjectCommand, S3Client } from "@aws-sdk/client-s3";
import { config } from "../config";

const url = new URL(config.minio.endpoint);

export const s3 = new S3Client({
  region: "us-east-1",
  endpoint: config.minio.endpoint,
  forcePathStyle: true,
  credentials: {
    accessKeyId: config.minio.accessKey,
    secretAccessKey: config.minio.secretKey,
  },
});

export async function putObject(
  key: string,
  body: string | Uint8Array,
  contentType = "application/json",
) {
  await s3.send(
    new PutObjectCommand({
      Bucket: config.minio.bucket,
      Key: key,
      Body: typeof body === "string" ? Buffer.from(body) : body,
      ContentType: contentType,
    }),
  );
  const protocol = config.minio.useSSL ? "https" : "http";
  return `${protocol}://${url.host}/${config.minio.bucket}/${key}`;
}
