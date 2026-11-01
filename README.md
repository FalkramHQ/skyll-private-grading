# Skyll: verifiable private AI grading on NEAR AI

**NEAR Hackathon 2026 · Track: Privacy & Private AI**

Skyll grades handwritten exam papers for schools in India. Most of the students are minors. For the hackathon, Skyll's AI grading now runs inside **NEAR AI Cloud's private inference**: confidential hardware (Intel TDX with NVIDIA confidential-computing GPUs) that the AI provider, cloud host and GPU operator cannot see into. Every grade comes with a **receipt that anyone can verify** to show it ran there.

## What existed before, and what we built

Skyll already ran in production for several coaching institutes and schools before the hackathon (Q-002). That code is the baseline, tagged [`pre-hackathon`](../../tree/pre-hackathon). **Only the NEAR AI integration was built during the hackathon window**, tagged [`hackathon-submission`](../../tree/hackathon-submission):

**[View the hackathon diff: `pre-hackathon...hackathon-submission`](../../compare/pre-hackathon...hackathon-submission)**

This repository is a public mirror of our private repository, with a fresh two-commit history. Internal docs, operations scripts and infrastructure details are removed, and client school names are replaced with "Partner Academy A–I".

## The problem

An AI grader reads every student's answers. Today a school has to trust the model provider: what it logs, who can see it, and whether the grade it got back came from the model that was promised. India's DPDP Act treats children's data as needing extra care, and schools ask us where their students' answers go.

## What the integration does

For a school that is opted in (`NEAR_AI_SCHOOLS`), every reasoning call that carries student answers goes to **NEAR AI Cloud only**: answer extraction, grading, report writing and cohort regrades. The model is `deepseek-ai/DeepSeek-V4.1-Flash-1017` running in NEAR's TEE.

1. **Attest before grading.** The worker fetches NEAR AI's attestation report with a fresh 32-byte nonce, then verifies it locally:
   - the Intel TDX quote for both the gateway and the model node (Intel DCAP via `@phala/dcap-qvl`), including an accepted TCB status
   - `report_data` binds each TEE's signing key to our nonce, and the TD is not in debug mode
   - MRCONFIGID matches the attested `app_compose`, and RTMR3 matches a replay of the event log
   - the NVIDIA GPU evidence, through NVIDIA's attestation service (NRAS)

   It re-attests every hour.
2. **Grade.** It sends the chat completion through NEAR AI's gateway and keeps the exact request and response bytes.
3. **Verify the response.** It fetches the response signature and checks three things: the signature covers `model:SHA256(request):SHA256(response)` over those exact bytes, the signing key matches exactly one key from the verified attestation, and the ECDSA signature recovers to that key.
4. **Keep a receipt.** It stores the receipt with the raw attestation report (`private_inference_receipts` and `private_inference_attestations`, migration 091). Anyone can re-verify it later without trusting Skyll.

An opted-in school **never falls back** to a non-private provider. If NEAR AI is unavailable or verification fails, the job fails and retries rather than sending the answers elsewhere. Visual rescue, which uses vision models outside a TEE, is skipped for these schools, and the question goes to teacher review instead.

## Try it

You need Node 22+ and network access to Intel's collateral service (via Phala's PCCS) and NVIDIA NRAS.

```bash
npm ci
```

**1. Verify a real receipt, no API key needed.** [`examples/near-receipt/`](examples/near-receipt) holds a live run that graded a synthetic answer:

```bash
node scripts/verifyPrivateInferenceReceipt.mjs examples/near-receipt
```

You should see both TEE quotes verified, the GPU attested, and the signature matching the exact bytes on disk. Change the grade in `examples/near-receipt/response.json` (for example `\"marks\": 1` → `2`) and run it again: verification fails.

**2. Grade with your own NEAR AI key.**

```bash
NEAR_AI_API_KEY=sk-... node scripts/nearPrivateInferenceSmoke.mjs
node scripts/verifyPrivateInferenceReceipt.mjs near-receipt
```

This grades one synthetic answer end to end and saves fresh evidence to `near-receipt/`. It touches no database and no student data.

**3. Run the tests.**

```bash
npx vitest run apps/processing-worker/nearPrivateInference.test.js
```

These cover signature checks (TEE and gateway signatures, tampered bytes, keys not in the attestation, forged addresses, ed25519), the RTMR3 replay, and school opt-in matching.

## Where the code is

| File | What it does |
| --- | --- |
| [`apps/processing-worker/nearPrivateInference.js`](apps/processing-worker/nearPrivateInference.js) | Attestation verification, private completions, response signature checks, receipts |
| [`apps/processing-worker/inferenceContext.js`](apps/processing-worker/inferenceContext.js) | Carries each job's school so calls route by opt-in |
| [`apps/processing-worker/llmGateway.js`](apps/processing-worker/llmGateway.js), [`api/_lib/llmGateway.js`](api/_lib/llmGateway.js) | Route opted-in schools to NEAR AI only |
| [`apps/processing-worker/index.js`](apps/processing-worker/index.js) | Job context, receipt persistence, visual-rescue skip |
| [`scripts/migrations/091_private_inference_receipts.cjs`](scripts/migrations/091_private_inference_receipts.cjs) | Receipt and attestation tables (additive, idempotent) |
| [`scripts/nearPrivateInferenceSmoke.mjs`](scripts/nearPrivateInferenceSmoke.mjs) | One end-to-end private grade, which saves its evidence |
| [`scripts/verifyPrivateInferenceReceipt.mjs`](scripts/verifyPrivateInferenceReceipt.mjs) | Independent re-verification of a saved receipt |

## What this does and does not protect

- **Protected:** the AI step. Student answers, rubrics and grades are processed only inside attested TEEs, so NEAR AI, the cloud host and the GPU operator cannot read them. Each grade can be traced to a specific attested model key.
- **Not covered: OCR.** Scans are still read by an OCR service outside a TEE. Our rules forbid vision-language models for text extraction, so NEAR's vision model is not a drop-in replacement. This is the next gap to close.
- **Not covered: Skyll itself.** Skyll stores the papers and grades, and teachers see them. That is the service a school signs up for.
- **DPDP.** Private inference helps meet the DPDP Act's duty of reasonable security safeguards for children's data, and it limits what our AI vendor can see. It does not on its own make a product DPDP compliant: consent, retention and breach handling are separate obligations.
- **Rollout.** Private inference is off by default. We switch it on per school only after our grading evaluation shows grades match our current baseline.

## Third-party libraries added for this work

- [`@phala/dcap-qvl`](https://www.npmjs.com/package/@phala/dcap-qvl): Intel DCAP quote verification
- [`ethers`](https://www.npmjs.com/package/ethers): EIP-191 signature recovery

The rest of the dependencies come from the pre-hackathon baseline (see `package.json`). The verification steps follow NEAR AI's [verification docs](https://docs.near.ai/cloud/verification).

## Team and licence

Built by [Falkram](https://www.skyllai.com) (contact@skyllai.com). Copyright (c) 2026 Falkram. All rights reserved. The code is published for NEAR Hackathon judging only; see [LICENSE](LICENSE).
