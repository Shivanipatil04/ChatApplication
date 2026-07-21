const mongoose = require('mongoose');

const statusSchema = new mongoose.Schema({
  userId: { type: String, required: true, index: true },
  text: { type: String, default: '' },
  emoji: { type: String, default: '' },
  bgColor: { type: String, default: '#128C7E' },
  viewers: { type: [String], default: [] }, // userIds who viewed
  createdAt: { type: Date, default: Date.now, expires: 86400 }, // auto-delete after 24h
});

module.exports = mongoose.model('Status', statusSchema);
