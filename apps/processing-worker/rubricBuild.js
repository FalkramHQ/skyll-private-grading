// Rubric build: the prompt and model call behind processRubric, shared with the
// offline evaluation (scripts/evalGrading.mjs rebuild-rubrics) so both build rubrics
// the same way. Moved verbatim from apps/processing-worker/index.js.
import { markingRubricPolicy, parseJsonModelResponse } from '../../workers/mistral-ocr/src/ocrProtocol.js';
import { deepinfraCompatConfig, deepseekCompatConfig, isProviderBalanceError, callReasoningJson } from './llmGateway.js';
import { sourceOcrText } from './ocrText.js';

/**
 * The rubric gate does not change the prompt: gated prompt rules (mark steps, per-point
 * weights) were measured with DeepSeek- and Haiku-built rubrics and did not improve grading.
 * @param {{paper: object[], key: object[]}} args active OCR rows for the question paper and answer key
 */
export function buildRubricPrompt({ paper, key }) {
  return `Create the canonical marking package for this assessment. Use the question paper for exact questions, marks, sections and optional-choice rules. Use the ideal key for correct answers and explicit mark splits. Do not invent information. ${markingRubricPolicy()} When the student must draw a diagram, circuit, ray diagram, graph, or labelled figure, set visual_requirements to a short string describing what must be seen (never leave it null for those items). Mixed write-up + diagram questions stay expected_response_type=long_answer but still set visual_requirements. Return JSON only: {"exam":{"title":"","total_marks":0,"optional_rules":"","instructions":"","scoring_plan":{"groups":[{"id":"section_b","choose":0,"units":[{"id":"Q3","question_numbers":["Q3"]}],"selection_policy":"best_score"}]}},"questions":[{"id":"","number":"Q1","question_text":"","marks_allocated":0,"topic":"","expected_response_type":"mcq|numerical|short_answer|long_answer|diagram|table|proof|other","correct_answer_summary":"","accepted_variations":[],"marking_rubric":"","answer_key_evidence":"","question_source_pages":[0],"answer_key_source_pages":[0],"is_optional":false,"selection_group":null,"visual_requirements":null}]}. Every scorable part must be separate. scoring_plan must encode every optional section with exact canonical question units, its permitted count, and any multipart question as one unit. Each question belongs to at most one group. For "one question from each of Sections B, C and D and one other from any section", emit one group over all those units with choose set to the total answers counted (here 4) and at_least listing each section's minimum, e.g. "at_least":[{"id":"section_b","choose":1,"question_numbers":["Q2","Q3"]}]; never add a second group that overlaps the section groups.\n\nQUESTION PAPER:\n${sourceOcrText(paper)}\n\nIDEAL ANSWER KEY:\n${sourceOcrText(key)}`;
}

/**
 * Rubric builder chain. DeepSeek V4 Flash built every production rubric measured in
 * the grading evaluation (stored rubrics scored best, 92.0% within one mark), and the
 * key check (#356) pairs a DeepSeek-built rubric with a Qwen checker. So DeepSeek on
 * DeepInfra builds first (DEEPINFRA_RUBRIC_MODEL, else DEEPINFRA_REASONING_MODEL),
 * then DeepSeek on Phala, or DeepSeek's own API, when DeepInfra's account is empty,
 * rate-limited, timed out or erroring. Qwen on DashScope is no longer in the chain.
 */
export function rubricModelChain(env = process.env) {
  const chain = [];
  const deepinfra = deepinfraCompatConfig();
  if (deepinfra) chain.push({ ...deepinfra, model: env.DEEPINFRA_RUBRIC_MODEL || deepinfra.model });
  const deepseek = deepseekCompatConfig({ purpose: 'rubric' });
  if (deepseek.apiKey) chain.push(deepseek);
  return chain;
}

// Failures worth trying the next provider for; anything else (a bad request) is final.
export function shouldTryNextProvider(error) {
  const status = Number(error?.status || 0);
  return isProviderBalanceError(error?.message)
    || status === 429 || status >= 500
    || /timed? ?out|aborted|fetch failed|ECONNRESET|ENOTFOUND|socket/i.test(String(error?.message || ''));
}

/**
 * Call the rubric model chain (rubricModelChain, then JSON repair through
 * callReasoningJson) and return the parsed package.
 * @returns {Promise<{parsed: object, model: string, payload: object}>}
 */
export async function requestRubricPackage(prompt, { testId = null } = {}) {
  async function requestRubricJson(url, apiKey, model, extra = {}) {
    const response = await fetch(url, {
      method: 'POST',
      headers: { authorization: `Bearer ${apiKey}`, 'content-type': 'application/json' },
      body: JSON.stringify({
        model,
        temperature: 0,
        max_tokens: 16000,
        ...extra,
        response_format: { type: 'json_object' },
        messages: [
          { role: 'system', content: 'Return only valid JSON.' },
          { role: 'user', content: prompt },
        ],
      }),
    });
    const payload = await response.json().catch(() => ({}));
    if (!response.ok) {
      const message = payload?.error?.message || payload?.message || `Rubric model failed (${response.status})`;
      const error = new Error(message);
      error.status = response.status;
      throw error;
    }
    return payload;
  }

  const chain = rubricModelChain();
  if (!chain.length) throw new Error('No rubric model configured (DEEPINFRA_API_KEY / PHALA_API_KEY / DEEPSEEK_API_KEY).');
  let payload;
  let rubricModelUsed;
  for (const [index, provider] of chain.entries()) {
    try {
      rubricModelUsed = provider.model;
      payload = await requestRubricJson(provider.url, provider.apiKey, provider.model, provider.provider === 'deepseek' ? { reasoning_effort: 'low' } : {});
      break;
    } catch (error) {
      const next = chain[index + 1];
      if (!next || !shouldTryNextProvider(error)) throw error;
      console.log(JSON.stringify({ event: 'rubric_fallback', testId, from: provider.provider, to: next.provider, reason: String(error.message).slice(0, 200) }));
    }
  }
  let parsed;
  try {
    parsed = parseJsonModelResponse(payload?.choices?.[0]?.message?.content);
  } catch (parseError) {
    const fallback = await callReasoningJson(prompt, 16000, 'low');
    parsed = fallback.value;
    rubricModelUsed = fallback.model || rubricModelUsed;
    payload = { model: fallback.model, usage: fallback.usage };
    console.log(JSON.stringify({ event: 'rubric_json_repaired', testId: testId, via: 'callReasoningJson', reason: parseError.message }));
  }
  return { parsed, model: payload?.model || rubricModelUsed, payload };
}
