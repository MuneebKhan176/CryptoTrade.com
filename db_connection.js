require('dotenv').config({ path: './routes/.env' }); // MUST be first line

const{DB_HOST, DB_USERNAME,DB_PASSWORD, DB_NAME } = process.env;

const jwtSecret = process.env.JWT_SECRET_KEY;

const mysql = require('mysql2');

var conn= mysql.createConnection({
    host: DB_HOST,
    user: DB_USERNAME,
    password: DB_PASSWORD,
    database: DB_NAME
   
})

conn.connect(function(err){
    if(err)
        throw err;
});

module.exports= {conn,jwtSecret};
