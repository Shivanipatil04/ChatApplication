const mongoose = require('mongoose');

const userSchema = new mongoose.Schema({
  name: { type: String, required: true, trim: true },
  username: { type: String, trim: true, lowercase: true, unique: true, sparse: true },
  email: { type: String, required: true, trim: true, lowercase: true, unique: true },
  password: { type: String, required: true },
  phone: { type: String, default: '' },
  bio: { type: String, default: '', maxlength: 500 },
  avatar: { type: String, default: '' }, // base64 data URL stored in MongoDB
  lastSeen: { type: Date, default: Date.now },
  // userIds that this user has blocked
  blockedUsers: { type: [String], default: [] },
  archivedChats: { type: [String], default: [] }, // "direct:<id>" or "group:<id>"
  pinnedChats: { type: [String], default: [] },   // "direct:<id>" or "group:<id>", max 3
  friends: [{
    userId: { type: String, required: true },
    username: { type: String, required: true },
    name: { type: String, default: '' },
    addedAt: { type: Date, default: Date.now },
  }],
}, { timestamps: true });

module.exports = mongoose.models.User || mongoose.model('User', userSchema);