const mongoose = require('mongoose');

const groupSchema = new mongoose.Schema({
  name: { type: String, required: true, trim: true, maxlength: 80 },
  createdBy: { type: String, required: true },
  members: [{
    userId: { type: String, required: true },
    username: { type: String, required: true },
  }],
}, { timestamps: true });

groupSchema.index({ 'members.userId': 1 });

module.exports = mongoose.models.Group || mongoose.model('Group', groupSchema);
