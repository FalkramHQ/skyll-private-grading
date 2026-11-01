// Meta's Embedded Signup in the browser (CRM M2 phase 2 S1, D2). The Facebook
// SDK is loaded only when an admin presses Connect. The popup returns a short-
// lived code (sent to Skyll's server, which exchanges it) and, through a
// window message from facebook.com, the WhatsApp account and number chosen.

let sdk = null;

export function loadFacebookSdk({ appId, graphVersion }) {
  if (sdk) return sdk;
  sdk = new Promise((resolve, reject) => {
    if (window.FB) { window.FB.init({ appId, autoLogAppEvents: true, xfbml: false, version: graphVersion }); resolve(window.FB); return; }
    window.fbAsyncInit = () => {
      window.FB.init({ appId, autoLogAppEvents: true, xfbml: false, version: graphVersion });
      resolve(window.FB);
    };
    const script = document.createElement('script');
    script.src = 'https://connect.facebook.net/en_US/sdk.js';
    script.async = true;
    script.defer = true;
    script.crossOrigin = 'anonymous';
    script.onerror = () => { sdk = null; reject(new Error('Could not load Meta’s sign-in. Check your connection and try again.')); };
    document.body.appendChild(script);
  });
  return sdk;
}

function isFacebookOrigin(origin) {
  try { return /(^|\.)facebook\.com$/.test(new URL(origin).hostname); } catch { return false; }
}

/**
 * Opens the popup. `coexistence` asks Meta for the flow that keeps the number
 * on the WhatsApp Business app. Resolves `{ code, wabaId, phoneNumberId,
 * businessId, coexistence }`; rejects with `cancelled: true` if the admin
 * closes it.
 */
export async function launchEmbeddedSignup({ appId, configId, graphVersion, solutionId }, { coexistence = true } = {}) {
  const FB = await loadFacebookSdk({ appId, graphVersion });
  return new Promise((resolve, reject) => {
    let session = null;
    const onMessage = (event) => {
      if (!isFacebookOrigin(event.origin)) return;
      let data;
      try { data = typeof event.data === 'string' ? JSON.parse(event.data) : event.data; } catch { return; }
      if (data?.type !== 'WA_EMBEDDED_SIGNUP') return;
      if (data.event === 'FINISH' || data.event === 'FINISH_ONLY_WABA' || data.event === 'FINISH_WHATSAPP_BUSINESS_APP_ONBOARDING') {
        session = {
          wabaId: String(data.data?.waba_id || ''),
          phoneNumberId: String(data.data?.phone_number_id || ''),
          businessId: data.data?.business_id ? String(data.data.business_id) : undefined,
          coexistence: data.event === 'FINISH_WHATSAPP_BUSINESS_APP_ONBOARDING',
        };
      } else if (data.event === 'CANCEL') {
        session = { cancelled: true, step: data.data?.current_step || null };
      } else if (data.event === 'ERROR') {
        session = { error: data.data?.error_message || 'Meta reported an error' };
      }
    };
    window.addEventListener('message', onMessage);
    FB.login((response) => {
      // Meta posts the session message just before the login callback.
      setTimeout(() => {
        window.removeEventListener('message', onMessage);
        const code = response?.authResponse?.code;
        if (session?.error) return reject(new Error(session.error));
        if (!code || !session?.phoneNumberId || session.cancelled) return reject(Object.assign(new Error('Connecting was cancelled before it finished.'), { cancelled: true }));
        resolve({ code, ...session });
      }, 300);
    }, {
      config_id: configId,
      response_type: 'code',
      override_default_response_type: true,
      extras: {
        setup: solutionId ? { solutionID: solutionId } : {},
        ...(coexistence ? { featureType: 'whatsapp_business_app_onboarding' } : {}),
        sessionInfoVersion: '3',
      },
    });
  });
}
