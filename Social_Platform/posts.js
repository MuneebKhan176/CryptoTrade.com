const express  = require('express');
const router   = express.Router();
const path     = require('path');
const fs       = require('fs');
const multer   = require('multer');

const verifyToken = require('../middle/middleware');
const { SocialProfile, Post, Follow, Like } = require('./social_models');

const PAGE_SIZE = 5;

function sendResponse(res, statusCode, success, message, data = null) {
    return res.status(statusCode).json({ success, message, data });
}

/* ============================================================================
 * MEDIA UPLOAD (multer, disk storage)
 * ----------------------------------------------------------------------------
 * Posts can carry photos AND video, so instead of base64-encoding media into
 * the Mongo document (fine for a small avatar, risky for video against the
 * 16MB document cap), files are saved to /uploads/posts on disk and only the
 * resulting URL is stored on Post.media[].url — matches MediaAttachmentSchema.
 * Requires `express.static` for /uploads to be registered in web.js (see the
 * setup note at the bottom of this file).
 * ==========================================================================*/
const uploadDir = path.join(__dirname, '../uploads/posts');
fs.mkdirSync(uploadDir, { recursive: true });

const storage = multer.diskStorage({
    destination: (req, file, cb) => cb(null, uploadDir),
    filename: (req, file, cb) => {
        const unique = Date.now() + '-' + Math.round(Math.random() * 1e9);
        cb(null, unique + path.extname(file.originalname || ''));
    },
});

const upload = multer({
    storage,
    limits: { fileSize: 20 * 1024 * 1024, files: 6 }, // 20MB per file, 6 files max total
    fileFilter: (req, file, cb) => {
        if (file.fieldname === 'images' && !file.mimetype.startsWith('image/'))
            return cb(new Error('Only image files are allowed in the photos field'));
        if (file.fieldname === 'videos' && !file.mimetype.startsWith('video/'))
            return cb(new Error('Only video files are allowed in the videos field'));
        cb(null, true);
    },
});

/* ============================================================================
 * HELPERS
 * ==========================================================================*/

// Batch-attaches author info (displayName/avatarUrl/followersCount) to a
// list of plain post objects, and flags each post with isLiked / isSelf /
// isFollowingAuthor for the requesting user — all in a constant number of
// extra queries regardless of how many posts are in the page.
async function enrichPosts(posts, myUsername) {
    if (!posts.length) return [];

    const usernames = [...new Set(posts.map(p => p.username))];
    const postIds    = posts.map(p => p._id);

    const [authors, myFollows, myLikes] = await Promise.all([
        SocialProfile.find({ username: { $in: usernames } }, 'username displayName avatarUrl followersCount').lean(),
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
                followersCount: author?.followersCount || 0,
            },
            isSelf: p.username === myUsername,
            isFollowingAuthor: followingSet.has(p.username),
            isLiked: likedSet.has(String(p._id)),
        };
    });
}

/* ============================================================================
 * CREATE POST PAGE
 * ==========================================================================*/
router.get('/create-post', verifyToken, (req, res) => {
    res.sendFile(path.join(__dirname, '../Frontend/create-post.html'));
});

/* ============================================================================
 * CREATE POST
 * ==========================================================================*/
