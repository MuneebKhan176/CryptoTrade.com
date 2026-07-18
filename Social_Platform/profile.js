const express = require('express');
const router = express.Router();
const path = require('path');
const mongoose = require('mongoose');

const verifyToken = require('../middle/middleware');
const { SocialProfile, Post } = require('./social_models');

// NOTE ON REQUIRE PATHS: these assume `Social_Platform/` and `chat/` are
// sibling directories under the same backend root. Adjust if your layout
// differs.
const { uploadAvatar } = require('../chat/services/uploadService');
const avatarService = require('../chat/services/avatarService');

// Max accepted size for the incoming base64 avatar data URL (~2MB decoded).
// Base64 inflates size by ~4/3, so we check the raw string length before
// ever decoding it.
const MAX_AVATAR_BYTES = 2 * 1024 * 1024;

function sendResponse(res, statusCode, success, message, data = null) {
    return res.status(statusCode).json({ success, message, data });
}

// ================= SOCIAL PROFILE PAGE =================
// Serves the standalone profile.html page (Frontend/profile.html).
router.get('/profile', verifyToken, (req, res) => {
    res.sendFile(path.join(__dirname, '../Frontend/Square_UI/profile.html'));
});

// ================= GET CURRENT USER'S PROFILE + POSTS =================
// Returns the SocialProfile doc plus that user's posts (newest first).
// If the user simply hasn't posted yet, `posts` comes back as an empty
// array — the frontend shows "No posts yet" in that case.
router.get('/api/profile', verifyToken, async (req, res) => {

    try {
        const userId = req.user.id;

        const profile = await SocialProfile.findOne({ userId });

        if (!profile)
            return sendResponse(res, 404, false, 'Social profile not found for this account');

        const posts = await Post.find({ username: profile.username, isDeleted: false })
            .sort({ createdAt: -1 })
            .limit(50)
            .lean();

        return sendResponse(res, 200, true, 'Profile fetched successfully', {
            profile,
            posts,
        });

    } catch (err) {
        console.error('⚠️ GET /api/profile error:', err);
        return sendResponse(res, 500, false, 'Failed to load profile');
    }
});

// ================= UPDATE PROFILE INFO (display name / bio) =================
router.put('/api/profile', verifyToken, async (req, res) => {

    try {
        const userId = req.user.id;

        const displayName = typeof req.body.displayName === 'string' ? req.body.displayName.trim() : undefined;
        const bio          = typeof req.body.bio === 'string' ? req.body.bio.trim() : undefined;

        if (displayName !== undefined && displayName.length > 60)
            return sendResponse(res, 400, false, 'Display name must be 60 characters or fewer');

        if (bio !== undefined && bio.length > 300)
            return sendResponse(res, 400, false, 'Bio must be 300 characters or fewer');

        const update = {};
        if (displayName !== undefined) update.displayName = displayName;
        if (bio !== undefined)          update.bio = bio;

        if (Object.keys(update).length === 0)
            return sendResponse(res, 400, false, 'No changes provided');

        const profile = await SocialProfile.findOneAndUpdate(
            { userId },
            { $set: update },
            { new: true }
        );

        if (!profile)
            return sendResponse(res, 404, false, 'Social profile not found for this account');

        return sendResponse(res, 200, true, 'Profile updated successfully', { profile });

    } catch (err) {
        console.error('⚠️ PUT /api/profile error:', err);
        return sendResponse(res, 500, false, 'Failed to update profile');
    }
});

