const express = require('express');
const router = express.Router();

router.post('/register', (req, res) => {
  const { name, email, password } = req.body;

  if (!name || !email || !password) {
    return res.status(400).json({ msg: 'Please fill all fields' });
  }

  return res.status(200).json({ msg: 'Registration successful' });
});

router.post('/login', (req, res) => {
  const { email, password } = req.body;

  if (!email || !password) {
    return res.status(400).json({ msg: 'Please fill all fields' });
  }

  return res.status(200).json({ msg: 'Login successful' });
});

module.exports = router;
