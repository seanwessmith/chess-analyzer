const shardKey = process.env.S3_KEY; // injected by Batch
await downloadShard(shardKey);
await mainOptimized(); // your existing script
await uploadResults();
