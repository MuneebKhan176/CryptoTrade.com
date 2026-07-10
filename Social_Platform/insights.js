const express = require('express');
const router  = express.Router();
const path    = require('path');

const verifyToken = require('../middle/middleware');
const { SocialProfile, Post, Follow, Like } = require('./social_models');

/* ============================================================================
 *  Social_Platform/insights.js  —  "Crypto Square" backend
 * ----------------------------------------------------------------------------
 *  Powers Frontend/crypto-square.html:
 *    GET  /crypto-square                 -> serves the page (auth required)
 *    GET  /api/insights/discover         -> every post, newest first
 *    GET  /api/insights/following        -> posts only from people you follow
 *    POST /api/insights/posts/:id/like   -> toggle like on a post
 *
 *  Deliberately kept separate from Social_Platform/posts.js (which already
 *  owns post *creation*) so this file can grow independently — comments,
 *  reposts, trending, and recommendation logic can all be added here later
 *  without touching the composer/upload code in posts.js.
 *
 *  Reuses the existing SocialProfile / Post / Follow / Like models and the
 *  existing verifyToken auth middleware. Follow/unfollow itself is NOT
 *  duplicated here — the frontend calls the existing POST /api/follow and
 *  POST /api/unfollow endpoints already defined in Social_Platform/
 *  top-creators.js.
 * ==========================================================================*/

const PAGE_SIZE = 10;

function sendResponse(res, statusCode, success, message, data = null) {
    return res.status(statusCode).json({ success, message, data });
}

/* ============================================================================
 * CRYPTO SQUARE PAGE
 * ==========================================================================*/
router.get('/crypto-square', verifyToken, (req, res) => {
    res.sendFile(path.join(__dirname, '../Frontend/crypto-square.html'));
});

/* ============================================================================
 * HELPERS
 * ----------------------------------------------------------------------------
 * Batch-attaches author info + per-viewer flags (isSelf / isFollowing /
 * isLiked) to a list of plain post objects in a constant number of extra
 * queries, regardless of how many posts are on the page — same pattern used
 * in posts.js, kept self-contained here so this file has no dependency on
 * posts.js internals.
 * ==========================================================================*/
async function enrichSquarePosts(posts, myUsername) {
    if (!posts.length) return [];

    const usernames = [...new Set(posts.map(p => p.username))];
    const postIds    = posts.map(p => p._id);

    const [authors, myFollows, myLikes] = await Promise.all([
        SocialProfile.find({ username: { $in: usernames } }, 'username displayName avatarUrl').lean(),
        Follow.find({ followerUsername: myUsername }).select('followingUsername').lean(),
        Like.find({ username: myUsername, targetType: 'Post', targetId: { $in: postIds } }).select('targetId').lean(),
    ]);

    const authorMap    = new Map(authors.map(a => [a.username, a]));
    const followingSet = new Set(myFollows.map(f => f.followingUsername));
    const likedSet      = new Set(myLikes.map(l => String(l.targetId)));

    return posts.map(p => {
        const author = authorMap.get(p.username);
        return {
            ...p,
            author: {
                displayName: author?.displayName || p.username,
                avatarUrl: author?.avatarUrl || '',
            },
            isSelf: p.username === myUsername,
            isFollowing: followingSet.has(p.username),
            isLiked: likedSet.has(String(p._id)),
        };
    });
}

/* ============================================================================
 * DISCOVER FEED
 * ----------------------------------------------------------------------------
 * Every post from every user, newest first. A pure chronological sort mixes
 * creators naturally without any grouping — no ranking algorithm needed for
 * v1 (posts.js already has a separate "hot" ranked discover feed for the
 * dashboard if that's ever wanted here instead — this stays simple on
 * purpose, per spec, and can be swapped for a smarter feedScore later
 * without changing the response shape).
 * ==========================================================================*/
router.get('/api/insights/discover', verifyToken, async (req, res) => {

    try {
        const myUsername = req.user.username;
        const page = Math.max(1, parseInt(req.query.page) || 1);
        const skip = (page - 1) * PAGE_SIZE;

        const posts = await Post.find({ isDeleted: false })
            .sort({ createdAt: -1 })
            .skip(skip)
            .limit(PAGE_SIZE)
            .lean();

        const enriched = await enrichSquarePosts(posts, myUsername);
        const hasMore = posts.length === PAGE_SIZE;

        return sendResponse(res, 200, true, 'Discover feed fetched', { posts: enriched, page, hasMore });

    } catch (err) {
        console.error('⚠️ GET /api/insights/discover error:', err);
        return sendResponse(res, 500, false, 'Failed to load discover feed');
    }
});

