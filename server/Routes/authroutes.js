const express = require('express');
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');
const nodemailer = require('nodemailer');
const { JWT_SECRET, auth } = require('../middleware/auth');
const User = require('../models/User');

const router = express.Router();

// In-memory OTP store: email -> { otp, expiresAt }
// For production, use Redis or a MongoDB OTP model.
const otpStore = new Map();

// ---- Nodemailer transporter (Gmail) ----
const transporter = nodemailer.createTransport({
  service: 'gmail',
  auth: {
    user: process.env.GMAIL_USER,
    pass: process.env.GMAIL_APP_PASSWORD,
  },
});

async function sendOtpEmail(toEmail, otp) {
  await transporter.sendMail({
    from: `"ChatApp" <${process.env.GMAIL_USER}>`,
    to: toEmail,
    subject: 'Your ChatApp Password Reset OTP',
    html: `
      <div style="font-family:sans-serif;max-width:480px;margin:auto;padding:32px;border:1px solid #e5e7eb;border-radius:12px;">
        <h2 style="color:#4f46e5;">Password Reset</h2>
        <p>Use the OTP below to reset your ChatApp password. It expires in <strong>10 minutes</strong>.</p>
        <div style="font-size:36px;font-weight:700;letter-spacing:8px;color:#4f46e5;padding:16px 0;">${otp}</div>
        <p style="color:#6b7280;font-size:13px;">If you did not request this, please ignore this email.</p>
      </div>
    `,
  });
}

// ---- Helpers ----
async function createUniqueUsername(name) {
  const base = name.toLowerCase().replace(/[^a-z0-9]/g, '').slice(0, 16) || 'user';
  let username;
  do {
    username = `${base}${Math.floor(1000 + Math.random() * 9000)}`;
  } while (await User.exists({ username }));
  return username;
}

function createToken(user, rememberMe = false) {
  return jwt.sign(
    { userId: user._id.toString(), name: user.name, username: user.username, email: user.email },
    JWT_SECRET,
    { expiresIn: rememberMe ? '30d' : '24h' },
  );
}

// ---- Register ----
router.post('/register', async (req, res) => {
  const { name, email, password } = req.body;
  if (!name?.trim() || !email?.trim() || !password)
    return res.status(400).json({ message: 'Name, email, and password are required' });
  if (password.length < 6)
    return res.status(400).json({ message: 'Password must be at least 6 characters long' });

  try {
    const normalizedEmail = email.trim().toLowerCase();
    if (await User.exists({ email: normalizedEmail }))
      return res.status(409).json({ message: 'An account with this email already exists' });
    const hashedPassword = await bcrypt.hash(password, 12);
    const username = await createUniqueUsername(name.trim());
    await User.create({ name: name.trim(), username, email: normalizedEmail, password: hashedPassword });
    return res.status(201).json({ message: 'Account created. Please log in.' });
  } catch (error) {
    console.error('Registration error:', error);
    return res.status(500).json({ message: 'Could not create account' });
  }
});

// ---- Login ----
router.post('/login', async (req, res) => {
  const { email, password, rememberMe } = req.body;
  if (!email?.trim() || !password)
    return res.status(400).json({ message: 'Email and password are required' });

  try {
    const user = await User.findOne({ email: email.trim().toLowerCase() });
    const validPassword = user && await bcrypt.compare(password, user.password);
    if (!validPassword)
      return res.status(401).json({ message: 'Invalid email or password' });
    if (!user.username) {
      user.username = await createUniqueUsername(user.name);
      await user.save();
    }
    return res.json({
      token: createToken(user, !!rememberMe),
      user: { id: user._id.toString(), name: user.name, username: user.username, email: user.email, avatar: user.avatar || '' },
    });
  } catch (error) {
    console.error('Login error:', error);
    return res.status(500).json({ message: 'Could not log in' });
  }
});

// ---- Forgot Password — send OTP ----
router.post('/forgot-password', async (req, res) => {
  const { email } = req.body;
  if (!email?.trim()) return res.status(400).json({ message: 'Email is required' });

  try {
    const user = await User.findOne({ email: email.trim().toLowerCase() }).select('email');
    // Always return success to avoid email enumeration attacks
    if (!user) return res.json({ message: 'If an account exists, an OTP has been sent.' });

    const otp = String(Math.floor(100000 + Math.random() * 900000)); // 6-digit
    otpStore.set(user.email, { otp, expiresAt: Date.now() + 10 * 60 * 1000 });

    await sendOtpEmail(user.email, otp);
    return res.json({ message: 'OTP sent to your email.' });
  } catch (error) {
    console.error('Forgot password error:', error);
    return res.status(500).json({ message: 'Could not send OTP. Check your Gmail credentials in .env.' });
  }
});

// ---- Verify OTP ----
router.post('/verify-otp', async (req, res) => {
  const { email, otp } = req.body;
  if (!email?.trim() || !otp) return res.status(400).json({ message: 'Email and OTP are required' });

  const normalizedEmail = email.trim().toLowerCase();
  const entry = otpStore.get(normalizedEmail);
  if (!entry || entry.otp !== String(otp).trim() || Date.now() > entry.expiresAt) {
    return res.status(400).json({ message: 'Invalid or expired OTP' });
  }

  // Mark OTP as verified (keep in store until reset completes)
  entry.verified = true;
  return res.json({ message: 'OTP verified.' });
});

// ---- Reset Password ----
router.post('/reset-password', async (req, res) => {
  const { email, otp, newPassword } = req.body;
  if (!email?.trim() || !otp || !newPassword)
    return res.status(400).json({ message: 'Email, OTP, and new password are required' });
  if (newPassword.length < 6)
    return res.status(400).json({ message: 'Password must be at least 6 characters long' });

  const normalizedEmail = email.trim().toLowerCase();
  const entry = otpStore.get(normalizedEmail);
  if (!entry || entry.otp !== String(otp).trim() || Date.now() > entry.expiresAt || !entry.verified) {
    return res.status(400).json({ message: 'Invalid or expired OTP. Please restart the reset flow.' });
  }

  try {
    const user = await User.findOne({ email: normalizedEmail });
    if (!user) return res.status(404).json({ message: 'User not found' });
    user.password = await bcrypt.hash(newPassword, 12);
    await user.save();
    otpStore.delete(normalizedEmail);
    return res.json({ message: 'Password reset successfully. Please log in.' });
  } catch (error) {
    console.error('Reset password error:', error);
    return res.status(500).json({ message: 'Could not reset password' });
  }
});

// ---- Change Password (authenticated) ----
router.post('/change-password', auth, async (req, res) => {
  const { currentPassword, newPassword } = req.body;
  if (!currentPassword || !newPassword)
    return res.status(400).json({ message: 'Current and new passwords are required' });
  if (newPassword.length < 6)
    return res.status(400).json({ message: 'New password must be at least 6 characters long' });
  if (currentPassword === newPassword)
    return res.status(400).json({ message: 'New password must differ from current password' });

  try {
    const user = await User.findById(req.user.userId);
    if (!user) return res.status(404).json({ message: 'User not found' });
    const valid = await bcrypt.compare(currentPassword, user.password);
    if (!valid) return res.status(401).json({ message: 'Current password is incorrect' });
    user.password = await bcrypt.hash(newPassword, 12);
    await user.save();
    return res.json({ message: 'Password changed successfully.' });
  } catch (error) {
    console.error('Change password error:', error);
    return res.status(500).json({ message: 'Could not change password' });
  }
});

module.exports = router;
