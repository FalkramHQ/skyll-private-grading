// Persists verified NEAR AI attestations and per-response receipts (migration 091).
// Shared by the OCI worker and the Vercel routes.

export function privateInferenceDbSink(db) {
  return {
    attestation: (a) => db.execute({
      sql: `INSERT OR IGNORE INTO private_inference_attestations (id, provider, model, nonce, report_sha256, report_json, summary_json, verified_at)
            VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      args: [a.id, a.provider, a.model, a.nonce, a.report_sha256, a.report_json, JSON.stringify(a.summary), a.verified_at],
    }),
    receipt: (r) => db.execute({
      sql: `INSERT INTO private_inference_receipts (id, attestation_id, school, test_id, job_id, job_type, provider, model, completion_id,
              request_sha256, response_sha256, signature_kind, signed_text, signature, signing_address, signing_algo, tcb_status, gpu_verified, verified_at)
            VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      args: [r.id, r.attestation_id, r.school, r.test_id, r.job_id, r.job_type, r.provider, r.model, r.completion_id,
        r.request_sha256, r.response_sha256, r.signature_kind, r.signed_text, r.signature, r.signing_address, r.signing_algo, r.tcb_status, r.gpu_verified ? 1 : 0, r.verified_at],
    }),
  };
}