router.post('/api/posts', verifyToken, upload.fields([
    { name: 'images', maxCount: 4 },
    { name: 'videos', maxCount: 2 },
]), async (req, res) => {

    try {
        const myUsername = req.user.username;
        const title   = (req.body.title || '').trim();
        const content = (req.body.content || '').trim();

        if (!content)
            return sendResponse(res, 400, false, 'Post content is required');
        if (title.length > 100)
            return sendResponse(res, 400, false, 'Title must be 100 characters or fewer');

        // The Post schema (as given) has no `title` field, so an optional
        // title is folded into `content` as a leading "## Title" line and
        // split back out again on the frontend for display.
        const bodyWithTitle = title ? `## ${title}\n${content}` : content;

        if (bodyWithTitle.length > 2000)
            return sendResponse(res, 400, false, 'Post is too long (max 2000 characters, including the title line)');

        const media = [];
        (req.files?.images || []).forEach(f => media.push({ url: `/uploads/posts/${f.filename}`, type: 'image' }));
        (req.files?.videos || []).forEach(f => media.push({ url: `/uploads/posts/${f.filename}`, type: 'video' }));

        const newPost = await Post.create({
            username: myUsername,
            content: bodyWithTitle,
            media,
        });

        await SocialProfile.findOneAndUpdate({ username: myUsername }, { $inc: { postsCount: 1 } });

        return sendResponse(res, 201, true, 'Post created successfully', { post: newPost });

    } catch (err) {
        console.error('⚠️ POST /api/posts error:', err);
        const isUploadError = err.message && /allowed|File too large|Unexpected field/i.test(err.message);
        return sendResponse(res, isUploadError ? 400 : 500, false, err.message || 'Failed to create post');
    }
});

/* ============================================================================
 * DISCOVER FEED
 * ----------------------------------------------------------------------------
 * Ranked with a "hot" score in the style of Reddit/Hacker News: a
 * log10-scaled popularity term (author's followersCount) added to a linear
 * recency term (post age in seconds, scaled). Logarithmic scaling means an
 * order-of-magnitude jump in followers only buys a fixed head start, so a
 * brand-new post from a small account still surfaces near the top and ages
 * out gradually — rather than the feed being permanently dominated by
 * whoever already has the most followers.
 * ==========================================================================*/
router.get('/api/posts/discover', verifyToken, async (req, res) => {

    try {
        const myUsername = req.user.username;

        const baseMatch = { isDeleted: false };

        // "after" is used only by the New-Posts banner lookahead — fetch
        // anything newer than the last-seen post without touching pagination.
        if (req.query.after) {
            const afterDate = new Date(req.query.after);
            const posts = await Post.aggregate([
                { $match: { ...baseMatch, createdAt: { $gt: afterDate } } },
                { $sort: { createdAt: -1 } },
                { $limit: 20 },
            ]);
            const enriched = await enrichPosts(posts, myUsername);
            return sendResponse(res, 200, true, 'Newer discover posts fetched', { posts: enriched });
        }

        const page  = Math.max(1, parseInt(req.query.page) || 1);
        const skip  = (page - 1) * PAGE_SIZE;

        const posts = await Post.aggregate([
            { $match: baseMatch },
            { $lookup: { from: 'socialprofiles', localField: 'username', foreignField: 'username', as: 'authorLookup' } },
            { $unwind: { path: '$authorLookup', preserveNullAndEmptyArrays: true } },
            { $addFields: {
                popularityScore: { $log10: { $add: [{ $ifNull: ['$authorLookup.followersCount', 0] }, 1] } },
                recencySeconds:  { $divide: [{ $toLong: '$createdAt' }, 1000] },
            } },
            { $addFields: {
                feedScore: { $add: ['$popularityScore', { $divide: ['$recencySeconds', 45000] }] },
            } },
            { $sort: { feedScore: -1, _id: -1 } },
            { $skip: skip },
            { $limit: PAGE_SIZE },
            { $project: { authorLookup: 0, popularityScore: 0, recencySeconds: 0, feedScore: 0 } },
        ]);

        const enriched = await enrichPosts(posts, myUsername);
        const hasMore = posts.length === PAGE_SIZE;

        return sendResponse(res, 200, true, 'Discover feed fetched', { posts: enriched, page, hasMore });

    } catch (err) {
        console.error('⚠️ GET /api/posts/discover error:', err);
        return sendResponse(res, 500, false, 'Failed to load discover feed');
    }
});

/* ============================================================================
 * FOLLOWING FEED
 * ----------------------------------------------------------------------------
 * Pure chronological order (newest first) among people the user follows.
 * ==========================================================================*/
