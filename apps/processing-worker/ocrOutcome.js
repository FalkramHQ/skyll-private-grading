/**
 * Decide how an OCR job ends from its per-asset results.
 *
 * Until this module existed, an answer sheet whose OCR failed or came back
 * empty was logged, counted as `skippedOptional`, and the job still
 * succeeded. That student then silently vanished from evidence, grading and
 * reports: nothing downstream knew a sheet was missing. Only the question
 * paper and answer key were treated as required.
 *
 * Now every failed asset fails the job. The error is retryable when every
 * per-asset failure is retryable (Datalab 429/5xx, R2 403/5xx, timeouts), so
 * the job is requeued with backoff; on the next attempt `hasActiveArtifact`
 * skips assets that already have OCR and only the failed ones are redone.
 * When retries are exhausted the job ends `failed_retryable`, the test ends
 * `ocr_failed`, and the error text names the students/assets so an operator
 * can act on exactly those.
 *
 * Pure: no db, no I/O. `index.js` feeds it the tallies and throws on `error`.
 */

export const OCR_ASSETS_FAILED_CODE = 'ocr_assets_failed';

const MAX_NAMED_ASSETS = 12;

function describeAsset(asset) {
  const who = asset.student ? `${asset.student} ` : '';
  const reason = asset.reason ? `: ${asset.reason}` : '';
  return `${who}${asset.kind} (${asset.id})${reason}`;
}

/**
 * A per-asset failure is retryable unless its error explicitly said otherwise.
 * `datalabOcr` and `downloadAssetBytes` set `retryable` on their errors; an
 * unknown error (no flag) is retried rather than losing a student on a guess.
 */
export function assetFailureIsRetryable(asset) {
  return asset?.retryable !== false;
}

/**
 * @param {object} input
 * @param {number} input.processed      assets OCR'd in this run
 * @param {number} input.reused         assets with an existing active artifact
 * @param {number} input.totalAssets    all uploaded assets for the test
 * @param {Array}  input.failedRequired question_paper / answer_key failures
 * @param {Array}  input.failedOptional answer-sheet (and other) failures
 *   Each failure: { id, kind, student?, reason, retryable? }
 * @returns {{ ok: boolean, retryable: boolean, error: string|null, code: string|null,
 *             stepDetail: string, failedAssets: Array, result: object }}
 */
export function decideOcrOutcome({ processed = 0, reused = 0, totalAssets = 0, failedRequired = [], failedOptional = [] } = {}) {
  const failedAssets = [...failedRequired, ...failedOptional].map((asset) => ({
    id: String(asset.id),
    kind: String(asset.kind || 'asset'),
    student: asset.student || null,
    reason: String(asset.reason || 'OCR failed'),
    retryable: assetFailureIsRetryable(asset),
  }));
  const base = `${processed} file(s) processed; ${reused} unchanged artifact(s) reused`;
  const result = {
    processedAssets: processed,
    reusedAssets: reused,
    totalAssets,
    failedAssets: failedAssets.map(({ id, kind, student, reason }) => ({ id, kind, student, reason })),
  };
  if (!failedAssets.length) {
    return { ok: true, retryable: false, error: null, code: null, stepDetail: base, failedAssets, result };
  }
  const retryable = failedAssets.every(assetFailureIsRetryable);
  const named = failedAssets.slice(0, MAX_NAMED_ASSETS).map(describeAsset).join('; ');
  const overflow = failedAssets.length > MAX_NAMED_ASSETS ? `; and ${failedAssets.length - MAX_NAMED_ASSETS} more` : '';
  const requiredNote = failedRequired.length ? ` (${failedRequired.length} required source)` : '';
  const error = `OCR failed for ${failedAssets.length} of ${totalAssets} asset(s)${requiredNote}: ${named}${overflow}`;
  const stepDetail = `${base}; FAILED ${failedAssets.length}: ${failedAssets.slice(0, MAX_NAMED_ASSETS).map((asset) => `${asset.student ? `${asset.student} ` : ''}${asset.kind} ${asset.id}`).join(', ')}${overflow}`;
  return { ok: false, retryable, error, code: OCR_ASSETS_FAILED_CODE, stepDetail, failedAssets, result };
}
