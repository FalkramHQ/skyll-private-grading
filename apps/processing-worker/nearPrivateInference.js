// NEAR AI Cloud private inference: chat completions that run inside an attested
// TEE (Intel TDX + NVIDIA confidential GPU), with a verified receipt per response.
//
// Opt-in per school (NEAR_AI_SCHOOLS). For an opted-in school every reasoning call
// goes to NEAR AI only: no fallback to a non-private provider, so a student's
// answers never leave the TEE path once the school is switched on.
//
// Before the first completion, and again every NEAR_AI_ATTESTATION_TTL_MS, the
// worker fetches an attestation report with a fresh nonce and verifies it:
//   - the Intel TDX quote (DCAP, via @phala/dcap-qvl) and its TCB status
//   - report_data binds the signing key and our nonce, and the TD is not in debug mode
//   - MRCONFIGID matches the attested app_compose, RTMR3 matches the event log
//   - the NVIDIA GPU evidence, through NVIDIA's attestation service (NRAS)
// After each completion the worker fetches the response signature and checks it
// covers SHA-256 of the exact request and response bytes and was made by a key
// from the verified attestation. Docs: https://docs.near.ai/cloud/verification

import { createHash, createPublicKey, randomBytes, randomUUID, timingSafeEqual, verify as verifySignatureBytes } from 'node:crypto';
import { verifyMessage } from 'ethers';
import dcap from '@phala/dcap-qvl';
import { currentInferenceContext } from './inferenceContext.js';

export { currentInferenceContext, nearPrivateEnabledFor, nearPrivateEnabledForCurrentJob, runWithInferenceContext } from './inferenceContext.js';

const NRAS_URL = 'https://nras.attestation.nvidia.com/v3/attest/gpu';
let sink = { attestation: async () => {}, receipt: async () => {} };
let cachedAttestation = null;
let pendingAttestation = null;

export class PrivateInferenceVerificationError extends Error {
  constructor(message) {
    super(`NEAR AI private inference not verified: ${message}`);
    this.name = 'PrivateInferenceVerificationError';
  }
}

const fail = (message) => { throw new PrivateInferenceVerificationError(message); };
const sha256Hex = (bytes) => createHash('sha256').update(bytes).digest('hex');
const hexBytes = (value, label) => {
  const hex = String(value || '').replace(/^0x/i, '');
  if (!/^(?:[0-9a-f]{2})*$/i.test(hex)) fail(`${label} is not hex`);
  return Buffer.from(hex, 'hex');
};
const sameBytes = (a, b) => a.length === b.length && timingSafeEqual(a, b);

export function nearAiConfig() {
  const apiKey = process.env.NEAR_AI_API_KEY;
  if (!apiKey) return null;
  return {
    provider: 'nearai',
    baseUrl: (process.env.NEAR_AI_BASE_URL || 'https://cloud-api.near.ai/v1').replace(/\/+$/, ''),
    apiKey,
    model: process.env.NEAR_AI_MODEL || 'deepseek-ai/DeepSeek-V4.1-Flash-1017',
    // NEAR's DeepSeek thinks by default; production grades without thinking, so match it.
    thinking: process.env.NEAR_AI_THINKING === '1',
  };
}

/** Where verified attestations and receipts are persisted (set by the worker). */
export function setPrivateInferenceSink(next) {
  sink = { ...sink, ...next };
}

async function nearFetch(config, path, init = {}) {
  const response = await fetch(`${config.baseUrl}${path}`, {
    ...init,
    headers: {
      authorization: `Bearer ${config.apiKey}`,
      accept: 'application/json',
      'accept-encoding': 'identity',
      'x-no-aliasing': 'true',
      ...(init.headers || {}),
    },
  });
  const bytes = Buffer.from(await response.arrayBuffer());
  let body = null;
  try { body = JSON.parse(bytes.toString('utf8')); } catch { body = null; }
  return { response, bytes, body };
}

function signerIdentity(evidence, label) {
  const algo = String(evidence?.signing_algo || '').toLowerCase();
  if (algo !== 'ecdsa' && algo !== 'ed25519') fail(`${label} has unsupported signing_algo ${evidence?.signing_algo}`);
  const address = hexBytes(evidence.signing_address, `${label}.signing_address`);
  if (address.length !== (algo === 'ecdsa' ? 20 : 32)) fail(`${label}.signing_address has the wrong length`);
  return { algo, address, addressHex: `0x${address.toString('hex')}` };
}

