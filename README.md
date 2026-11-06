# Skyll: verifiable private AI grading on NEAR AI

**NEAR Hackathon 2026 · Track: Privacy & Private AI**

Skyll grades handwritten exam papers for schools in India. Most of the students are minors. For the hackathon, we moved **every AI call that touches student data into NEAR AI Cloud's private inference**: confidential hardware (Intel TDX with NVIDIA confidential-computing GPUs) that the AI provider, cloud host and GPU operator cannot see into. Each call comes with a **receipt that anyone can verify** to show it ran there.

## What existed before, and what we built

Skyll already ran in production for several coaching institutes and schools before the hackathon (Q-002). That code is the baseline, tagged [`pre-hackathon`](../../tree/pre-hackathon). **Only the NEAR AI integration was built during the hackathon window**, tagged [`hackathon-submission`](../../tree/hackathon-submission):

**[View the hackathon diff: `pre-hackathon...hackathon-submission`](../../compare/pre-hackathon...hackathon-submission)**

This repository is a public mirror of our private repository, with a fresh, short history. Internal docs, operations scripts and infrastructure details are removed, and client school names are replaced with "Partner Academy A–I".

## The problem

An AI grader reads every student's answers. Today a school has to trust the model provider: what it logs, who can see it, and whether the grade it got back came from the model that was promised. India's DPDP Act treats children's data as needing extra care, and schools ask us where their students' answers go.

## What the integration does

For a school that is opted in (`NEAR_AI_SCHOOLS`), every model call that carries student data goes to **NEAR AI Cloud only**:

| Step | Model in NEAR's TEE |
| --- | --- |
| OCR of answer sheets | `Qwen/Qwen3-VL-30B-A3B-Instruct`, with `Qwen/Qwen3.8-27B` for pages it loops on |
| Answer extraction, grading, reports, cohort regrades | `deepseek-ai/DeepSeek-V4.1-Flash-1017` |
| Visual rescue of diagrams | `Qwen/Qwen3-VL-30B-A3B-Instruct` |
| Tutor, practice grading, copilot, parent reports, search, Exam Notes | `deepseek-ai/DeepSeek-V4.1-Flash-1017` |

We use Qwen for OCR because DeepSeek's vision model silently corrected a student's wrong answer in our test, which would have changed the marks. One feature has no private path: Exam Notes PDF upload is refused for these schools instead of being sent outside the TEE.

**Rubric building stays outside the TEE.** Reading the question paper and answer key, building the marking rubric and checking the key use our normal OCR and model providers. These jobs read only the paper and the key, so they carry no student data.

Each call works like this:

1. **Attest first.** The caller fetches NEAR AI's attestation report with a fresh 32-byte nonce, then verifies it locally:
   - the Intel TDX quote for both the gateway and the model node (Intel DCAP via `@phala/dcap-qvl`), including an accepted TCB status
   - `report_data` binds each TEE's signing key to our nonce, and the TD is not in debug mode
   - MRCONFIGID matches the attested `app_compose`, and RTMR3 matches a replay of the event log
   - the NVIDIA GPU evidence, through NVIDIA's attestation service (NRAS)

   It re-attests every hour, per model.
2. **Call the model.** It sends the chat completion through NEAR AI's gateway and keeps the exact request and response bytes.
3. **Verify the response.** It fetches the response signature and checks three things: the signature covers `model:SHA256(request):SHA256(response)` over those exact bytes, the signing key matches exactly one key from the verified attestation, and the ECDSA signature recovers to that key.
4. **Keep a receipt.** It stores the receipt with the raw attestation report (`private_inference_receipts` and `private_inference_attestations`, migration 091). Anyone can re-verify it later without trusting Skyll.

