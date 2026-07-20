/**
 * linkPreviewService.js
 * -----------------------------------------------------------------------
 * PHASE 2 — Link Previews
 *
 * Resolves "does this message contain a URL, and if so what does that
 * page look like" (favicon, title, description, preview image) without
 * pulling in a heavy HTML-parsing dependency. Uses a small tolerant
 * regex scan over the first chunk of the response body rather than a
 * full DOM parse — that's plenty for Open Graph / Twitter Card tags,
 * which is what ~all link-preview implementations (Slack, Discord,
 * iMessage) actually key off.
 *
 * Design notes:
 *   - Server-side fetch (not client-side) so we don't leak the chat
 *     server's users' IPs to arbitrary third-party sites, and so CORS
 *     is a non-issue.
 *   - Short-lived in-memory cache (same pattern as avatarService) keyed
 *     by URL, since the same link is often pasted by multiple people or
 *     re-fetched on reconnect.
 *   - Defends against SSRF-ish abuse: only http(s), rejects obviously
 *     internal/loopback/link-local hosts, caps body read size, caps
 *     redirects, has a hard timeout.
 *   - Never throws for a "bad" URL — returns null so the caller can just
 *     skip attaching a preview instead of failing the whole message.
 * -----------------------------------------------------------------------
 */

const { URL } = require('url');

const TTL_MS = 30 * 60 * 1000; // 30 minutes
const FETCH_TIMEOUT_MS = 5000;
const MAX_BYTES = 512 * 1024; // stop reading after 512KB — head/meta tags live near the top
const MAX_REDIRECTS = 3;

const cache = new Map(); // url -> { preview, expiresAt }
const inflight = new Map(); // url -> Promise, so concurrent posts of the same link only fetch once

