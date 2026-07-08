const express = require('express');
const router = express.Router();
const path = require('path');

const verifyToken = require('../middle/middleware');
const { SocialProfile, Post } = require('./social_models');

// Max accepted size for a base64 avatar data URL (~2MB decoded).
// Base64 inflates size by ~4/3, so we check the raw string length.
const MAX_AVATAR_BYTES = 2 * 1024 * 1024;

function sendResponse(res, statusCode, success, message, data = null) {
    return res.status(statusCode).json({ success, message, data });
}

// ================= SOCIAL PROFILE PAGE =================
// Serves the standalone profile.html page (Frontend/profile.html).
router.get('/profile', verifyToken, (req, res) => {
    res.sendFile(path.join(__dirname, '../Frontend/profile.html'));
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
// as a base64 data URL. We store it directly on SocialProfile.avatarUrl
// (a plain String field), so no extra file storage / multer setup is
// required. Good enough for demo-scale profile photos; swap for real
// object storage (S3, etc.) if avatars need to scale up later.
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

        const profile = await SocialProfile.findOneAndUpdate(
            { userId },
            { $set: { avatarUrl: imageData } },
            { new: true }
        );

        if (!profile)
            return sendResponse(res, 404, false, 'Social profile not found for this account');

        return sendResponse(res, 200, true, 'Profile photo updated successfully', {
            avatarUrl: profile.avatarUrl,
        });

    } catch (err) {
        console.error('⚠️ POST /api/profile/avatar error:', err);
        return sendResponse(res, 500, false, 'Failed to update profile photo');
    }
});

module.exports = router;