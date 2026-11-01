// Marketing tracking (GA4 + Meta Pixel) for the public site only.
// Only activates if VITE_GA_MEASUREMENT_ID / VITE_META_PIXEL_ID are set — local dev without them is a no-op.
// Logged-in, school, parent and token pages never send anything: tracking is paused there.

const GA_ID = import.meta.env.VITE_GA_MEASUREMENT_ID;
const PIXEL_ID = import.meta.env.VITE_META_PIXEL_ID;

const PUBLIC_PATHS = new Set([
  '/',
  '/demo',
  '/partner',
  '/labs',
  '/learner-dna',
  '/privacy',
  '/terms-of-service',
  '/dpdp-compliance',
  '/grievance-officer',
]);
const PUBLIC_PREFIXES = ['/demo/report/'];
// Only campaign tags reach GA4; any other query parameter is dropped.
const CAMPAIGN_PARAM = /^(utm_[a-z]+|gclid|fbclid)$/;

// GA4 event name → Meta standard event.
const META_EVENTS = {
  demo_view: 'ViewContent',
  whatsapp_click: 'Contact',
  email_click: 'Contact',
  trial_request: 'Lead',
};

let loaded = false;
let active = false;
let lastPath = null;

export function isPublicPath(pathname) {
  const path = pathname.length > 1 ? pathname.replace(/\/+$/, '') : pathname;
  return PUBLIC_PATHS.has(path) || PUBLIC_PREFIXES.some((prefix) => path.startsWith(prefix));
}

function pageLocation() {
  const url = new URL(window.location.href);
  for (const key of [...url.searchParams.keys()]) {
    if (!CAMPAIGN_PARAM.test(key)) url.searchParams.delete(key);
  }
  url.hash = '';
  return url.toString();
}

function loadScript(src) {
  const script = document.createElement('script');
  script.async = true;
  script.src = src;
  document.head.appendChild(script);
}

function loadTags() {
  if (GA_ID) {
    window.dataLayer = window.dataLayer || [];
    window.gtag = function gtag() { window.dataLayer.push(arguments); };
    window.gtag('js', new Date());
    // Page views are sent by hand on public pages only (see trackPageView).
    window.gtag('config', GA_ID, { send_page_view: false });
    loadScript(`https://www.googletagmanager.com/gtag/js?id=${GA_ID}`);
  }
  if (PIXEL_ID) {
    const fbq = function fbq() {
      fbq.callMethod ? fbq.callMethod.apply(fbq, arguments) : fbq.queue.push(arguments);
    };
    Object.assign(fbq, { push: fbq, loaded: true, version: '2.0', queue: [], disablePushState: true });
    window.fbq = fbq;
    window._fbq = window._fbq || fbq;
    // No automatic button-text or page-metadata collection.
    fbq('set', 'autoConfig', false, PIXEL_ID);
    fbq('init', PIXEL_ID);
    loadScript('https://connect.facebook.net/en_US/fbevents.js');
  }
  loaded = true;
}

function setActive(next) {
  if (next === active) return;
  active = next;
  if (GA_ID) window[`ga-disable-${GA_ID}`] = !next;
  if (PIXEL_ID && window.fbq) window.fbq('consent', next ? 'grant' : 'revoke');
}

// Called on every route change.
export function trackPageView(pathname) {
  if ((!GA_ID && !PIXEL_ID) || pathname === lastPath) return;
  lastPath = pathname;
  const isPublic = isPublicPath(pathname);
  if (!isPublic) {
    setActive(false);
    return;
  }
  if (!loaded) loadTags();
  setActive(true);
  if (GA_ID) {
    // Set once per page so every later event on it (demo_view, clicks, trial_request)
    // carries the trimmed address too, not gtag's default of the full URL.
    window.gtag('set', { page_location: pageLocation(), page_title: document.title });
    window.gtag('event', 'page_view');
  }
  if (PIXEL_ID) window.fbq('track', 'PageView');
  if (pathname.startsWith('/demo')) trackSiteEvent('demo_view');
}

export function trackSiteEvent(name, params = {}) {
  if (!active) return;
  if (GA_ID) window.gtag('event', name, params);
  if (PIXEL_ID && META_EVENTS[name]) window.fbq('track', META_EVENTS[name], { content_name: name });
}

// WhatsApp and email links anywhere on a public page.
export function trackLinkClick(event) {
  const link = event.target instanceof Element ? event.target.closest('a[href]') : null;
  if (!link) return;
  const href = link.getAttribute('href');
  if (href.startsWith('https://wa.me/')) trackSiteEvent('whatsapp_click');
  else if (href.startsWith('mailto:')) trackSiteEvent('email_click');
}
