// The comms loop the OCI worker runs on every tick (D12, D16): send queued
// messages every few seconds, re-check blocked classes, and run the planners
// (fee reminders, receipts, absences, reports) and the nightly clean-up as
// later slices add them. Each part runs at most once per its interval, and a
// failure in one never stops the others or the grading worker.
import { dispatchOnce, probeBlocked } from './dispatcher.js';
import { hasSecretKey } from './secrets.js';

const planners = [];

/** `planner(db, { now })` queues automatic messages; it must be safe to repeat (dedup keys). */
export function registerPlanner(name, planner, { everyMs = 60_000 } = {}) {
  planners.push({ name, planner, everyMs });
}

export function createCommsRunner(db, {
  workerId,
  dispatchEveryMs = Number(process.env.COMMS_DISPATCH_INTERVAL_MS || 5_000),
  probeEveryMs = 60_000,
  log = (entry) => console.log(JSON.stringify(entry)),
  onError = (name, error) => console.warn(JSON.stringify({ event: 'comms_failed', part: name, error: String(error?.message || error) })),
  providerFactory,
  env = process.env,
} = {}) {
  const last = new Map();
  let disabledLogged = false;
  let ready = null;
  let readyCheckedAt = 0;

  async function outboxReady(now) {
    // Before migration 086 there is no outbox; check again every 10 minutes.
    if (ready || now - readyCheckedAt < 600_000) return ready;
    readyCheckedAt = now;
    const result = await db.execute("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'crm_comms_messages'");
    ready = result.rows.length > 0;
    return ready;
  }

  async function every(name, intervalMs, now, run) {
    if (now - (last.get(name) || 0) < intervalMs) return;
    last.set(name, now);
    try {
      const result = await run();
      if (result && (result.claimed || result.reclaimed || result.queued || typeof result === 'number' && result > 0)) log({ event: `comms_${name}`, ...(typeof result === 'object' ? result : { count: result }) });
    } catch (error) {
      onError(name, error);
    }
  }

  return async function commsTick(now = Date.now()) {
    // Without the key no stored token can be read, so sending would only fail.
    // A worker without it (say, before WhatsApp is configured there) leaves
    // WhatsApp alone, including planning, and another worker that has it does the work.
    if (!hasSecretKey(env)) {
      if (!disabledLogged) log({ event: 'comms_disabled', reason: 'WHATSAPP_TOKEN_KEY is not set' });
      disabledLogged = true;
      return;
    }
    if (!(await outboxReady(now).catch(() => false))) return;
    for (const { name, planner, everyMs } of planners) await every(`plan_${name}`, everyMs, now, () => planner(db, { now }));
    await every('dispatch', dispatchEveryMs, now, () => dispatchOnce(db, { workerId, now, providerFactory }));
    await every('probe', probeEveryMs, now, () => probeBlocked(db, { workerId, now, providerFactory }));
  };
}