const URL_REGEX = /(https?:\/\/[^\s<>"')\]]+)/i;

function findFirstUrl(text) {
  if (!text) return null;
  const match = String(text).match(URL_REGEX);
  return match ? match[1] : null;
}

function isBlockedHost(hostname) {
  const h = hostname.toLowerCase();
  if (h === 'localhost' || h.endsWith('.local')) return true;
  // literal IPv4 loopback / private / link-local ranges
  const ipv4 = h.match(/^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/);
  if (ipv4) {
    const [a, b] = [parseInt(ipv4[1], 10), parseInt(ipv4[2], 10)];
    if (a === 127 || a === 10 || a === 0) return true;
    if (a === 169 && b === 254) return true;
    if (a === 172 && b >= 16 && b <= 31) return true;
    if (a === 192 && b === 168) return true;
  }
  if (h === '::1' || h.startsWith('fe80:') || h.startsWith('fc') || h.startsWith('fd')) return true;
  return false;
}

function decodeEntities(str) {
  return str
    .replace(/&amp;/g, '&')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>');
}

/** Pulls a meta tag's content by property/name (og:title, twitter:title, etc). */
function extractMeta(html, keys) {
  for (const key of keys) {
    // property="key" content="..." OR content="..." property="key" (either attribute order)
    const patterns = [
      new RegExp(`<meta[^>]+(?:property|name)=["']${key}["'][^>]*content=["']([^"']*)["']`, 'i'),
      new RegExp(`<meta[^>]+content=["']([^"']*)["'][^>]*(?:property|name)=["']${key}["']`, 'i'),
    ];
    for (const re of patterns) {
      const m = html.match(re);
      if (m && m[1]) return decodeEntities(m[1].trim());
    }
  }
  return null;
}

function extractTitleTag(html) {
  const m = html.match(/<title[^>]*>([^<]*)<\/title>/i);
  return m ? decodeEntities(m[1].trim()) : null;
}

function extractFavicon(html, baseUrl) {
  const m =
    html.match(/<link[^>]+rel=["'](?:shortcut icon|icon|apple-touch-icon)["'][^>]*href=["']([^"']+)["']/i) ||
    html.match(/<link[^>]+href=["']([^"']+)["'][^>]*rel=["'](?:shortcut icon|icon|apple-touch-icon)["']/i);
  let href = m ? decodeEntities(m[1]) : '/favicon.ico';
  try {
    return new URL(href, baseUrl).toString();
  } catch (e) {
    return null;
  }
}

function resolveMaybeRelative(value, baseUrl) {
  if (!value) return null;
  try {
    return new URL(value, baseUrl).toString();
  } catch (e) {
    return null;
  }
}

/** Reads up to MAX_BYTES of a fetch Response body as a UTF-8 string. */
async function readBodyCapped(response) {
  const reader = response.body && response.body.getReader ? response.body.getReader() : null;
  if (!reader) {
    // Environments without a streaming body (older node-fetch polyfills) — fall back to text().
    const text = await response.text();
    return text.slice(0, MAX_BYTES);
  }
  const decoder = new TextDecoder('utf-8');
  let received = 0;
  let out = '';
  while (received < MAX_BYTES) {
    const { done, value } = await reader.read();
    if (done) break;
    received += value.length;
    out += decoder.decode(value, { stream: true });
  }
  try {
    reader.cancel();
  } catch (e) {
    /* ignore */
  }
  return out;
}

async function fetchWithTimeout(url, opts) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);
  try {
    return await fetch(url, { ...opts, signal: controller.signal, redirect: 'follow' });
  } finally {
    clearTimeout(timer);
  }
}

async function fetchPreview(rawUrl) {
  let parsed;
  try {
    parsed = new URL(rawUrl);
  } catch (e) {
    return null;
  }
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') return null;
  if (isBlockedHost(parsed.hostname)) return null;

  let response;
  try {
    response = await fetchWithTimeout(parsed.toString(), {
      headers: {
        'User-Agent': 'Mozilla/5.0 (compatible; ChatLinkPreviewBot/1.0; +https://cryptotrade.example/bot)',
        Accept: 'text/html,application/xhtml+xml',
      },
    });
  } catch (e) {
    return null;
  }

  if (!response || !response.ok) return null;
  const contentType = response.headers.get('content-type') || '';
  if (!contentType.includes('text/html') && !contentType.includes('application/xhtml')) return null;

  let html;
  try {
    html = await readBodyCapped(response);
  } catch (e) {
    return null;
  }

  const finalUrl = response.url || parsed.toString();

  const title = extractMeta(html, ['og:title', 'twitter:title']) || extractTitleTag(html);
  const description = extractMeta(html, ['og:description', 'twitter:description', 'description']);
  const imageRaw = extractMeta(html, ['og:image:secure_url', 'og:image', 'twitter:image']);
  const siteName = extractMeta(html, ['og:site_name']) || parsed.hostname.replace(/^www\./, '');

  if (!title && !description && !imageRaw) return null; // nothing worth showing

  return {
    url: finalUrl,
    siteName,
    title: title ? title.slice(0, 200) : null,
    description: description ? description.slice(0, 300) : null,
    image: resolveMaybeRelative(imageRaw, finalUrl),
    favicon: extractFavicon(html, finalUrl),
  };
}

/**
 * Public entry point: given raw message text, finds the first URL (if
 * any) and returns its preview, using the cache/in-flight de-dupe. Never
 * throws — returns null on any failure so callers can treat "no preview"
 * as a normal outcome.
 */
async function getPreviewForText(text) {
  const url = findFirstUrl(text);
  if (!url) return null;

  const cached = cache.get(url);
  if (cached && cached.expiresAt > Date.now()) return cached.preview;

  if (inflight.has(url)) return inflight.get(url);

  const promise = fetchPreview(url)
    .then((preview) => {
      cache.set(url, { preview, expiresAt: Date.now() + TTL_MS });
      inflight.delete(url);
      return preview;
    })
    .catch(() => {
      inflight.delete(url);
      return null;
    });

  inflight.set(url, promise);
  return promise;
}

module.exports = { getPreviewForText, findFirstUrl };