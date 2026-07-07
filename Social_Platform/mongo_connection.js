const mongoose = require("mongoose");
const path = require("path");

require("dotenv").config({
    path: path.join(__dirname, "../routes/.env"),
});

async function connectMongoDB() {
    try {
        await mongoose.connect(process.env.MONGO_URI);

    } catch (error) {
        console.error("❌ MongoDB Connection Failed");
        console.error(error);

        process.exit(1);
    }
}

module.exports = connectMongoDB;