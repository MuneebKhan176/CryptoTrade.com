
 /*   const {
 *     SocialProfile, Post, Comment, Reply, Follow, Like,
 *     Poll, Hashtag, Media, UserActivity, Notification
 *   } = require('./social_models');
 * ---------------------------------------------------------------------------
 */

const mongoose = require("mongoose");
const { Schema } = mongoose;


const TARGET_TYPES = ["Post", "Comment", "Reply"]; 

const MediaAttachmentSchema = new Schema(
  {
    url: { type: String, required: true },
    type: { type: String, enum: ["image", "video"], required: true },
    width: Number,
    height: Number,
    durationSeconds: Number, // for video
  },
  { _id: false }
);

/* ============================================================================
 * 1. SOCIAL PROFILE
 * ==========================================================================*/

const SocialProfileSchema = new Schema(
  {
    userId: { type: Number, required: true, unique: true, index: true }, // FK -> mysql users.id (same value as accounts.user_id)
    username: { type: String, required: true, unique: true, index: true }, // FK -> mysql accounts.username
    email: { type: String, required: true, unique: true, index: true }, // FK -> mysql accounts.email

    displayName: { type: String, default: "", trim: true, maxlength: 60 },
    bio: { type: String, default: "", maxlength: 300 },
    avatarUrl: { type: String, default: "" },
    coverUrl: { type: String, default: "" },

    isVerified: { type: Boolean, default: false },

    // Denormalized counters -> this is what tracks how many you follow / are followed by
    followersCount: { type: Number, default: 0 },
    followingCount: { type: Number, default: 0 },
    postsCount: { type: Number, default: 0 },
  },
  { timestamps: true }
);

/* ============================================================================
 * 2. POST
 *    Text, images/video, and optional trading-signal fields all on one doc.
 * ==========================================================================*/
const PostSchema = new Schema(
  {
    username: { type: String, required: true, index: true }, // author, FK -> SocialProfile.username

    content: { type: String, default: "", maxlength: 2000 },
    media: { type: [MediaAttachmentSchema], default: [] }, // charts/screenshots/videography

    hashtags: { type: [String], default: [], index: true }, // lowercase, no '#'

    poll: { type: Schema.Types.ObjectId, ref: "Poll", default: null },

    // ---- optional trade-signal fields (only set when isSignal = true) ----
    isSignal: { type: Boolean, default: false },
    signal: {
      symbol: { type: String, default: "" }, // e.g. "BTC/USDT"
      direction: { type: String, enum: ["long", "short", null], default: null },
      entryPrice: { type: Number, default: null },
      targetPrice: { type: Number, default: null },
      stopLoss: { type: Number, default: null },
    },

    // Denormalized counters
    likesCount: { type: Number, default: 0 },
    commentsCount: { type: Number, default: 0 },

    isEdited: { type: Boolean, default: false },
    isDeleted: { type: Boolean, default: false }, // soft delete
  },
  { timestamps: true }
);
PostSchema.index({ username: 1, createdAt: -1 });

/* ============================================================================
 * 3. COMMENT (top-level comment on a Post)
 * ==========================================================================*/
const CommentSchema = new Schema(
  {
    post: { type: Schema.Types.ObjectId, ref: "Post", required: true, index: true },
    username: { type: String, required: true, index: true },

    content: { type: String, required: true, maxlength: 1000 },

    likesCount: { type: Number, default: 0 },
    repliesCount: { type: Number, default: 0 },

    isEdited: { type: Boolean, default: false },
    isDeleted: { type: Boolean, default: false },
  },
  { timestamps: true }
);
CommentSchema.index({ post: 1, createdAt: -1 });

/* ============================================================================
 * 4. REPLY (reply nested under a Comment)
 * ==========================================================================*/
const ReplySchema = new Schema(
  {
    comment: { type: Schema.Types.ObjectId, ref: "Comment", required: true, index: true },
    post: { type: Schema.Types.ObjectId, ref: "Post", required: true, index: true }, // denormalized for fast lookups
    username: { type: String, required: true, index: true },

    content: { type: String, required: true, maxlength: 1000 },

    likesCount: { type: Number, default: 0 },

    isEdited: { type: Boolean, default: false },
    isDeleted: { type: Boolean, default: false },
  },
  { timestamps: true }
);
ReplySchema.index({ comment: 1, createdAt: 1 });

/* ============================================================================
 * 5. FOLLOW
 * ==========================================================================*/
const FollowSchema = new Schema(
  {
    followerUsername: { type: String, required: true, index: true }, // who clicked follow
    followingUsername: { type: String, required: true, index: true }, // who is being followed
  },
  { timestamps: true }
);
FollowSchema.index({ followerUsername: 1, followingUsername: 1 }, { unique: true });

