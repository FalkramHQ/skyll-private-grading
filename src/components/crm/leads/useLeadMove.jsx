import { useCallback, useState } from 'react';
import { crmFetch, newIdempotencyKey } from '../../../lib/crm/api';
import { LostDialog } from './leadUi';

/**
 * Moves a lead between stages. A move to a lost stage first asks for the
 * reason. `onMoved(updatedLead)` runs after the server accepts the move.
 */
export function useLeadMove(onMoved) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState(null);
  const [pending, setPending] = useState(null);

  const send = async (lead, stage, extra = {}) => {
    setBusy(true);
    setError(null);
    try {
      const updated = await crmFetch('leads/stage', {
        method: 'POST',
        body: { leadId: lead.id, toStageId: stage.id, expectedVersion: lead.version, ...extra },
        idempotencyKey: newIdempotencyKey(),
      });
      setPending(null);
      onMoved(updated);
      return true;
    } catch (err) {
      setError(err);
      return false;
    } finally {
      setBusy(false);
    }
  };

  /** Resolves true/false once sent; a lost move resolves null and opens the dialog. */
  const move = (lead, stage) => {
    setError(null);
    if (stage.category === 'lost') {
      setPending({ lead, stage });
      return Promise.resolve(null);
    }
    return send(lead, stage);
  };

  const dialog = pending && (
    <LostDialog
      lead={pending.lead}
      stage={pending.stage}
      busy={busy}
      error={error}
      onCancel={() => { setPending(null); setError(null); }}
      onConfirm={(extra) => send(pending.lead, pending.stage, extra)}
    />
  );

  // Errors from the lost dialog are shown inside it.
  const clearError = useCallback(() => setError(null), []);
  return { move, busy, error: pending ? null : error, clearError, dialog };
}