An opted-in school **never falls back** to a non-private provider. If NEAR AI is unavailable or verification fails, the job fails and retries rather than sending the data elsewhere.

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
npx vitest run apps/processing-worker/nearPrivateInference.test.js apps/processing-worker/nearOcr.test.js src/test/private-inference-routing.test.js
```

These cover signature checks (TEE and gateway signatures, tampered bytes, keys not in the attestation, forged addresses, ed25519), the RTMR3 replay, school opt-in matching, OCR behaviour and routing.

## Where the code is

| File | What it does |
| --- | --- |
| [`apps/processing-worker/nearPrivateInference.js`](apps/processing-worker/nearPrivateInference.js) | Attestation verification, private completions, response signature checks, receipts |
| [`apps/processing-worker/nearOcr.js`](apps/processing-worker/nearOcr.js) | OCR inside the TEE, with the in-TEE fallback for looping pages |
| [`apps/processing-worker/inferenceContext.js`](apps/processing-worker/inferenceContext.js) | Carries each request's school so calls route by opt-in, and refuses a call whose routing is unknown |
| [`apps/processing-worker/llmGateway.js`](apps/processing-worker/llmGateway.js), [`api/_lib/llmGateway.js`](api/_lib/llmGateway.js) | Route an opted-in school's model calls to NEAR AI only |
| [`api/_lib/privateInferenceRequest.js`](api/_lib/privateInferenceRequest.js) | Sets the school from the signed-in user on the API routes |
| [`apps/processing-worker/index.js`](apps/processing-worker/index.js) | Job context, OCR routing, visual rescue, receipt persistence |
| [`scripts/migrations/091_private_inference_receipts.cjs`](scripts/migrations/091_private_inference_receipts.cjs) | Receipt and attestation tables (additive, idempotent) |
| [`scripts/nearPrivateInferenceSmoke.mjs`](scripts/nearPrivateInferenceSmoke.mjs) | One end-to-end private grade, which saves its evidence |
| [`scripts/verifyPrivateInferenceReceipt.mjs`](scripts/verifyPrivateInferenceReceipt.mjs) | Independent re-verification of a saved receipt |

## What this does and does not protect

- **Protected:** every AI call that touches student data. For an opted-in school, answers and grades reach a model only inside attested TEEs, so NEAR AI, the cloud host and the GPU operator cannot read them. Each call can be traced to a specific attested model key.
- **Not in a TEE: rubric building.** Question papers and answer keys go to our normal providers, as described above.
- **Not in a TEE: Skyll itself.** Our worker, API, database and file storage handle the same data outside a TEE, and teachers see it. That is the service a school signs up for. This project protects what the AI provider can see, not what Skyll can see.
- **DPDP.** Private inference helps meet the DPDP Act's duty of reasonable security safeguards for children's data, and it limits what our AI vendor can see. It does not on its own make a product DPDP compliant: consent, retention and breach handling are separate obligations.
- **Rollout.** Private inference is off by default and is switched on per school. No live school is switched on yet. So far it has run on our evaluation set and on synthetic answers. The API routes have run end to end locally with real NEAR calls, and are not yet deployed on Vercel.

## Grading quality: what it costs

We measured each step on our evaluation set of real exam questions (human-adjudicated marks, de-identified, kept off GitHub). Our gate for any grading change: no subject with 50 or more questions drops more than 2 points. **The full setup does not pass this gate yet.**

| What moved into the TEE | Questions | Within one mark, current pipeline | Within one mark, TEE | Gate |
|---|---:|---:|---:|---|
| Grading calls only | 2,103 | 88.2% | **88.4%** | Pass |
| Plus OCR of answer sheets (the setup in this repo) | 2,084 | 86.9% | **85.1%** | Fail: Hindi, SST |

- **Answer-sheet OCR.** Hindi fell from 81.5% to 63.0% and SST from 87.9% to 81.8%. Biology and History had too few questions to judge. Answers flagged for teacher review rose about 26%.
- **Rubric building.** We also tried it in the TEE. A partial run (963 questions, 23 of 40 rubrics, six subjects) fell from 88.7% to 86.1%, with English down 5.3 points and German and Physics 2.8 each. It holds no student data, so we kept it outside.
- **What this means.** The privacy path works today, and we would not switch on a real school until these gaps close. Teachers review flagged answers before results go out.

## Third-party libraries and AI tools used for this work

- [`@phala/dcap-qvl`](https://www.npmjs.com/package/@phala/dcap-qvl): Intel DCAP quote verification
- [`ethers`](https://www.npmjs.com/package/ethers): EIP-191 signature recovery
- [`pdfjs-dist`](https://www.npmjs.com/package/pdfjs-dist), [`@napi-rs/canvas`](https://www.npmjs.com/package/@napi-rs/canvas): render PDF pages to images for OCR
- [Claude Code](https://claude.com/claude-code): AI coding assistant. Much of the integration code in the hackathon diff was AI-generated, then reviewed by us.

The rest of the dependencies come from the pre-hackathon baseline (see `package.json`). The verification steps follow NEAR AI's [verification docs](https://docs.near.ai/cloud/verification).

## Team and licence

Built by [Falkram](https://www.skyllai.com) (contact@skyllai.com). Copyright (c) 2026 Falkram. All rights reserved. The code is published for NEAR Hackathon judging only; see [LICENSE](LICENSE).