function tdReportOf(verified) {
  const report = verified.report;
  return report.asTd10?.() || report.asTd15?.()?.base || report.asTd15Ex?.()?.base?.base || null;
}

/** RTMR3 = fold of SHA-384(event_type LE32 || ":" || event || ":" || payload) over imr 3 events. */
export function replayRtmr3(eventLog) {
  const events = typeof eventLog === 'string' ? JSON.parse(eventLog) : eventLog;
  let rtmr = Buffer.alloc(48);
  for (const entry of events || []) {
    if (Number(entry.imr) !== 3) continue;
    const type = Buffer.alloc(4);
    type.writeUInt32LE(Number(entry.event_type) >>> 0);
    const digest = createHash('sha384').update(Buffer.concat([
      type, Buffer.from(':'), Buffer.from(String(entry.event || ''), 'utf8'), Buffer.from(':'), hexBytes(entry.event_payload || '', 'event_payload'),
    ])).digest();
    rtmr = createHash('sha384').update(Buffer.concat([rtmr, digest])).digest();
  }
  return rtmr;
}

function appComposeOf(evidence) {
  let info = evidence?.info;
  if (typeof info === 'string') info = JSON.parse(info);
  let tcb = info?.tcb_info;
  if (typeof tcb === 'string') tcb = JSON.parse(tcb);
  return typeof tcb?.app_compose === 'string' ? tcb.app_compose : null;
}

async function verifyNvidiaEvidence(evidence, nonce) {
  if (!evidence.nvidia_payload) return null;
  const payload = typeof evidence.nvidia_payload === 'string' ? JSON.parse(evidence.nvidia_payload) : evidence.nvidia_payload;
  if (String(payload.nonce || '').toLowerCase() !== nonce) fail('GPU evidence does not carry our nonce');
  const response = await fetch(NRAS_URL, {
    method: 'POST',
    headers: { accept: 'application/json', 'content-type': 'application/json' },
    body: JSON.stringify(payload),
  });
  const body = await response.json().catch(() => null);
  if (!response.ok || !Array.isArray(body)) fail(`NVIDIA attestation service returned ${response.status}`);
  const [kind, token] = body[0] || [];
  if (kind !== 'JWT' || typeof token !== 'string') fail('NVIDIA attestation service returned no token');
  const claims = JSON.parse(Buffer.from(token.split('.')[1] || '', 'base64url').toString('utf8'));
  if (claims['x-nvidia-overall-att-result'] !== true) fail('NVIDIA GPU attestation did not pass');
  return { overall: true };
}

/** Verifies one TDX evidence object (gateway or model) against our nonce. */
export async function verifyTdxEvidence(evidence, nonce, label, { acceptedTcb = acceptedTcbStatuses() } = {}) {
  if (String(evidence?.request_nonce || '').toLowerCase() !== nonce) fail(`${label} answered a different nonce`);
  const signer = signerIdentity(evidence, label);
  const verified = await dcap.getCollateralAndVerify(hexBytes(evidence.intel_quote, `${label}.intel_quote`));
  if (!acceptedTcb.includes(verified.status)) fail(`${label} TCB status ${verified.status} is not accepted`);
  const td = tdReportOf(verified);
  if (!td) fail(`${label} quote is not a TDX quote`);
  if (td.tdAttributes[0] & 1) fail(`${label} TD runs in debug mode`);

  const identity = evidence.tls_cert_fingerprint
    ? createHash('sha256').update(Buffer.concat([signer.address, hexBytes(evidence.tls_cert_fingerprint, `${label}.tls_cert_fingerprint`)])).digest()
    : Buffer.concat([signer.address, Buffer.alloc(32 - signer.address.length)]);
  if (!sameBytes(Buffer.from(td.reportData), Buffer.concat([identity, Buffer.from(nonce, 'hex')]))) {
    fail(`${label} report_data does not bind the signing key and nonce`);
  }

  const appCompose = appComposeOf(evidence);
  if (appCompose !== null) {
    const expected = Buffer.concat([Buffer.from([1]), createHash('sha256').update(appCompose, 'utf8').digest(), Buffer.alloc(15)]);
    if (!sameBytes(Buffer.from(td.mrConfigId), expected)) fail(`${label} MRCONFIGID does not match its app_compose`);
  }
  if (evidence.event_log) {
    if (!sameBytes(Buffer.from(td.rtMr3), replayRtmr3(evidence.event_log))) fail(`${label} RTMR3 does not match its event log`);
  }

  const gpu = await verifyNvidiaEvidence(evidence, nonce);
  return {
    algo: signer.algo,
    address: signer.address,
    signing_address: signer.addressHex,
    tcb_status: verified.status,
    advisory_ids: verified.advisory_ids || [],
    app_compose_sha256: appCompose === null ? null : sha256Hex(Buffer.from(appCompose, 'utf8')),
    gpu_verified: Boolean(gpu),
  };
}

