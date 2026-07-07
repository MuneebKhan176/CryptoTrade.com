const express = require('express');
const router = express.Router();
const path = require('path');

// HOMEPAGE ROUTE
router.get('/', (req, res) => {
    res.sendFile(path.join(__dirname, '../Frontend/index.html'))
});

// .css files are now handled by express.static

module.exports = router;