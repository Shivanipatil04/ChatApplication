const express = require('express');
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');
const { JWT_SECRET } = require('../middleware/auth');
const User = require('../models/User');

const router = express.Router();

async function createUniqueUsername(name) {
  const base = name.toLowerCase().replace(/[^a-z0-9]/g, '').slice(0, 16) || 'user';
  let username;
  do {
    username = `${base}${Math.floor(1000 + Math.random() * 9000)}`;
  } while (await User.exists({ username }));
  return username;
}
function createToken(user) {
  return jwt.sign({ userId: user._id.toString(), name: user.name, username: user.username, email: user.email }, JWT_SECRET, { expiresIn: '24h' });
}

router.post('/register', async (req, res) => {
  const { name, email, password } = req.body;
  if (!name?.trim() || !email?.trim() || !password) return res.status(400).json({ message: 'Name, email, and password are required' });
  if (password.length < 6) return res.status(400).json({ message: 'Password must be at least 6 characters long' });

  try {
    const normalizedEmail = email.trim().toLowerCase();
    if (await User.exists({ email: normalizedEmail })) return res.status(409).json({ message: 'An account with this email already exists' });
    const hashedPassword = await bcrypt.hash(password, 12);
    const username = await createUniqueUsername(name.trim());
    await User.create({ name: name.trim(), username, email: normalizedEmail, password: hashedPassword });
    return res.status(201).json({ message: 'Account created. Please log in.' });
  } catch (error) {
    console.error('Registration error:', error);
    return res.status(500).json({ message: 'Could not create account' });
  }
});

router.post('/login', async (req, res) => {
  const { email, password } = req.body;

  if (!email?.trim() || !password) {
    return res.status(400).json({
      message: 'Email and password are required'
    });
  }

  try {
    const user = await User.findOne({
      email: email.trim().toLowerCase()
    });

    if (!user) {
      return res.status(401).json({
        message: 'Invalid email or password'
      });
    }

    const validPassword = await bcrypt.compare(
      password,
      user.password
    );

    if (!validPassword) {
      return res.status(401).json({
        message: 'Invalid email or password'
      });
    }

    if (!user.username) {
      user.username = await createUniqueUsername(user.name);
      await user.save();
    }

    const token = createToken(user);

    return res.json({
      token,
      user: {
        id: user._id,
        name: user.name,
        username: user.username,
        email: user.email
      }
    });

  } catch (error) {
    console.error("LOGIN ERROR:", error);
    return res.status(500).json({
      message: "Could not log in"
    });
  }
});

module.exports = router;
