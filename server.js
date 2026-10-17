const express = require('express');
const bcrypt = require('bcrypt');
const path = require('path');
const pool = require('./db');

const app = express();
app.use(express.json());

app.get('/', (req, res) => res.sendFile(path.join(__dirname, 'index.html')));
app.get('/style.css', (req, res) => res.sendFile(path.join(__dirname, 'style.css')));
app.get('/script.js', (req, res) => res.sendFile(path.join(__dirname, 'script.js')));

app.post('/api/register', async (req, res) => {
  const { username, email, password, role, organization } = req.body;

  if (!username || !email || !password || !['client', 'vendor'].includes(role)) {
    return res.status(400).json({ error: 'Please fill all fields correctly' });
  }

  try {
    const hash = await bcrypt.hash(password, 12);
    const [rows] = await pool.query('CALL sp_register_user(?, ?, ?, ?, ?)',
      [username, email, hash, role, organization || null]);
    res.json({ success: true, userId: rows[0][0].user_id });
  } catch (err) {
    if (err.code === 'ER_DUP_ENTRY') {
      return res.status(409).json({ error: 'Username or email already exists' });
    }
    console.error(err);
    res.status(500).json({ error: 'Server error' });
  }
});

app.post('/api/login', async (req, res) => {
  const { username, password } = req.body;

  try {
    const [users] = await pool.query(
      'SELECT user_id, username, password_hash, role FROM users WHERE username = ? AND is_active = 1',
      [username]);
    const user = users[0];

    if (!user || !(await bcrypt.compare(password, user.password_hash))) {
      return res.status(401).json({ error: 'Wrong username or password' });
    }

    res.json({ success: true, userId: user.user_id, username: user.username, role: user.role });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Server error' });
  }
});

app.listen(3000, '127.0.0.1', () => {
  console.log('ScopeDesk running at http://127.0.0.1:3000');
});