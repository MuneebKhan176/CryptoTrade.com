const jwt = require('jsonwebtoken');
// 🛠️ Fix 1: Import the correct secret variable from your db_connection file
const { jwtSecret } = require('../db_connection'); 

function verifyToken(req, res, next) {

    // Check cookie first, then fall back to Authorization header
    const token = req.cookies?.token || req.headers['authorization']?.split(' ')[1];

    if (!token) {
        // If it's a page request, redirect to login instead of JSON error
        if (req.headers['accept']?.includes('text/html')) {
            return res.redirect('/login');
        }
        return res.status(401).json({ success: false, message: 'No token provided' });
    }

    // 🛠️ Fix 2: Change process.env.JWT_SECRET to your imported jwtSecret
    jwt.verify(token, jwtSecret, (err, decoded) => {

        if (err) {
            // This is where you were getting caught in the infinite loop
            if (req.headers['accept']?.includes('text/html')) {
                return res.redirect('/login');
            }
            return res.status(403).json({ success: false, message: 'Invalid or expired token' });
        }

        req.user = decoded;
        next();
    });
}

module.exports = verifyToken;