router.get('/api/posts/following', verifyToken, async (req, res) => {

    try {
        const myUsername = req.user.username;

        const myFollows = await Follow.find({ followerUsername: myUsername }).select('followingUsername').lean();
        const followingUsernames = myFollows.map(f => f.followingUsername);

        if (!followingUsernames.length) {
            return sendResponse(res, 200, true, 'Following feed fetched', { posts: [], page: 1, hasMore: false });
        }

        const baseMatch = { isDeleted: false, username: { $in: followingUsernames } };

        if (req.query.after) {
            const afterDate = new Date(req.query.after);
            const posts = await Post.find({ ...baseMatch, createdAt: { $gt: afterDate } })
                .sort({ createdAt: -1 })
                .limit(20)
                .lean();
            const enriched = await enrichPosts(posts, myUsername);
            return sendResponse(res, 200, true, 'Newer following posts fetched', { posts: enriched });
        }

        const page = Math.max(1, parseInt(req.query.page) || 1);
        const skip = (page - 1) * PAGE_SIZE;

        const posts = await Post.find(baseMatch)
            .sort({ createdAt: -1 })
            .skip(skip)
            .limit(PAGE_SIZE)
            .lean();

        const enriched = await enrichPosts(posts, myUsername);
        const hasMore = posts.length === PAGE_SIZE;

        return sendResponse(res, 200, true, 'Following feed fetched', { posts: enriched, page, hasMore });

    } catch (err) {
        console.error('⚠️ GET /api/posts/following error:', err);
        return sendResponse(res, 500, false, 'Failed to load following feed');
    }
});

/* ============================================================================
 * NEW-POSTS COUNT (for the "N new posts" banner)
 * ----------------------------------------------------------------------------
 * Keyset/cursor lookahead: rather than re-fetching and re-sorting the whole
 * feed to see if anything changed, we just count documents newer than the
 * timestamp of the newest post the client already has. O(matching docs),
 * no re-scan of pages already loaded.
 * ==========================================================================*/
router.get('/api/posts/new-count', verifyToken, async (req, res) => {

    try {
        const { feed, since } = req.query;
        if (!since) return sendResponse(res, 400, false, 'since is required');

        const sinceDate = new Date(since);
        if (isNaN(sinceDate.getTime())) return sendResponse(res, 400, false, 'Invalid since timestamp');

        const match = { isDeleted: false, createdAt: { $gt: sinceDate } };

        if (feed === 'following') {
            const myUsername = req.user.username;
            const myFollows = await Follow.find({ followerUsername: myUsername }).select('followingUsername').lean();
            const usernames = myFollows.map(f => f.followingUsername);
            if (!usernames.length) return sendResponse(res, 200, true, 'ok', { count: 0 });
            match.username = { $in: usernames };
        }

        const count = await Post.countDocuments(match);
        return sendResponse(res, 200, true, 'ok', { count });

    } catch (err) {
        console.error('⚠️ GET /api/posts/new-count error:', err);
        return sendResponse(res, 500, false, 'Failed to check for new posts');
    }
});

/* ============================================================================
 * LIKE / UNLIKE (toggle)
 * ==========================================================================*/
router.post('/api/posts/:id/like', verifyToken, async (req, res) => {

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
        console.error('⚠️ POST /api/posts/:id/like error:', err);
        return sendResponse(res, 500, false, 'Failed to like/unlike post');
    }
});

/* ============================================================================
 * MULTER ERROR HANDLER (router-level)
 * ==========================================================================*/
router.use((err, req, res, next) => {
    if (err instanceof multer.MulterError) {
        return sendResponse(res, 400, false, `Upload error: ${err.message}`);
    }
    if (err) {
        return sendResponse(res, 400, false, err.message || 'Upload failed');
    }
    next();
});

module.exports = router;

/* ============================================================================
 * ONE-TIME SETUP NEEDED IN web.js
 * ----------------------------------------------------------------------------
 * 1. npm install multer
 * 2. Serve the uploads folder as static files, e.g.:
 *      const path = require('path');
 * 3. Mount this router alongside your others:
 *      app.use(require('./Social_Platform/posts'));
 * ==========================================================================*/