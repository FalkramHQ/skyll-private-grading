import { StatusBadge } from './ui/StatusBadge';

/**
 * Maps a numeric confidence score (0–1) to a semantic level.
 * @param {number|null|undefined} confidence
 * @returns {'high'|'medium'|'low'|'unknown'}
 */
export function getConfidenceLevel(confidence) {
  if (confidence == null || !Number.isFinite(Number(confidence))) return 'unknown';
  const value = Number(confidence);
  if (value >= 0.85) return 'high';
  if (value >= 0.6) return 'medium';
  return 'low';
}

// Status is carried by icon + words (StatusBadge); colour only confirms it.
const LEVEL_CONFIG = {
  high: { label: 'High confidence', status: 'positive' },
  medium: { label: 'Medium confidence — verify', status: 'caution' },
  low: { label: 'Low confidence — manual review advised', status: 'critical' },
  unknown: { label: 'Confidence unavailable', status: 'neutral' },
};

/**
 * Displays an AI grading confidence badge with a semantic color and tooltip-ready label.
 * Follows Julie Dirksen's "Learning Interface Design" principle: AI decisions must be
 * explainable so teachers can trust and verify them.
 *
 * @param {object} props
 * @param {number|null} props.confidence - Numeric confidence (0–1) from the grading model.
 * @param {boolean} [props.showOnlyWhenRisk=false] - When true, suppresses the badge for high-confidence grades (reduces noise on the review screen).
 */
export default function AiConfidenceBadge({ confidence, showOnlyWhenRisk = false }) {
  const level = getConfidenceLevel(confidence);

  if (showOnlyWhenRisk && level === 'high') return null;

  const config = LEVEL_CONFIG[level];
  const percentage = level !== 'unknown' && Number.isFinite(Number(confidence))
    ? `${Math.round(Number(confidence) * 100)}%`
    : null;

  return (
    <StatusBadge status={config.status} title={config.label} className="min-h-6 py-0.5">
      <span className="tabular-nums">{config.label}{percentage ? ` (${percentage})` : ''}</span>
    </StatusBadge>
  );
}
