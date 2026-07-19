const mongoose = require('mongoose');

const groupMessageSchema = new mongoose.Schema({
  groupId: { type: String, required: true, index: true },
  senderId: { type: String, required: true },
  username: { type: String, required: true },
  msg: { type: String, default: '' },
  timeStamp: { type: String, required: true },

  type: { type: String, enum: ['text', 'audio', 'image', 'file', 'location', 'contact'], default: 'text' },
  audioData: { type: String },

  fileData: { type: String },
  fileName: { type: String },
  fileMime: { type: String },

  location: {
    lat: { type: Number },
    lng: { type: Number },
  },

  contactShare: {
    id: { type: String },
    username: { type: String },
  },

  deletedFor: { type: [String], default: [] },
  deletedForEveryone: { type: Boolean, default: false },
});

groupMessageSchema.index({ groupId: 1, timeStamp: 1 });

module.exports = mongoose.models.GroupMessage || mongoose.model('GroupMessage', groupMessageSchema);