const express = require('express');
const router = express.Router();
const path = require('path');
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');

const { conn, jwtSecret } = require('../db_connection');
const { createUserWallets } = require('../Wallets/walletServices');
const sendVerificationEmail = require('../mailer');
const verifyToken = require('../middle/middleware');

// 🔗 Mongo side — adjust this path if social_models.js lives somewhere else
const { SocialProfile } = require('../Social_Platform/social_models');


function isValidEmail(email) {
    const regex = /^[a-zA-Z0-9._%+-]+@[a-zA-Z0-9.-]+\.com$/;
    return regex.test(email);
}

function sendResponse(res, statusCode, success, message, data = null) {
    return res.status(statusCode).json({ success, message, data });
}

function generateCode() {
    return Math.floor(100000 + Math.random() * 900000).toString();
}

function setAuthCookie(res, token) {
    res.cookie('token', token, {
        httpOnly: true,
        secure: false,   // 🛠️ Force to false so your localhost browser accepts it over HTTP
        sameSite: 'Lax',  // 🛠️ 'Lax' plays much friendlier with local development redirects
        maxAge: 24 * 60 * 60 * 1000
    });
}

// ================= SOCIAL PROFILE HELPER =================

async function ensureSocialProfile(userId, username, email) {

    const profile = await SocialProfile.findOneAndUpdate(
        { userId },
        {
            $setOnInsert: {
                userId,
                username,
                email,
                displayName: username,
                bio: '',
                avatarUrl: '',
                coverUrl: '',
                isVerified: false,
                followersCount: 0,
                followingCount: 0,
                postsCount: 0,
            },
        },
        {
            upsert: true,
            returnDocument: 'after',
            setDefaultsOnInsert: true,
        }
    );

    return profile;
}

const CODE_EXPIRY_MS = 10 * 60 * 1000;
const DEMO_AMOUNT = 50000.00;

// ================= REGISTER PAGE =================
router.get('/register', (req, res) => {
    res.sendFile(path.join(__dirname, '../Frontend/Auth_UI/register.html'));
});

// ================= REGISTER USER =================
router.post('/register', (req, res) => {

    const username = req.body.name?.trim();
    const email = req.body.email?.trim();
    const password = req.body.password?.trim();
    const confirmPassword = req.body.confirmPassword?.trim();

    if (!username || !email || !password || !confirmPassword)
        return sendResponse(res, 400, false, 'All fields are required');

    if (!isValidEmail(email))
        return sendResponse(res, 400, false, 'Invalid email format');

    if (password.length < 8)
        return sendResponse(res, 400, false, 'Password must be at least 8 characters');

    if (password !== confirmPassword)
        return sendResponse(res, 400, false, 'Passwords do not match');

    const checkUserSql = 'SELECT * FROM users WHERE email = ?';

    conn.query(checkUserSql, [email], (err, result) => {

        if (err) return sendResponse(res, 500, false, 'Database error');
        if (result.length > 0) return sendResponse(res, 409, false, 'Email already exists');

        bcrypt.hash(password, 10, (err, hashedPassword) => {

            if (err) return sendResponse(res, 500, false, 'Password hashing failed');

            const code = generateCode();
            const expiresAt = new Date(Date.now() + CODE_EXPIRY_MS);

            conn.query('DELETE FROM pending_users WHERE email = ?', [email], () => {

                const insertPendingSql =
                    'INSERT INTO pending_users (username, email, password, verification_code, expires_at) VALUES (?, ?, ?, ?, ?)';

                conn.query(insertPendingSql, [username, email, hashedPassword, code, expiresAt], (err) => {

                    if (err) return sendResponse(res, 500, false, 'Insert failed');

                    sendVerificationEmail(email, code)
                        .then(() => sendResponse(res, 201, true, 'Verification code sent!', { email }))
                        .catch(() => sendResponse(res, 500, false, 'Email sending failed'));
                });
            });
        });
    });
});

// ================= VERIFY EMAIL PAGE =================
router.get('/verify-email', (req, res) => {
    res.sendFile(path.join(__dirname, '../Frontend/Auth_UI/verify-email.html'));
});