function acceptedTcbStatuses() {
  return String(process.env.NEAR_AI_TCB_STATUSES || 'UpToDate,OutOfDate').split(',').map((s) => s.trim()).filter(Boolean);
}

/** Verifies a parsed attestation report (live, or one stored with a receipt) against its nonce. */
export async function verifyAttestationReport(body, nonce, model) {
  const gateway = await verifyTdxEvidence(body.gateway_attestation, nonce, 'gateway attestation');
  const models = [];
  for (const [index, evidence] of (body.model_attestations || []).entries()) {
    models.push(await verifyTdxEvidence(evidence, nonce, `model attestation ${index}`));
  }
  if (!models.length) fail(`no model attestation returned for ${model}`);
  return { gateway, models };
}

/** Fetches and verifies a fresh attestation report, cached for NEAR_AI_ATTESTATION_TTL_MS. */
export async function verifiedAttestation(config = nearAiConfig(), { force = false } = {}) {
  const ttl = Math.max(60_000, Number(process.env.NEAR_AI_ATTESTATION_TTL_MS || 3_600_000));
  if (!force && cachedAttestation && cachedAttestation.model === config.model && Date.now() - cachedAttestation.verifiedAtMs < ttl) {
    return cachedAttestation;
  }
  // Concurrent callers share one in-flight attestation instead of each fetching their own.
  pendingAttestation ||= fetchVerifiedAttestation(config).finally(() => { pendingAttestation = null; });
  return pendingAttestation;
}

async function fetchVerifiedAttestation(config) {
  const nonce = randomBytes(32).toString('hex');
  const query = new URLSearchParams({ model: config.model, provider: 'near', signing_algo: 'ecdsa', nonce, include_tls_fingerprint: 'false' });
  const { response, bytes, body } = await nearFetch(config, `/attestation/report?${query}`);
  if (!response.ok || !body) fail(`attestation report request failed (${response.status}): ${bytes.toString('utf8').slice(0, 200)}`);

  const { gateway, models } = await verifyAttestationReport(body, nonce, config.model);
  const verifiedAt = new Date().toISOString();
  cachedAttestation = {
    id: `att_${sha256Hex(bytes).slice(0, 24)}`,
    model: config.model,
    nonce,
    verifiedAt,
    verifiedAtMs: Date.now(),
    gateway,
    models,
    reportSha256: sha256Hex(bytes),
    reportJson: bytes.toString('utf8'),
  };
  await sink.attestation(attestationRecord(cachedAttestation));
  return cachedAttestation;
}

function signerSummary(signer) {
  return Object.fromEntries(Object.entries(signer).filter(([key]) => key !== 'address'));
}

function attestationRecord(attestation) {
  return {
    id: attestation.id,
    provider: 'nearai',
    model: attestation.model,
    nonce: attestation.nonce,
    report_sha256: attestation.reportSha256,
    report_json: attestation.reportJson,
    summary: { gateway: signerSummary(attestation.gateway), models: attestation.models.map(signerSummary) },
    verified_at: attestation.verifiedAt,
  };
}

