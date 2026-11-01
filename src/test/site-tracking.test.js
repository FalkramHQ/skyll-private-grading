import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

async function loadTracking() {
  vi.resetModules();
  vi.stubEnv('VITE_GA_MEASUREMENT_ID', 'G-TEST123');
  vi.stubEnv('VITE_META_PIXEL_ID', '1234567890');
  return import('../lib/siteTracking');
}

function gaEvents() {
  return window.dataLayer.filter((args) => args[0] === 'event').map((args) => args[1]);
}

describe('site tracking', () => {
  beforeEach(() => {
    delete window.dataLayer;
    delete window.gtag;
    delete window.fbq;
    delete window._fbq;
    delete window['ga-disable-G-TEST123'];
    document.head.innerHTML = '';
  });

  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it('treats only marketing pages as public', async () => {
    const { isPublicPath } = await loadTracking();
    expect(isPublicPath('/')).toBe(true);
    expect(isPublicPath('/partner/')).toBe(true);
    expect(isPublicPath('/demo/report/aarav9tu')).toBe(true);
    for (const path of ['/account-deletion', '/dashboard', '/r/abc123', '/f/abc123', '/crm/leads', '/inquire/some-school', '/some-school', '/admin']) {
      expect(isPublicPath(path)).toBe(false);
    }
  });

  it('loads nothing on private pages', async () => {
    const { trackPageView } = await loadTracking();
    trackPageView('/dashboard');
    expect(window.gtag).toBeUndefined();
    expect(window.fbq).toBeUndefined();
    expect(document.head.querySelectorAll('script')).toHaveLength(0);
  });

  it('loads GA4 and the pixel on a public page and sends a page view', async () => {
    const { trackPageView } = await loadTracking();
    trackPageView('/');
    const sources = [...document.head.querySelectorAll('script')].map((script) => script.src);
    expect(sources).toEqual([
      'https://www.googletagmanager.com/gtag/js?id=G-TEST123',
      'https://connect.facebook.net/en_US/fbevents.js',
    ]);
    expect(gaEvents()).toEqual(['page_view']);
    expect(window.fbq.queue.map((args) => [...args])).toContainEqual(['track', 'PageView']);
    expect(window.fbq.disablePushState).toBe(true);
  });

  it('pauses on private pages and resumes on public ones', async () => {
    const { trackPageView, trackSiteEvent } = await loadTracking();
    trackPageView('/demo');
    trackPageView('/dashboard');
    expect(window['ga-disable-G-TEST123']).toBe(true);
    expect(window.fbq.queue.map((args) => [...args])).toContainEqual(['consent', 'revoke']);
    trackSiteEvent('whatsapp_click');
    expect(gaEvents()).toEqual(['page_view', 'demo_view']);
    trackPageView('/partner');
    expect(window['ga-disable-G-TEST123']).toBe(false);
    expect(gaEvents()).toEqual(['page_view', 'demo_view', 'page_view']);
  });

  it('sends only campaign query parameters to GA4, for every event on the page', async () => {
    window.history.replaceState({}, '', '/demo?utm_source=meta&utm_campaign=warmup&email=a%40b.com&fbclid=x1#top');
    const { trackPageView, trackSiteEvent } = await loadTracking();
    trackPageView('/demo');
    trackSiteEvent('whatsapp_click');
    const sets = window.dataLayer.filter((args) => args[0] === 'set').map((args) => args[1]);
    expect(sets).toEqual([{ page_location: `${window.location.origin}/demo?utm_source=meta&utm_campaign=warmup&fbclid=x1`, page_title: document.title }]);
    // The trimmed address is set before the first event, so no event falls back to the full URL.
    const firstSet = window.dataLayer.findIndex((args) => args[0] === 'set');
    const firstEvent = window.dataLayer.findIndex((args) => args[0] === 'event');
    expect(firstSet).toBeLessThan(firstEvent);
    expect(gaEvents()).toEqual(['page_view', 'demo_view', 'whatsapp_click']);
    window.history.replaceState({}, '', '/');
  });

  it('maps WhatsApp and email clicks to conversion events', async () => {
    const { trackPageView, trackLinkClick } = await loadTracking();
    trackPageView('/');
    document.body.innerHTML = '<a href="https://wa.me/919999999999"><span id="wa">Chat</span></a><a id="mail" href="mailto:office@skyllai.com">Mail</a>';
    trackLinkClick({ target: document.getElementById('wa') });
    trackLinkClick({ target: document.getElementById('mail') });
    expect(gaEvents()).toEqual(['page_view', 'whatsapp_click', 'email_click']);
    const metaTracks = window.fbq.queue.map((args) => [...args]).filter((args) => args[0] === 'track');
    expect(metaTracks.map((args) => args[1])).toEqual(['PageView', 'Contact', 'Contact']);
  });
});