// ================= UPDATE PROFILE PHOTO =================
// Expects { imageData: "data:image/png;base64,...." } — the frontend reads
// the picked file from the user's computer with FileReader and sends it
// as a base64 data URL.
//
// CHANGED: rather than storing that base64 string directly on
// SocialProfile.avatarUrl (which was slow to load — every profile fetch
// shipped the full image inline), we now decode it and push it to
// Cloudflare R2 via uploadAvatar(), and store only the resulting CDN URL.
//
// avatarVersion is incremented first so the R2 object key
// (`avatars/{userId}_v{version}.jpg`) is unique per upload — that lets us
// cache the image forever (immutable) on R2/the browser without ever
// risking a viewer seeing a stale photo after someone updates theirs.
router.post('/api/profile/avatar', verifyToken, async (req, res) => {

    try {
        const userId = req.user.id;
        const { imageData } = req.body;

        if (!imageData || typeof imageData !== 'string' || !imageData.startsWith('data:image/'))
            return sendResponse(res, 400, false, 'Invalid image data');

        // Rough decoded-size check (base64 is ~4/3 the size of the raw bytes)
        const approxBytes = (imageData.length * 3) / 4;
        if (approxBytes > MAX_AVATAR_BYTES)
            return sendResponse(res, 400, false, 'Image is too large. Max size is 2MB');

        const matches = imageData.match(/^data:(image\/[a-zA-Z0-9.+-]+);base64,(.+)$/);
        if (!matches)
            return sendResponse(res, 400, false, 'Invalid image data');

        const mimetype = matches[1];
        const buffer = Buffer.from(matches[2], 'base64');

        // Bump the version first so this upload always gets a fresh,
        // cache-busted key — even if two uploads race, each still lands
        // on its own unique object.
        const bumped = await SocialProfile.findOneAndUpdate(
            { userId },
            { $inc: { avatarVersion: 1 } },
            { new: true }
        );

        if (!bumped)
            return sendResponse(res, 404, false, 'Social profile not found for this account');

        const avatarUrl = await uploadAvatar(buffer, mimetype, userId, bumped.avatarVersion);

        const profile = await SocialProfile.findOneAndUpdate(
            { userId },
            { $set: { avatarUrl } },
            { new: true }
        );

        // So the next chat join/message picks up the new photo right away
        // instead of waiting out avatarService's TTL.
        avatarService.invalidate(userId);

        return sendResponse(res, 200, true, 'Profile photo updated successfully', {
            avatarUrl: profile.avatarUrl,
        });

    } catch (err) {
        if (err.code === 'UNSUPPORTED_TYPE' || err.code === 'TOO_LARGE') {
            return sendResponse(res, 400, false, err.message);
        }
        console.error('⚠️ POST /api/profile/avatar error:', err);
        return sendResponse(res, 500, false, 'Failed to update profile photo');
    }
});

// ================= DELETE OWN POST =================
// Soft-deletes a post (isDeleted = true) so it disappears from feeds/profile
// but stays in the DB for auditing, same convention already used elsewhere
// in Post. Only the post's own author (matched via their SocialProfile
// username, not just userId) can delete it. Also keeps SocialProfile.postsCount
// in sync so the "Posts" stat on the profile page stays accurate without a
// full reload.
router.delete('/api/posts/:id', verifyToken, async (req, res) => {

    try {
        const userId = req.user.id;
        const { id } = req.params;

        if (!mongoose.Types.ObjectId.isValid(id))
            return sendResponse(res, 400, false, 'Invalid post id');

        const profile = await SocialProfile.findOne({ userId });

        if (!profile)
            return sendResponse(res, 404, false, 'Social profile not found for this account');

        const post = await Post.findById(id);

        if (!post || post.isDeleted)
            return sendResponse(res, 404, false, 'Post not found');

        if (post.username !== profile.username)
            return sendResponse(res, 403, false, 'You can only delete your own posts');

        post.isDeleted = true;
        await post.save();

        await SocialProfile.updateOne(
            { userId },
            { $inc: { postsCount: -1 } }
        );

        return sendResponse(res, 200, true, 'Post deleted successfully', { postId: post._id });

    } catch (err) {
        console.error('⚠️ DELETE /api/posts/:id error:', err);
        return sendResponse(res, 500, false, 'Failed to delete post');
    }
});

module.exports = router;