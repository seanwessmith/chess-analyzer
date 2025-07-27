// bun run queue-shards.ts s3://my-bucket/pgn/ s3://my-bucket/results/
import { S3Client, ListObjectsV2Command } from "@aws-sdk/client-s3";
import { SQSClient, SendMessageBatchCommand } from "@aws-sdk/client-sqs";
import dotenv from "dotenv";

dotenv.config(); // ✅ pulls variables from .env

const [shardPrefix = "", resultPrefix = ""] = process.argv.slice(2);
if (!shardPrefix.startsWith("s3://") || !resultPrefix.startsWith("s3://")) {
  console.error(
    "Usage: bun run queue-shards.ts <S3-shard-prefix> <S3-result-prefix>"
  );
  process.exit(1);
}

const { BUCKET, KEY_PREFIX } = (() => {
  const [, , bucket, ...key] = shardPrefix.split("/");
  return { BUCKET: bucket, KEY_PREFIX: key.join("/") };
})();

const s3 = new S3Client({ region: process.env.AWS_REGION });
const sqs = new SQSClient({ region: process.env.AWS_REGION });

async function listShards() {
  const cmd = new ListObjectsV2Command({
    Bucket: BUCKET,
    Prefix: KEY_PREFIX,
  });
  const out = await s3.send(cmd);
  return (out.Contents ?? [])
    .filter((o) => o.Key?.endsWith(".pgn"))
    .map((o) => `s3://${BUCKET}/${o.Key}`);
}

function toBatch(entries: string[]) {
  return entries.map((s3Key, i) => ({
    Id: `msg-${i}`,
    MessageBody: JSON.stringify({
      shardKey: s3Key,
      resultPrefix,
    }),
  }));
}

async function main() {
  const shards = await listShards();
  console.log(`Found ${shards.length} shards`);
  for (let i = 0; i < shards.length; i += 10) {
    // SQS batch limit = 10
    const batch = shards.slice(i, i + 10);
    await sqs.send(
      new SendMessageBatchCommand({
        QueueUrl: process.env.SQS_QUEUE_URL,
        Entries: toBatch(batch),
      })
    );
    console.log(`Queued ${i + batch.length} / ${shards.length}`);
  }
}
main().catch((e) => console.error(e));
