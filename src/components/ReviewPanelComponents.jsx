import React, { useState } from 'react';
import { CheckCircle, AlertCircle, Save, Maximize2, Minimize2, ShieldCheck, Clock, PenLine } from 'lucide-react';
import Loader from '../components/Loader';
import { Button } from './ui/Button';
import { StatusBadge } from './ui/StatusBadge';
import { cn } from '../lib/utils';

const BANNER = 'mb-3 flex items-center gap-2 rounded-xl border px-3.5 py-2 text-[13px] font-semibold';

export function SaveStateBanner({ status = 'idle', hasOverrides = false, errorMessage = '' }) {
  if (status === 'error') {
    return (
      <div role="alert" className={cn(BANNER, 'border-destructive/30 bg-destructive-soft text-destructive-soft-foreground')}>
        <AlertCircle className="h-4 w-4 flex-shrink-0 text-destructive" aria-hidden="true" />
        <span>Save failed: {errorMessage || 'Network error occurred.'}</span>
      </div>
    );
  }

  if (status === 'saving') {
    return (
      <div role="status" className={cn(BANNER, 'border-hairline bg-info-soft text-info')}>
        <Loader size="inline" className="text-info" />
        <span>Saving decision to canonical student record...</span>
      </div>
    );
  }

  if (hasOverrides || status === 'unsaved') {
    return (
      <div className={cn(BANNER, 'justify-between border-warning/30 bg-warning-soft text-warning-soft-foreground')}>
        <div className="flex items-center gap-2">
          <Clock className="h-4 w-4 flex-shrink-0 text-warning" aria-hidden="true" />
          <span>Unsaved mark adjustments active - click save to apply changes</span>
        </div>
        <span className="rounded-full border border-warning/40 bg-card px-2 py-0.5 text-xs font-bold text-warning-soft-foreground">Pending</span>
      </div>
    );
  }

  if (status === 'saved') {
    return (
      <div role="status" className={cn(BANNER, 'border-success/25 bg-success-soft text-success-soft-foreground')}>
        <ShieldCheck className="h-4 w-4 flex-shrink-0 text-success" aria-hidden="true" />
        <span>All review decisions synchronized securely with student report</span>
      </div>
    );
  }

  return null;
}

export function ContextualApproveButton({ isApproved = false, hasOverride = false, isSaving = false, onApprove, onApproveAndNext, marks, maxMarks, disabled = false, showHint = true }) {
  let label = 'Approve Score';
  if (hasOverride) {
    label = 'Save Override';
  } else if (isApproved) {
    label = 'Re-Approve Score';
  }

  return (
    <div className="flex w-full flex-col gap-2">
      <div className="flex w-full flex-wrap items-stretch gap-2.5">
        <Button
          type="button"
          size="lg"
          onClick={onApprove}
          disabled={disabled || isSaving}
          className={cn(
            'min-w-[12rem] flex-1 rounded-xl text-[15px] font-bold',
            hasOverride && 'bg-warning-soft text-warning-soft-foreground hover:bg-warning-soft/80',
          )}
        >
          {isSaving ? (
            <>
              <Loader size="inline" />
              <span>Saving...</span>
            </>
          ) : (
            <>
              {hasOverride ? <PenLine className="h-4 w-4" aria-hidden="true" /> : <Save className="h-4 w-4" aria-hidden="true" />}
              <span className="tabular-nums">{label} ({marks ?? 0}/{maxMarks ?? 0})</span>
            </>
          )}
        </Button>

        {onApproveAndNext && (
          <Button
            type="button"
            size="lg"
            variant="outline"
            onClick={onApproveAndNext}
            disabled={disabled || isSaving}
            className="min-w-[10rem] flex-1 rounded-xl text-[15px] font-bold sm:flex-none"
          >
            <CheckCircle className="h-4 w-4" aria-hidden="true" />
            <span>Approve & Next</span>
          </Button>
        )}
      </div>
      {onApproveAndNext && showHint && (
        <p className="hidden text-center text-xs text-muted-foreground md:block">
          <kbd className="rounded-[5px] border border-hairline-strong bg-card px-1.5 py-px font-sans text-xs font-bold text-foreground">Shift+Enter</kbd>
          {' '}approves and moves on
        </p>
      )}
    </div>
  );
}

export function EvidenceFocusPanel({ imageUrl, cropUrl, studentName, questionNumber, onOpenFullSheet }) {
  const [showFull, setShowFull] = useState(false);

  const displayUrl = (!showFull && cropUrl) ? cropUrl : imageUrl;

  return (
    <div className="flex h-full flex-col overflow-hidden rounded-2xl border border-border bg-card">
      <div className="flex flex-wrap items-center justify-between gap-2 border-b border-border px-4 py-3">
        <span className="text-[13px] font-bold text-foreground">
          {(!showFull && cropUrl) ? 'Cropped Answer Evidence' : 'Full Student Answer Sheet'}
        </span>
        <div className="flex items-center gap-2">
          {cropUrl && imageUrl && (
            <Button
              type="button"
              size="sm"
              variant="secondary"
              onClick={() => setShowFull(!showFull)}
              aria-label="Toggle full sheet view"
              className="h-8"
            >
              {showFull ? <Minimize2 className="h-3.5 w-3.5" aria-hidden="true" /> : <Maximize2 className="h-3.5 w-3.5" aria-hidden="true" />}
              <span>{showFull ? 'Focus Answer' : 'View Full Page'}</span>
            </Button>
          )}
          {onOpenFullSheet && (
            <Button type="button" size="sm" variant="secondary" onClick={onOpenFullSheet} className="h-8">
              Open Sheet in Tab
            </Button>
          )}
        </div>
      </div>

      <div className="flex min-h-[350px] flex-1 items-center justify-center overflow-auto bg-sunken p-4">
        {displayUrl ? (
          <img
            src={displayUrl}
            alt={`Answer evidence for ${studentName || 'student'} question ${questionNumber || ''}`}
            className="max-h-[600px] max-w-full rounded-[4px] border border-hairline bg-card object-contain"
          />
        ) : (
          <div className="py-12 text-center text-[13px] text-muted-foreground">
            No cropped visual evidence available for this question.
          </div>
        )}
      </div>
    </div>
  );
}

export function RevisionSummaryBadge({ reviewRevision = 0, regradedRevision = 0, needsRegrade = false, isEdited = false }) {
  const isPendingRegrade = needsRegrade || (isEdited && reviewRevision > regradedRevision);

  if (isPendingRegrade) {
    return (
      <StatusBadge status="caution" icon={Clock}>
        <span className="tabular-nums">Edits pending regrade (Rev {reviewRevision || 1})</span>
      </StatusBadge>
    );
  }

  return (
    <StatusBadge status="positive">
      <span className="tabular-nums">Published in revision {regradedRevision || reviewRevision || 1}</span>
    </StatusBadge>
  );
}