/* ============================================================================
 * FOLLOWING FEED
 * ----------------------------------------------------------------------------
 * Posts only from creators the logged-in user follows, newest first. The
 * logged-in user's own posts are explicitly excluded even though a self-
 * follow shouldn't normally exist (Follow /api/follow already blocks
 * following yourself) — belt and suspenders.
 * ==========================================================================*/
router.get('/api/insights/following', verifyToken, async (req, res) => {

    try {
        const myUsername = req.user.username;

        const myFollows = await Follow.find({ followerUsername: myUsername }).select('followingUsername').lean();
        const followingUsernames = myFollows
            .map(f => f.followingUsername)
            .filter(u => u !== myUsername);

        if (!followingUsernames.length) {
            return sendResponse(res, 200, true, 'Following feed fetched', { posts: [], page: 1, hasMore: false });
        }

        const page = Math.max(1, parseInt(req.query.page) || 1);
        const skip = (page - 1) * PAGE_SIZE;

        const posts = await Post.find({ isDeleted: false, username: { $in: followingUsernames } })
            .sort({ createdAt: -1 })
            .skip(skip)
            .limit(PAGE_SIZE)
            .lean();

        const enriched = await enrichSquarePosts(posts, myUsername);
        const hasMore = posts.length === PAGE_SIZE;

        return sendResponse(res, 200, true, 'Following feed fetched', { posts: enriched, page, hasMore });

    } catch (err) {
        console.error('⚠️ GET /api/insights/following error:', err);
        return sendResponse(res, 500, false, 'Failed to load following feed');
    }
});

/* ============================================================================
 * LIKE / UNLIKE (toggle)
 * ----------------------------------------------------------------------------
 * Same toggle pattern as posts.js's like endpoint: a Like doc is the source
 * of truth (unique per user+post via the compound index on Like), and
 * Post.likesCount is a denormalized counter kept in sync alongside it so
 * feed reads never need to COUNT() likes on the fly.
 * ==========================================================================*/
router.post('/api/insights/posts/:id/like', verifyToken, async (req, res) => {

    try {
        const myUsername = req.user.username;
        const postId = req.params.id;

        const post = await Post.findById(postId);
        if (!post || post.isDeleted)
            return sendResponse(res, 404, false, 'Post not found');

        const existingLike = await Like.findOne({ username: myUsername, targetType: 'Post', targetId: postId });

        if (existingLike) {
            await Like.deleteOne({ _id: existingLike._id });
            post.likesCount = Math.max(0, post.likesCount - 1);
            await post.save();
            return sendResponse(res, 200, true, 'Post unliked', { liked: false, likesCount: post.likesCount });
        }

        try {
            await Like.create({ username: myUsername, targetType: 'Post', targetId: postId });
        } catch (dupErr) {
            if (dupErr.code === 11000)
                return sendResponse(res, 409, false, 'Already liked');
            throw dupErr;
        }

        post.likesCount += 1;
        await post.save();
        return sendResponse(res, 200, true, 'Post liked', { liked: true, likesCount: post.likesCount });

    } catch (err) {
        console.error('⚠️ POST /api/insights/posts/:id/like error:', err);
        return sendResponse(res, 500, false, 'Failed to like/unlike post');
    }
});

module.exports = router;

/* ============================================================================
 * ONE-TIME SETUP NEEDED IN server.js
 * ----------------------------------------------------------------------------
 * Mount this router alongside your other Social_Platform routers:
 *
 *   app.use(require('./Social_Platform/insights'));
 *
 * That single line registers all three API routes above plus the
 * GET /crypto-square page route. No other server.js changes are required —
 * this file reuses the existing verifyToken middleware and the existing
 * SocialProfile / Post / Follow / Like models, and calls the existing
 * POST /api/follow and POST /api/unfollow endpoints from
 * Social_Platform/top-creators.js from the frontend directly (that router
 * must already be mounted, which it should be if /top-creators works today).
 * ==========================================================================*/