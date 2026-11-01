#!/usr/bin/env node
// Grades one synthetic answer through NEAR AI private inference, prints the
// verified attestation and receipt, and saves the evidence for
// scripts/verifyPrivateInferenceReceipt.mjs. Touches no database and no student data.
//
//   NEAR_AI_API_KEY=sk-... node scripts/nearPrivateInferenceSmoke.mjs [--out near-receipt]
import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import dotenv from 'dotenv';
import { parseJsonModelResponse } from '../workers/mistral-ocr/src/ocrProtocol.js';
import { nearAiConfig, nearPrivateChatCompletion, runWithInferenceContext, setPrivateInferenceSink } from '../apps/processing-worker/nearPrivateInference.js';

dotenv.config({ path: path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '.env'), quiet: true });
const config = nearAiConfig();
if (!config) {
  console.error('Set NEAR_AI_API_KEY (in .env or the environment).');
  process.exit(1);
}
const outIndex = process.argv.indexOf('--out');
const outDir = path.resolve(outIndex > 0 ? process.argv[outIndex + 1] : 'near-receipt');

let attestation = null;
setPrivateInferenceSink({ attestation: async (record) => { attestation = record; } });

const prompt = `Grade this answer. Return JSON {"marks": number, "max_marks": 2, "feedback": string}.
Question: Why does ice float on water? (2 marks)
Answer key: Ice is less dense than liquid water (1) because hydrogen bonds hold molecules in an open lattice (1).
Student answer: Ice floats because it is lighter than water, the molecules are spread out in a crystal.`;

const started = Date.now();
const result = await runWithInferenceContext({ school: 'Smoke Test School', jobId: 'smoke', jobType: 'smoke' }, () => nearPrivateChatCompletion(config, {
  temperature: 0,
  max_tokens: 2000,
  response_format: { type: 'json_object' },
  messages: [{ role: 'user', content: prompt }],
}));
if (!result.ok) {
  console.error(`NEAR AI request failed (${result.status}): ${JSON.stringify(result.body).slice(0, 300)}`);
  process.exit(1);
}

const { summary, report_json: reportJson, ...attestationMeta } = attestation;
console.log('Attestation verified:', JSON.stringify({ ...attestationMeta, ...summary }, null, 2));
console.log('Grade:', JSON.stringify(parseJsonModelResponse(result.body.choices[0].message.content)));
console.log('Receipt:', JSON.stringify(result.receipt, null, 2));

await mkdir(outDir, { recursive: true });
await writeFile(path.join(outDir, 'attestation.json'), JSON.stringify({ ...attestationMeta, summary, report: JSON.parse(reportJson) }, null, 2));
await writeFile(path.join(outDir, 'receipt.json'), JSON.stringify(result.receipt, null, 2));
await writeFile(path.join(outDir, 'request.json'), result.requestBytes);
await writeFile(path.join(outDir, 'response.json'), result.responseBytes);
console.log(`Saved evidence to ${outDir}. Re-check it with: node scripts/verifyPrivateInferenceReceipt.mjs ${path.relative(process.cwd(), outDir) || '.'}`);
console.log(`Done in ${((Date.now() - started) / 1000).toFixed(1)}s`);
