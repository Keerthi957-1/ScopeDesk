require('dotenv').config();
const mysql = require('mysql2/promise');

async function test() {
  const connection = await mysql.createConnection({
    host: process.env.DB_HOST,
    user: process.env.DB_USER,
    password: process.env.DB_PASSWORD,
    database: process.env.DB_NAME,
  });

  const [rows] = await connection.query('SHOW TABLES');
  console.log('Connected! Tables found:', rows.length);
  await connection.end();
}

test().catch((err) => console.log('Failed:', err.message));