// ================= VERIFY EMAIL =================
// Flow: 1) users row created  2) accounts row created  3) spot + futures
// wallets created (all SQL, all in ONE transaction)  4) transaction
// committed  5) ONLY THEN, once everything on the SQL side is guaranteed
// to exist, do we create the Mongo SocialProfile. Nothing on the Mongo
// side ever runs before the SQL commit succeeds.
router.post('/verify-email', (req, res) => {

    const email = req.body.email?.trim();
    const code = req.body.code?.trim();

    if (!email || !code)
        return sendResponse(res, 400, false, 'Email and code required');

    conn.query('SELECT * FROM pending_users WHERE email = ?', [email], (err, result) => {

        if (err)
            return sendResponse(res, 500, false, 'Database error');

        if (!result.length)
            return sendResponse(res, 404, false, 'No pending user found');

        const pending = result[0];

        if (new Date(pending.expires_at).getTime() < Date.now()) {
            conn.query('DELETE FROM pending_users WHERE email = ?', [email]);
            return sendResponse(res, 400, false, 'Code expired');
        }

        if (String(pending.verification_code) !== code)
            return sendResponse(res, 400, false, 'Invalid code');

        conn.beginTransaction((err) => {

            if (err)
                return sendResponse(res, 500, false, 'Transaction failed');

            conn.query(
                'INSERT INTO users (username, email, password) VALUES (?, ?, ?)',
                [pending.username, pending.email, pending.password],
                (userErr, userResult) => {

                    if (userErr) {
                        return conn.rollback(() =>
                            sendResponse(res, 500, false, 'User creation failed')
                        );
                    }

                    const userId = userResult.insertId;
                    const accountNumber = 'ACC' + String(userId).padStart(9, '0');

                    conn.query(
                        'INSERT INTO accounts (user_id, account_number, balance, status) VALUES (?, ?, ?, ?)',
                        [userId, accountNumber, 0, 'ACTIVE'],
                        (accountErr) => {

                            if (accountErr) {
                                return conn.rollback(() =>
                                    sendResponse(res, 500, false, 'Account creation failed: ' + accountErr.message)
                                );
                            }

                            // Create Spot & Futures wallets
                            createUserWallets(conn, userId, (walletErr, wallets) => {

                                if (walletErr) {
                                    console.error('⚠️ Wallet creation failed:', walletErr);

                                    return conn.rollback(() =>
                                        sendResponse(res, 500, false, 'Wallet creation failed: ' + walletErr.message)
                                    );
                                }

                                // Create default USDT holding for the Spot wallet
                                conn.query(
                                    `INSERT INTO spot_holdings
                                    (
                                        wallet_id,
                                        symbol,
                                        available_quantity,
                                        locked_quantity,
                                        average_buy_price,
                                        total_cost
                                    )
                                    VALUES (?, 'USDT', 0.00, 0.00, 1.00, 0.00)`,
                                    [wallets.spotWalletId],
                                    (holdingErr) => {

                                        if (holdingErr) {
                                            return conn.rollback(() =>
                                                sendResponse(res, 500, false, 'Spot holding creation failed: ' + holdingErr.message)
                                            );
                                        }

                                        // Remove pending user
                                        conn.query(
                                            'DELETE FROM pending_users WHERE email = ?',
                                            [email],
                                            (deleteErr) => {

                                                if (deleteErr) {
                                                    return conn.rollback(() =>
                                                        sendResponse(res, 500, false, 'Cleanup failed')
                                                    );
                                                }

                                                conn.commit(async (commitErr) => {

                                                    if (commitErr) {
                                                        return conn.rollback(() =>
                                                            sendResponse(res, 500, false, 'Commit failed')
                                                        );
                                                    }

                                                    // Create MongoDB social profile (outside SQL transaction)
                                                    try {
                                                        await ensureSocialProfile(
                                                            userId,
                                                            pending.username,
                                                            pending.email
                                                        );
                                                    } catch (profileErr) {
                                                        console.error(
                                                            '⚠️ Social profile creation failed:',
                                                            profileErr
                                                        );
                                                    }

                                                    const token = jwt.sign(
                                                        {
                                                            id: userId,
                                                            email: pending.email,
                                                            username: pending.username
                                                        },
                                                        jwtSecret,
                                                        { expiresIn: '3d' }
                                                    );

                                                    setAuthCookie(res, token);

                                                    return sendResponse(
                                                        res,
                                                        200,
                                                        true,
                                                        'Email verified and account created successfully!',
                                                        {
                                                            userId,
                                                            accountNumber,
                                                            wallets,
                                                            redirectTo: '/dashboard'
                                                        }
                                                    );
                                                });
                                            }
                                        );
                                    }
                                );
                            });
                        }
                    );
                }
            );
        });
    });
});

