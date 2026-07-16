const mongoose = require('mongoose');

const userSchema = new mongoose.Schema({
  name: { type: String, required: true, trim: true },
  username: { type: String, trim: true, lowercase: true, unique: true, sparse: true },
  email: { type: String, required: true, trim: true, lowercase: true, unique: true },
  password: { type: String, required: true },
  friends: [{
    userId: { type: String, required: true },
    username: { type: String, required: true },
    addedAt: { type: Date, default: Date.now },
  }],
}, { timestamps: true });

module.exports = mongoose.models.User || mongoose.model('User', userSchema);
