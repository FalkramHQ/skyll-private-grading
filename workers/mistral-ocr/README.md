# Skyll Mistral OCR Worker

> **Status: prototype / fallback.** Production intake jobs are currently
> processed by the OCI worker described in [the OCI worker guide](../../docs/OCI_WORKER.md).
> This Cloudflare implementation is retained as a deployable reference, not the
> primary production path.

This queue consumer performs only OCR. It accepts a durable job identifier,
retrieves short-lived R2 URLs from the authenticated Skyll server, calls
Mistral OCR, and persists a versioned result for each asset in Turso. A second
queue job consumes the active question-paper and ideal-key artifacts to build a
versioned canonical question map and marking rubric with the configured
DeepSeek reasoning model.

It deliberately does not grade, approve, or publish reports. Those later
pipeline stages can consume the active `asset_ocr_runs` rows without having to
re-read a PDF or scan.

## Deploy

1. Authenticate Wrangler against the production Cloudflare account.
2. Create `skyll-mistral-ocr` and `skyll-mistral-ocr-dlq` once.
3. Set `MISTRAL_API_KEY`, `DEEPSEEK_API_KEY`, `TURSO_DATABASE_URL`,
   `TURSO_AUTH_TOKEN`, and `OCR_WORKER_SHARED_SECRET` as Worker secrets.
4. Set `OCR_WORKER_URL` and the same `OCR_WORKER_SHARED_SECRET` as server-only
   Vercel variables.
5. Run `npm run worker:ocr:deploy` from the repository root.

`/health` is intentionally the only unauthenticated route. `/dispatch` accepts
only the shared server-to-worker secret and places a small `{ jobId }` message
on the queue.