// ================= LOGIN PAGE =================
router.get('/login', (req, res) => {
    res.sendFile(path.join(__dirname, '../Frontend/Auth_UI/login.html'));
});

// ================= LOGIN USER =================
router.post('/login', (req, res) => {

    const email    = req.body.email?.trim();
    const password = req.body.password?.trim();

    if (!email || !password)
        return sendResponse(res, 400, false, 'Email and password required');

    conn.query('SELECT * FROM users WHERE email = ?', [email], (err, result) => {

        if (err)              return sendResponse(res, 500, false, 'Database error');
        if (!result.length)   return sendResponse(res, 401, false, 'Invalid credentials');

        const user = result[0];

        bcrypt.compare(password, user.password, (err, isMatch) => {

            if (err || !isMatch)
                return sendResponse(res, 401, false, 'Invalid credentials');

            const token = jwt.sign(
                { id: user.id, email: user.email, username: user.username },
                jwtSecret,
                { expiresIn: '1d' }
            );

            setAuthCookie(res, token);

            // ✅ Redirect to dashboard after login
            return sendResponse(res, 200, true, 'Login successful', { redirectTo: '/dashboard' });
        });
    });
});

// ================= DASHBOARD PAGE =================
router.get('/dashboard', verifyToken, (req, res) => {
    res.sendFile(path.join(__dirname, '../Frontend/dashboard.html'));
});

// ================= DASHBOARD API (includes account data + social profile) =================
router.get('/api/dashboard', verifyToken, (req, res) => {

    const userId = req.user.id;

    conn.query(
        `SELECT u.id, u.username, u.email, u.created_at,
                a.user_id, a.account_number, a.balance, a.status
         FROM users u
         LEFT JOIN accounts a ON a.user_id = u.id
         WHERE u.id = ?`,
        [userId],
        async (err, result) => {

            if (err)            return sendResponse(res, 500, false, 'Database error');
            if (!result.length) return sendResponse(res, 404, false, 'User not found');

            const row = result[0];

            // Self-healing: covers accounts created before the SocialProfile
            // hook existed, or the rare case where the upsert in verify-email
            // failed. This keeps SQL and Mongo eventually consistent without
            // needing a distributed transaction between the two databases.
            let socialProfile = null;
            try {
                socialProfile = await ensureSocialProfile(row.id, row.username, row.email);
            } catch (profileErr) {
                console.error('⚠️ Social profile fetch/create failed for', row.username, profileErr);
            }

            return sendResponse(res, 200, true, 'Welcome', {
                user: {
                    id:         row.id,
                    username:   row.username,
                    email:      row.email,
                    created_at: row.created_at
                },
                account: {
                    user_id:        row.user_id,
                    account_number: row.account_number,
                    balance:        parseFloat(row.balance || 0),
                    status:         row.status
                },
                socialProfile
            });
        }
    );
});

// ================= DEMO FUNDS =================
// POST /api/demo-funds
// Only granted when balance is exactly 0 (first-time request)
router.post('/api/demo-funds', verifyToken, (req, res) => {

    const userId = req.user.id;

    conn.query(
        'SELECT balance FROM accounts WHERE user_id = ?',
        [userId],
        (err, result) => {

            if (err)            return sendResponse(res, 500, false, 'Database error');
            if (!result.length) return sendResponse(res, 404, false, 'Account not found');

            const currentBalance = parseFloat(result[0].balance);

            if (currentBalance > 0) {
                return sendResponse(res, 400, false,
                    'Demo funds already received. Balance must be $0.00 to request again.'
                );
            }

            conn.query(
                'UPDATE accounts SET balance = ? WHERE user_id = ?',
                [DEMO_AMOUNT, userId],
                (updateErr) => {

                    if (updateErr) return sendResponse(res, 500, false, 'Failed to credit demo funds');

                    return sendResponse(res, 200, true, 'Demo funds credited successfully!', {
                        credited:   DEMO_AMOUNT,
                        newBalance: DEMO_AMOUNT
                    });
                }
            );
        }
    );
});

// ================= LOGOUT =================
router.get('/logout', (req, res) => {
    res.clearCookie('token');
    res.redirect('/login');
});

module.exports = router;