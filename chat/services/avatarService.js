/**
 * avatarService.js
 * -----------------------------------------------------------------------
 * Thin, short-lived cache in front of SocialProfile.avatarUrl so the chat
 * server doesn't hit MongoDB on every room join / message / typing event
 * just to know what a user's profile photo looks like. Avatars themselves
 * live in Cloudflare R2 (see uploadService.uploadAvatar) — this module
 * only resolves "userId -> current avatar URL" and caches that mapping.
 *
 * NOTE ON THE REQUIRE PATH BELOW: this assumes `chat/` and
 * `Social_Platform/` are sibling directories under the same backend root
 * (e.g. Backend/chat/services/avatarService.js and
 * Backend/Social_Platform/social_models.js). Adjust the relative path if
 * your project lays things out differently.
 * -----------------------------------------------------------------------
 */

const { SocialProfile } = require('../../Social_Platform/social_models');

const TTL_MS = 5 * 60 * 1000; // 5 minutes
const cache = new Map(); // userId -> { url, expiresAt }

async function getAvatarUrl(userId) {
  const cached = cache.get(userId);
  if (cached && cached.expiresAt > Date.now()) return cached.url;

  try {
    const profile = await SocialProfile.findOne({ userId }).select('avatarUrl').lean();
    const url = (profile && profile.avatarUrl) || null;
    cache.set(userId, { url, expiresAt: Date.now() + TTL_MS });
    return url;
  } catch (err) {
    console.error('[chat] avatarService lookup failed for user', userId, err);
    // Don't cache failures — retry on the next call instead of pinning
    // someone to a null avatar because of a transient DB blip.
    return cached ? cached.url : null;
  }
}

/** Call this right after a user updates their avatar so the next lookup
 *  (their next chat message / join) picks up the new photo immediately
 *  instead of waiting out the TTL. */
function invalidate(userId) {
  cache.delete(userId);
}

module.exports = { getAvatarUrl, invalidate };