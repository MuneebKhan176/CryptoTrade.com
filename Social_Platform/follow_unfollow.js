const express = require('express');
const router = express.Router();
const path = require('path');

const verifyToken = require('../middle/middleware');
const { SocialProfile, Follow } = require('./social_models');

function sendResponse(res, statusCode, success, message, data = null) {
    return res.status(statusCode).json({ success, message, data });
}

const TOP_CREATORS_LIMIT = 10;

/* ============================================================================
 * QUICKSELECT — top-K largest elements by followersCount
 * ----------------------------------------------------------------------------
 * Classic divide & conquer selection algorithm (average O(n), worst case
 * O(n^2) mitigated with a random pivot). We use it instead of a full sort
 * (O(n log n)) because we only ever need the top K=10 profiles out of
 * potentially many — quickselect partitions the array around a pivot so
 * that after each pass, everything greater than the pivot is on its left,
 * narrowing the search window each time until the first K elements are
 * guaranteed to be the K largest by followersCount (order within that
 * K-slice is arbitrary, so we do one cheap sort of just those 10 at the end
 * purely for display order).
 * ==========================================================================*/

function swap(arr, i, j) {
    const tmp = arr[i];
    arr[i] = arr[j];
    arr[j] = tmp;
}

// Lomuto-style partition, largest-first: after this call, everything with
// followersCount > pivotValue sits to the left of the returned index.
function partition(arr, low, high, pivotIndex) {
    const pivotValue = arr[pivotIndex].followersCount;
    swap(arr, pivotIndex, high);
    let storeIndex = low;

    for (let i = low; i < high; i++) {
        if (arr[i].followersCount > pivotValue) {
            swap(arr, i, storeIndex);
            storeIndex++;
        }
    }
    swap(arr, storeIndex, high);
    return storeIndex;
}

// Rearranges `items` in place (on a copy) so the first `k` entries are the
// k largest by followersCount, then returns that slice sorted descending.
function quickSelectTopK(items, k) {
    if (items.length <= k) {
        return items.slice().sort((a, b) => b.followersCount - a.followersCount);
    }

    const arr = items.slice(); // work on a copy — don't mutate the caller's array
    let low = 0;
    let high = arr.length - 1;

    while (low < high) {
        // Random pivot avoids the O(n^2) worst case on already-sorted input.
        const randomIndex = low + Math.floor(Math.random() * (high - low + 1));
        const finalIndex = partition(arr, low, high, randomIndex);

        if (finalIndex === k - 1) {
            break; // first k elements are now exactly the k largest
        } else if (finalIndex < k - 1) {
            low = finalIndex + 1; // need more elements from the right side
        } else {
            high = finalIndex - 1; // too many — narrow to the left side
        }
    }

    const topK = arr.slice(0, k);
    topK.sort((a, b) => b.followersCount - a.followersCount); // presentation order only
    return topK;
}

// ================= TOP CREATORS PAGE =================
// Serves the standalone top-creators.html page (Frontend/top-creators.html).
router.get('/top-creators', verifyToken, (req, res) => {
    res.sendFile(path.join(__dirname, '../Frontend/top-creators.html'));
});

// ================= GET TOP 10 CREATORS (by followersCount, via Quickselect) =================
router.get('/api/top-creators', verifyToken, async (req, res) => {

    try {
        const myUsername = req.user.username;

        const allProfiles = await SocialProfile.find(
            {},
            'userId username displayName avatarUrl bio followersCount followingCount postsCount'
        ).lean();

        const top10 = quickSelectTopK(allProfiles, TOP_CREATORS_LIMIT);

        // Figure out which of these the current user already follows,
        // in a single query rather than one lookup per creator.
        const myFollows = await Follow.find({ followerUsername: myUsername })
            .select('followingUsername')
            .lean();
        const followingSet = new Set(myFollows.map(f => f.followingUsername));

        const creators = top10.map((p, index) => ({
            rank: index + 1,
            userId: p.userId,
            username: p.username,
            displayName: p.displayName || p.username,
            avatarUrl: p.avatarUrl || '',
            bio: p.bio || '',
            followersCount: p.followersCount || 0,
            followingCount: p.followingCount || 0,
            postsCount: p.postsCount || 0,
            isFollowing: followingSet.has(p.username),
            isSelf: p.username === myUsername,
        }));

        return sendResponse(res, 200, true, 'Top creators fetched successfully', { creators });

    } catch (err) {
        console.error('⚠️ GET /api/top-creators error:', err);
        return sendResponse(res, 500, false, 'Failed to load top creators');
    }
});

// ================= FOLLOW A USER =================
router.post('/api/follow', verifyToken, async (req, res) => {

    try {
        const myUsername = req.user.username;
        const targetUsername = req.body.username?.trim();

        if (!targetUsername)
            return sendResponse(res, 400, false, 'Target username is required');

        if (targetUsername === myUsername)
            return sendResponse(res, 400, false, 'You cannot follow yourself');

        const targetProfile = await SocialProfile.findOne({ username: targetUsername });
        if (!targetProfile)
            return sendResponse(res, 404, false, 'User to follow was not found');

        try {
            await Follow.create({ followerUsername: myUsername, followingUsername: targetUsername });
        } catch (dupErr) {
            // Unique compound index on (followerUsername, followingUsername)
            if (dupErr.code === 11000)
                return sendResponse(res, 409, false, 'You are already following this user');
            throw dupErr;
        }

        const [updatedTarget] = await Promise.all([
            SocialProfile.findOneAndUpdate(
                { username: targetUsername },
                { $inc: { followersCount: 1 } },
                { new: true }
            ),
            SocialProfile.findOneAndUpdate(
                { username: myUsername },
                { $inc: { followingCount: 1 } }
            ),
        ]);

        return sendResponse(res, 200, true, `You are now following ${targetUsername}`, {
            followersCount: updatedTarget?.followersCount ?? 0,
        });

    } catch (err) {
        console.error('⚠️ POST /api/follow error:', err);
        return sendResponse(res, 500, false, 'Failed to follow user');
    }
});

// ================= UNFOLLOW A USER =================
router.post('/api/unfollow', verifyToken, async (req, res) => {

    try {
        const myUsername = req.user.username;
        const targetUsername = req.body.username?.trim();

        if (!targetUsername)
            return sendResponse(res, 400, false, 'Target username is required');

        const deleted = await Follow.findOneAndDelete({
            followerUsername: myUsername,
            followingUsername: targetUsername,
        });

        if (!deleted)
            return sendResponse(res, 404, false, 'You are not following this user');

        const [updatedTarget] = await Promise.all([
            SocialProfile.findOneAndUpdate(
                { username: targetUsername, followersCount: { $gt: 0 } },
                { $inc: { followersCount: -1 } },
                { returnDocument: 'after' }
            ),
            SocialProfile.findOneAndUpdate(
                { username: myUsername, followingCount: { $gt: 0 } },
                { $inc: { followingCount: -1 } }
            ),
        ]);

        return sendResponse(res, 200, true, `You unfollowed ${targetUsername}`, {
            followersCount: updatedTarget?.followersCount ?? 0,
        });

    } catch (err) {
        console.error('⚠️ POST /api/unfollow error:', err);
        return sendResponse(res, 500, false, 'Failed to unfollow user');
    }
});

module.exports = router;