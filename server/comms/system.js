// The actor for changes Skyll makes on its own (webhooks, the worker), so they
// can be audited like staff changes.
export function systemScope(schoolId) {
  return { schoolId, actor: { user_id: null, role: 'system' }, capabilities: new Set(), grants: new Set(), support: false };
}