/* ============================================================================
 * 6. LIKE (generic like on Post / Comment / Reply)
 * ==========================================================================*/
const LikeSchema = new Schema(
  {
    username: { type: String, required: true, index: true },
    targetType: { type: String, enum: TARGET_TYPES, required: true },
    targetId: { type: Schema.Types.ObjectId, required: true, index: true },
  },
  { timestamps: true }
);
LikeSchema.index({ username: 1, targetType: 1, targetId: 1 }, { unique: true });

/* ============================================================================
 * 7. POLL (attached to a Post)
 * ==========================================================================*/
const PollOptionSchema = new Schema(
  {
    text: { type: String, required: true, maxlength: 100 },
    votesCount: { type: Number, default: 0 },
  },
  { _id: true }
);

const PollSchema = new Schema(
  {
    post: { type: Schema.Types.ObjectId, ref: "Post", required: true, index: true },
    question: { type: String, required: true, maxlength: 200 },
    options: { type: [PollOptionSchema], required: true },

    voters: {
      type: [
        {
          username: { type: String, required: true },
          optionId: { type: Schema.Types.ObjectId, required: true },
          _id: false,
        },
      ],
      default: [],
    },

    expiresAt: { type: Date, required: true },
  },
  { timestamps: true }
);

/* ============================================================================
 * 8. HASHTAG (trending hashtags)
 * ==========================================================================*/
const HashtagSchema = new Schema(
  {
    tag: { type: String, required: true, unique: true, lowercase: true, trim: true, index: true },
    postsCount: { type: Number, default: 0 },
    trendScore: { type: Number, default: 0 },
    lastUsedAt: { type: Date, default: Date.now },
  },
  { timestamps: true }
);

/* ============================================================================
 * 9. MEDIA (images & videos metadata / upload registry)
 * ==========================================================================*/
const MediaSchema = new Schema(
  {
    username: { type: String, required: true, index: true }, // uploader
    url: { type: String, required: true },
    type: { type: String, enum: ["image", "video"], required: true },

    width: Number,
    height: Number,
    durationSeconds: Number,
    sizeBytes: Number,

    attachedToType: { type: String, enum: ["Post", null], default: null },
    attachedToId: { type: Schema.Types.ObjectId, default: null },
  },
  { timestamps: true }
);

/* ============================================================================
 * 10. USER ACTIVITY (feed/recommendation history)
 * ==========================================================================*/
const UserActivitySchema = new Schema(
  {
    username: { type: String, required: true, index: true },

    activityType: {
      type: String,
      enum: ["view_post", "like", "comment", "follow", "search"],
      required: true,
    },

    targetType: { type: String, enum: TARGET_TYPES, default: null },
    targetId: { type: Schema.Types.ObjectId, default: null },

    metadata: { type: Schema.Types.Mixed, default: {} }, // e.g. { query: "BTC halving" } for a search event
  },
  { timestamps: true }
);
UserActivitySchema.index({ username: 1, createdAt: -1 });

/* ============================================================================
 * 11. NOTIFICATION (kept lightweight — for like/comment/follow alerts)
 *     Not explicitly requested to keep or remove — flagging this in chat.
 * ==========================================================================*/
const NotificationSchema = new Schema(
  {
    recipientUsername: { type: String, required: true, index: true },
    actorUsername: { type: String, required: true },

    type: { type: String, enum: ["like", "comment", "reply", "follow", "mention"], required: true },

    targetType: { type: String, enum: TARGET_TYPES, default: null },
    targetId: { type: Schema.Types.ObjectId, default: null },

    isRead: { type: Boolean, default: false },
  },
  { timestamps: true }
);
NotificationSchema.index({ recipientUsername: 1, createdAt: -1 });

/* ============================================================================
 * MODEL EXPORTS
 * ==========================================================================*/
module.exports = {
  SocialProfile: mongoose.model("SocialProfile", SocialProfileSchema),
  Post: mongoose.model("Post", PostSchema),
  Comment: mongoose.model("Comment", CommentSchema),
  Reply: mongoose.model("Reply", ReplySchema),
  Follow: mongoose.model("Follow", FollowSchema),
  Like: mongoose.model("Like", LikeSchema),
  Poll: mongoose.model("Poll", PollSchema),
  Hashtag: mongoose.model("Hashtag", HashtagSchema),
  Media: mongoose.model("Media", MediaSchema),
  UserActivity: mongoose.model("UserActivity", UserActivitySchema),
  Notification: mongoose.model("Notification", NotificationSchema),
};