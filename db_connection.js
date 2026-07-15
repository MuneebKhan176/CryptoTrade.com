require('dotenv').config({ path: './routes/.env' }); // MUST be first line

const { DB_HOST, DB_USERNAME, DB_PASSWORD, DB_NAME } = process.env;

const jwtSecret = process.env.JWT_SECRET_KEY;

const mysql = require('mysql2');

/* ═══════════════════════════════════════════════════════════════════════
   POOL, NOT A SINGLE CONNECTION
   ───────────────────────────────────────────────────────────────────────
   This used to be mysql.createConnection(...) — ONE physical socket
   shared by the entire process. That's fine for plain, one-shot queries
   (conn.query(...) below still works exactly the same — pool.query has
   the identical signature) but it silently breaks the moment two
   requests need a transaction at the same time:

     req A: conn.beginTransaction()
     req B: conn.beginTransaction()   <- same socket, stomps on A
     req A: conn.query('UPDATE spot_holdings ... FOR UPDATE')
     req B: conn.query('UPDATE spot_holdings ... FOR UPDATE')
     req A: conn.commit()
     req B: conn.commit()

   Statements from A and B interleave on the SAME session, so the
   FOR UPDATE row locks, the transaction boundaries, and the commit /
   rollback calls no longer line up with the request that issued them.
   That's a second, independent way to end up with a negative
   spot_holdings balance under any real concurrency (e.g. a transfer
   landing mid-order, or two orders firing at once) — separate from the
   missing order-level locking, which is fixed in
   Wallets_Config/spotHoldingsLock.js.

   Fix: a connection pool. Simple one-shot calls (conn.query(...)) keep
   working completely unchanged — pool.query() auto-acquires a
   connection, runs the query, and releases it back, so every OTHER file
   that just does conn.query(...) (authRoutes.js, walletRoutes.js, the
   dashboard/social routes, etc.) needs ZERO changes.

   Anything that needs a real transaction (BEGIN ... FOR UPDATE ...
   COMMIT) must instead call getConnection() below to check out ONE
   dedicated connection for the lifetime of that transaction, and
   release() it when done. See Wallets_Config/walletTransfer.js and
   routes/spotPanel_Route.js for the pattern.
   ═══════════════════════════════════════════════════════════════════════ */
const pool = mysql.createPool({
    host: DB_HOST,
    user: DB_USERNAME,
    password: DB_PASSWORD,
    database: DB_NAME,
    waitForConnections: true,
    connectionLimit: 10,
    queueLimit: 0,
});

pool.getConnection((err, connection) => {
    if (err) {
        console.error('MySQL pool: initial connection check failed:', err);
        return;
    }
    connection.release();
    console.log('MySQL pool: connected.');
});

// Promise-flavored helper for grabbing ONE dedicated connection to run a
// multi-statement transaction on. beginTransaction/query/commit/rollback
// must all happen on the SAME connection object, not the pool — always
// pair this with connection.release() in a finally block.
function getConnection() {
    return new Promise((resolve, reject) => {
        pool.getConnection((err, connection) => {
            if (err) return reject(err);
            resolve(connection);
        });
    });
}

module.exports = { conn: pool, getConnection, jwtSecret };