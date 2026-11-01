export async function publicHealthProbe({ runDatabaseCheck, now = () => new Date().toISOString() }) {
  try {
    await runDatabaseCheck();
    return { status: 200, body: { ok: true, checkedAt: now() } };
  } catch {
    return { status: 503, body: { ok: false, checkedAt: now() } };
  }
}
