/**
 * Evidence Extraction Supervisor
 *
 * A rule-based controller that wraps the evidence pipeline:
 * - Pre-flight: validates OCR quality, chooses strategy
 * - Cohort monitoring: detects systemic failures early (after 3-5 students)
 * - Per-student adaptive control: decides retry/escalate/continue
 * - Post-run reporting: exam-level quality metrics
 *
 * NOT a model call — pure logic, instant decisions.
 */

import { classifyExam, chunkQuestions, selectReasoningEffort } from './evidencePipeline.js';

export class EvidenceSupervisor {
  constructor(questions, options = {}) {
    this.questions = questions;
    this.classification = classifyExam(questions);
    this.chunks = chunkQuestions(questions);
    this.cohortResults = [];
    this.questionBlockCounts = new Map(); // question_number → blocked count
    this.totalStudentsProcessed = 0;
    this.halted = false;
    this.haltReason = null;
    this.options = {
      cohortSampleSize: options.cohortSampleSize || 3,
      minCoverageThreshold: options.minCoverageThreshold || 0.3,
      fastForwardThreshold: options.fastForwardThreshold || 0.65,
      perStudentRetryThreshold: options.perStudentRetryThreshold || 0.4,
      questionBlockAlertRatio: options.questionBlockAlertRatio || 0.8,
    };
  }

  /**
   * Pre-flight check before processing any students.
   * Returns: { action: 'proceed'|'halt', params?, reason? }
   */
  preflight(ocrStats) {
    if (ocrStats.avgCharsPerPage < 100) {
      return { action: 'halt', reason: 'ocr_garbage', detail: `Avg ${ocrStats.avgCharsPerPage} chars/page — OCR likely failed` };
    }
    if (ocrStats.nonEmptyPages === 0) {
      return { action: 'halt', reason: 'no_content', detail: 'All OCR pages are empty' };
    }
    return {
      action: 'proceed',
      params: {
        classification: this.classification,
        chunks: this.chunks.map((c) => ({
          label: c.label,
          questionCount: c.questions.length,
          reasoning: selectReasoningEffort(c),
        })),
      },
    };
  }

  /**
   * Called after each student's evidence extraction completes.
   * Returns: { action: 'continue'|'retry'|'fast_forward'|'pause', ... }
   */
  onStudentComplete(result) {
    this.totalStudentsProcessed += 1;
    const coverage = result.attempted / result.total;
    this.cohortResults.push(coverage);

    // Track per-question block rates
    for (const answer of (result.answers || [])) {
      if (!answer.attempted) {
        const key = answer.question_number;
        this.questionBlockCounts.set(key, (this.questionBlockCounts.get(key) || 0) + 1);
      }
    }

    // Cohort check on a rolling window once we have at least the sample size.
    // A sustained run of low-coverage students halts the cohort at ANY point,
    // not just at the exact sample-size boundary (FLKRM-160).
    if (this.cohortResults.length >= this.options.cohortSampleSize) {
      const window = this.cohortResults.slice(-this.options.cohortSampleSize);
      const avg = window.reduce((a, b) => a + b, 0) / window.length;
      if (avg < this.options.minCoverageThreshold) {
        this.halted = true;
        this.haltReason = `Rolling cohort coverage ${(avg * 100).toFixed(0)}% over last ${window.length} students — probable systemic OCR failure`;
        return { action: 'pause', reason: 'systemic_failure', avgCoverage: avg };
      }
      // Fast-forward once after the first full, healthy sample only.
      if (this.cohortResults.length === this.options.cohortSampleSize && avg > this.options.fastForwardThreshold) {
        return { action: 'fast_forward', avgCoverage: avg };
      }
    }

    // Per-student retry decision
    if (coverage < this.options.perStudentRetryThreshold && !this.isFastForwarding()) {
      return { action: 'retry', coverage, reasoning: 'medium' };
    }

    return { action: 'continue', coverage };
  }

  /**
   * Check if a specific question should be flagged for visual rescue.
   * Called after all students are processed.
   */
  getQuestionFlags() {
    const flags = [];
    for (const [qNum, blockCount] of this.questionBlockCounts) {
      const ratio = this.totalStudentsProcessed > 0 ? blockCount / this.totalStudentsProcessed : 0;
      if (ratio > this.options.questionBlockAlertRatio) {
        flags.push({ question_number: qNum, blockRatio: ratio, recommendation: 'visual_rescue' });
      }
    }
    return flags;
  }

  /**
   * Post-run summary report.
   */
  postRunReport() {
    const avgCoverage = this.cohortResults.length
      ? this.cohortResults.reduce((a, b) => a + b, 0) / this.cohortResults.length
      : 0;
    return {
      totalStudents: this.totalStudentsProcessed,
      avgCoverage: Math.round(avgCoverage * 100) / 100,
      classification: this.classification,
      halted: this.halted,
      haltReason: this.haltReason,
      questionFlags: this.getQuestionFlags(),
      cohortCurve: this.cohortResults.map((c) => Math.round(c * 100) / 100),
    };
  }

  isFastForwarding() {
    if (this.cohortResults.length < this.options.cohortSampleSize) return false;
    const avg = this.cohortResults.slice(0, this.options.cohortSampleSize).reduce((a, b) => a + b, 0) / this.options.cohortSampleSize;
    return avg > this.options.fastForwardThreshold;
  }
}
