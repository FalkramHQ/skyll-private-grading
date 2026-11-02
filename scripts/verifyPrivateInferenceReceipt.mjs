#!/usr/bin/env node
// Re-verifies a saved NEAR AI private-inference receipt with no API key and no
// trust in Skyll: the Intel TDX quotes (Intel DCAP collateral), the NVIDIA GPU
// evidence (NVIDIA NRAS), the key bindings to the stored nonce, and the TEE
// signature over SHA-256 of the exact request and response bytes.
//
//   node scripts/verifyPrivateInferenceReceipt.mjs <dir with attestation.json, receipt.json[, request.json, response.json]>
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { verifyAttestationReport, verifyResponseSignature } from '../apps/processing-worker/nearPrivateInference.js';

const dir = path.resolve(process.argv[2] || 'near-receipt');
const readJson = async (name) => JSON.parse(await readFile(path.join(dir, name), 'utf8'));
const readOptional = (name) => readFile(path.join(dir, name)).catch(() => null);

const attestation = await readJson('attestation.json');
const receipt = await readJson('receipt.json');
const [requestBytes, responseBytes] = await Promise.all([readOptional('request.json'), readOptional('response.json')]);

const step = (label) => console.log(`✓ ${label}`);

// Quote and GPU checks fetch Intel collateral and call NVIDIA NRAS; retry their network blips,
// never a failed check.
async function withNetworkRetry(fn, tries = 4) {
  for (let attempt = 1; ; attempt += 1) {
    try { return await fn(); } catch (error) {
      if (attempt >= tries || !/fetch failed|ECONNRESET|ETIMEDOUT|ENOTFOUND|socket hang up|returned 5\d\d/i.test(String(error.message))) throw error;
      console.log(`• network error (${error.message}); retrying`);
      await new Promise((resolve) => setTimeout(resolve, 2000 * attempt));
    }
  }
}

try {
  if (receipt.attestation_id !== attestation.id) throw new Error('receipt names a different attestation');
  const signers = await withNetworkRetry(() => verifyAttestationReport(attestation.report, attestation.nonce, receipt.model));
  step(`gateway TEE quote verified (Intel TDX, TCB ${signers.gateway.tcb_status}), key ${signers.gateway.signing_address}`);
  for (const model of signers.models) {
    step(`model TEE quote verified (Intel TDX, TCB ${model.tcb_status}${model.gpu_verified ? ', NVIDIA GPU attested' : ''}), key ${model.signing_address}`);
  }

  // Without the original bytes, check the signature over the hashes the receipt records.
  const hashes = requestBytes && responseBytes ? {} : { requestSha256: receipt.request_sha256, responseSha256: receipt.response_sha256 };
  const checked = verifyResponseSignature({
    signature: { text: receipt.signed_text, signature: receipt.signature, signing_address: receipt.signing_address, signing_algo: receipt.signing_algo, signature_kind: receipt.signature_kind },
    requestBytes,
    responseBytes,
    ...hashes,
    model: receipt.model,
    attestation: signers,
  });
  step(`response signed inside the ${checked.kind === 'gateway' ? 'gateway' : 'model'} TEE by an attested key`);
  if (requestBytes && responseBytes) step('signature covers the exact request and response bytes on disk');
  else console.log('• request.json / response.json not present: checked the signature over the recorded hashes only');
  console.log('\nReceipt verified.');
} catch (error) {
  console.error(`✗ ${error.message}`);
  process.exit(1);
}
