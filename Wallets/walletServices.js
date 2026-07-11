
function createSpotWallet(connection, userId, callback) {
    const sql = `INSERT INTO spot_wallet (user_id) VALUES (?)`;

    connection.query(sql, [userId], (err, result) => {
        if (err) return callback(err);
        return callback(null, result.insertId);
    });
}

/**
 * Inserts a futures_wallet row with pure schema defaults.
 * (wallet_balance, available_margin, used_margin default to 0,
 * status defaults to 'ACTIVE' per the table definition)
 */
function createFuturesWallet(connection, userId, callback) {
    const sql = `INSERT INTO futures_wallet (user_id) VALUES (?)`;

    connection.query(sql, [userId], (err, result) => {
        if (err) return callback(err);
        return callback(null, result.insertId);
    });
}

/**
 * Creates both the spot and futures wallets for a newly verified user.
 *
 * @param {object} connection - active mysql2 connection, expected to be
 *                               mid-transaction with the caller.
 * @param {number} userId
 * @param {(err: Error|null, wallets?: { spotWalletId: number, futuresWalletId: number }) => void} callback
 */

function createUserWallets(connection, userId, callback) {
    if (!userId) {
        return callback(new Error('createUserWallets: userId is required'));
    }

    createSpotWallet(connection, userId, (spotErr, spotWalletId) => {
        if (spotErr) {
            // Wrap with context so the caller's error log/response is useful
            // without needing to know which insert failed.
            const wrapped = new Error(`Spot wallet creation failed: ${spotErr.message}`);
            wrapped.cause = spotErr;
            return callback(wrapped);
        }

        createFuturesWallet(connection, userId, (futuresErr, futuresWalletId) => {
            if (futuresErr) {
                const wrapped = new Error(`Futures wallet creation failed: ${futuresErr.message}`);
                wrapped.cause = futuresErr;
                return callback(wrapped);
            }

            return callback(null, { spotWalletId, futuresWalletId });
        });
    });
}

module.exports = { createUserWallets, createSpotWallet, createFuturesWallet };
