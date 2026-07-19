const mongoose = require('mongoose');

const chatSchema = new mongoose.Schema({
  senderId: { type: String, required: true, index: true },
  recipientId: { type: String, required: true, index: true },
  user: { type: String, required: true },
  msg: { type: String, default: '' },
  timeStamp: { type: String, required: true },

  // 'text' | 'call' (call-log entry) | 'audio' (voice message) | 'image' | 'file' | 'location' | 'contact'
  type: { type: String, enum: ['text', 'call', 'audio', 'image', 'file', 'location', 'contact'], default: 'text' },

  // populated only when type === 'call'
  callInfo: {
    callType: { type: String, enum: ['audio', 'video'] },
    status: { type: String, enum: ['missed', 'declined', 'answered'] },
    duration: { type: Number, default: 0 },
  },

  // populated only when type === 'audio' (base64 data URL, e.g. "data:audio/webm;base64,...")
  audioData: { type: String },

  // populated only when type === 'image' | 'file' (base64 data URL + metadata)
  fileData: { type: String },
  fileName: { type: String },
  fileMime: { type: String },

  // populated only when type === 'location'
  location: {
    lat: { type: Number },
    lng: { type: Number },
  },

  // populated only when type === 'contact' (a shared friend card)
  contactShare: {
    id: { type: String },
    username: { type: String },
  },

  // true when the recipient was online (their socket connected) at send time — powers the gray double-tick
  delivered: { type: Boolean, default: false },
  // read receipt: true once the recipient has opened this conversation past this message
  read: { type: Boolean, default: false },

  // delete-for-me: userIds who should no longer see this message
  deletedFor: { type: [String], default: [] },
  // delete-for-everyone: message is tombstoned for both sides
  deletedForEveryone: { type: Boolean, default: false },
});

chatSchema.index({ senderId: 1, recipientId: 1, timeStamp: 1 });

module.exports = mongoose.models.Chat || mongoose.model('Chat', chatSchema);