function verifySignedText(signature, signer) {
  if (signer.algo === 'ecdsa') {
    const recovered = hexBytes(verifyMessage(Buffer.from(signature.text, 'utf8'), `0x${hexBytes(signature.signature, 'signature').toString('hex')}`), 'recovered signer');
    return sameBytes(recovered, signer.address);
  }
  const key = createPublicKey({ key: { kty: 'OKP', crv: 'Ed25519', x: signer.address.toString('base64url') }, format: 'jwk' });
  return verifySignatureBytes(null, Buffer.from(signature.text, 'utf8'), key, hexBytes(signature.signature, 'signature'));
}

/** Checks a response signature against the exact bytes (or their recorded SHA-256) and the verified attestation. */
export function verifyResponseSignature({ signature, requestBytes, responseBytes, requestSha256 = sha256Hex(requestBytes), responseSha256 = sha256Hex(responseBytes), model, attestation }) {
  if (signature?.error_code) fail(`signature unavailable: ${signature.message || signature.error_code}`);
  const kind = signature?.signature_kind || 'provider_tee';
  const hashes = `${requestSha256}:${responseSha256}`;
  const expectedText = kind === 'gateway' ? hashes : `${model}:${hashes}`;
  if (signature?.text !== expectedText) fail('signed text does not match the exact request and response bytes');
  const claimed = signerIdentity(signature, 'response signature');
  const candidates = kind === 'gateway' ? [attestation.gateway] : attestation.models;
  const matches = candidates.filter((signer) => signer.algo === claimed.algo && sameBytes(signer.address, claimed.address));
  if (matches.length !== 1) fail(`response signer ${claimed.addressHex} matches ${matches.length} verified ${kind} keys, expected exactly 1`);
  if (!verifySignedText(signature, matches[0])) fail('signature does not match the signing key');
  return { kind, signer: matches[0], requestSha256, responseSha256 };
}

async function fetchSignature(config, completionId, model) {
  const query = new URLSearchParams({ model, signing_algo: 'ecdsa' });
  for (let attempt = 0; attempt < 5; attempt += 1) {
    const { response, body } = await nearFetch(config, `/signature/${encodeURIComponent(completionId)}?${query}`);
    if (response.ok && body && !body.error_code) return body;
    if (response.status !== 404 && !body?.error_code) fail(`signature request failed (${response.status})`);
    await new Promise((resolve) => setTimeout(resolve, 500 * (attempt + 1)));
  }
  fail(`no signature for completion ${completionId}`);
}

/**
 * One chat completion on NEAR AI with a verified receipt. Returns the parsed body
 * (same shape as any OpenAI-compatible response) plus the persisted receipt.
 */
export async function nearPrivateChatCompletion(config, requestBody, { signal } = {}) {
  const attestation = await verifiedAttestation(config);
  const requestBytes = Buffer.from(JSON.stringify({
    chat_template_kwargs: { thinking: Boolean(config.thinking) },
    ...requestBody,
    model: config.model,
  }), 'utf8');
  const { response, bytes: responseBytes, body } = await nearFetch(config, '/chat/completions', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: requestBytes,
    signal,
  });
  if (!response.ok || !body || body.error) return { ok: false, status: response.status, body: body || {} };
  if (!body.id) fail('completion has no id to fetch a signature for');

  const signature = await fetchSignature(config, body.id, config.model);
  const checked = verifyResponseSignature({ signature, requestBytes, responseBytes, model: config.model, attestation });
  const context = currentInferenceContext();
  const receipt = {
    id: `pir_${randomUUID()}`,
    attestation_id: attestation.id,
    school: context.school || null,
    test_id: context.testId || null,
    job_id: context.jobId || null,
    job_type: context.jobType || null,
    provider: 'nearai',
    model: config.model,
    completion_id: body.id,
    request_sha256: checked.requestSha256,
    response_sha256: checked.responseSha256,
    signature_kind: checked.kind,
    signed_text: signature.text,
    signature: signature.signature,
    signing_address: checked.signer.signing_address,
    signing_algo: checked.signer.algo,
    tcb_status: checked.signer.tcb_status,
    gpu_verified: checked.signer.gpu_verified,
    verified_at: new Date().toISOString(),
  };
  await sink.receipt(receipt);
  // The exact bytes go back to the caller only (never the sink), so they can be
  // re-hashed later without storing student work beside the receipt.
  return { ok: true, status: response.status, body, receipt, requestBytes, responseBytes };
}
