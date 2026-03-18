const { Pool } = require('pg');

const isUnixSocket = process.env.DB_HOST && process.env.DB_HOST.startsWith('/');

const pool = new Pool({
    user: process.env.DB_USER,
    host: process.env.DB_HOST,
    database: process.env.DB_NAME,
    password: process.env.DB_PASS,
    port: process.env.DB_PORT,
    ssl: (process.env.NODE_ENV === 'production' && !isUnixSocket)
        ? { rejectUnauthorized: false }
        : false,
});

module.exports = { pool };
