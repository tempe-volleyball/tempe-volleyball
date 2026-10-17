import type { AnalyticsSettings, TagLoading } from '../content/settings'

// The analytics tags on public pages (docs/admin.md §2, "Tags on the public site"). Only production on
// www.tempevb.com gets them (the caller passes isIndexable()), so staging, previews and local dev never send hits.

export type AnalyticsTags = {
  ga4: { id: string; loading: TagLoading } | null
  cfBeaconToken: string | null
  searchConsoleVerification: string | null
}

export function analyticsTags(settings: AnalyticsSettings, indexable: boolean): AnalyticsTags {
  if (!indexable) return { ga4: null, cfBeaconToken: null, searchConsoleVerification: null }
  return {
    ga4: settings.ga4MeasurementId ? { id: settings.ga4MeasurementId, loading: settings.tagLoading } : null,
    cfBeaconToken: settings.cfBeaconToken || null,
    searchConsoleVerification: settings.searchConsoleVerification || null,
  }
}

/** How long 'interaction' mode waits for an interaction before loading anyway (so short visits still count). */
export const INTERACTION_FALLBACK_MS = 15_000

/**
 * The inline script for GA4 (under 1 KB). It queues the consent defaults, `js` and `config` in dataLayer at once
 * (so the page_view keeps its real timestamp and page), then injects gtag.js:
 *  - 'interaction': on the first pointer, key, scroll or touch, when the tab is hidden, or after 15 s
 *  - 'idle': after the load event, when the browser is idle (at most 3 s later)
 *  - 'eager': straight away (async), as Google's own snippet does
 * Consent mode: ads storage is always denied (the site has no ads); analytics storage is granted unless the
 * browser sends Global Privacy Control, in which case GA4 gets cookieless pings.
 */
export function ga4LoaderScript(id: string, loading: TagLoading): string {
  return [
    `(function(w,d,id,mode){w.dataLayer=w.dataLayer||[];function g(){w.dataLayer.push(arguments)}w.gtag=g;`,
    `g('consent','default',{ad_storage:'denied',ad_user_data:'denied',ad_personalization:'denied',analytics_storage:navigator.globalPrivacyControl===true?'denied':'granted'});`,
    `g('js',new Date());g('config',id);var done=0,ev=['pointerdown','keydown','scroll','touchstart'],o={passive:true,capture:true};`,
    `function load(){if(done)return;done=1;ev.forEach(function(e){w.removeEventListener(e,load,o)});`,
    `var s=d.createElement('script');s.async=true;s.src='https://www.googletagmanager.com/gtag/js?id='+encodeURIComponent(id);d.head.appendChild(s)}`,
    `if(mode==='eager')return load();`,
    `if(mode==='idle')return w.addEventListener('load',function(){w.requestIdleCallback?w.requestIdleCallback(load,{timeout:3000}):setTimeout(load,1000)});`,
    `ev.forEach(function(e){w.addEventListener(e,load,o)});d.addEventListener('visibilitychange',function(){if(d.visibilityState==='hidden')load()});`,
    `setTimeout(load,${INTERACTION_FALLBACK_MS})})(window,document,${JSON.stringify(id)},${JSON.stringify(loading)});`,
  ].join('')
}

/** The data-cf-beacon attribute for Cloudflare's Web Analytics beacon (loaded with defer; cookieless, ~6 KB). */
export const cfBeaconAttr = (token: string) => JSON.stringify({ token, spa: false })

export const CF_BEACON_SRC = 'https://static.cloudflareinsights.com/beacon.min.js'
