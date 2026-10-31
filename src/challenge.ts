// Recognizes a bot-detection challenge or block page. Shared by the
// controller and tests/fingerprint-compare.mjs, whose live runs tuned it.
// Status codes follow docs/bot-detection.md: AWS WAF challenges with 202 and
// 405, Kasada with 429, Fastly with 406.
const CHALLENGE_STATUS = new Set([202, 403, 405, 406, 429]);
const CHALLENGE_BODY = /captcha-delivery|just a moment|cf-chl-|px-captcha|window\.gokuProps|challenge-container|Incapsula incident ID|the requested url was rejected|Radware Captcha Page|botdetect\.min\.js|sucuri website firewall/i;
const CHALLENGE_TITLE = /^just a moment|access denied|error page|attention required|pardon our interruption|are you a human|verify you are human/i;
const CHALLENGE_PATH_SEGMENT = /captcha|challenge/i;
const CHALLENGE_HOST = /(^|\.)(perfdrive\.com|queue-it\.net|captcha-delivery\.com)$/i;

// Bot-detection vendors' session cookies, each bound to the browser that
// earned it.
export const BOT_COOKIE = /^(?:_abck|bm_sz|ak_bmsc|bm_sv|bm_lso|datadome|__cf_bm|cf_clearance|_px.*|pxcts|aws-waf-token|incap_ses.*|visid_incap.*|reese84|___utmvc|KP_UIDz(?:-ssn)?)$/;

export type PageState = {
  url: string;
  status: number | null;
  title: string;
  // The page's first 500 characters of visible text.
  body: string;
  html: boolean;
};

// `requestedUrl` is what the visitor asked for; path segments it already
// contains, like a site's own /challenge page, are not markers.
export function challengeMarkers(page: PageState, requestedUrl: string): string[] {
  const markers: string[] = [];
  if (page.status !== null && CHALLENGE_STATUS.has(page.status)) markers.push(`status-${page.status}`);
  const requested = new Set(segments(new URL(requestedUrl)));
  const final = new URL(page.url);
  if (CHALLENGE_HOST.test(final.hostname) || segments(final).some((segment) => CHALLENGE_PATH_SEGMENT.test(segment) && !requested.has(segment))) {
    markers.push('challenge-url');
  }
  if (CHALLENGE_TITLE.test(page.title)) markers.push('challenge-title');
  if (CHALLENGE_BODY.test(page.body)) markers.push('challenge-body');
  if (page.html && page.status !== null && page.status < 400 && page.title.trim() === '' && page.body.trim().length < 100) markers.push('empty-page');
  return markers;
}

function segments(url: URL): string[] {
  return url.pathname.split('/').filter(Boolean).map((segment) => segment.toLowerCase());
}
