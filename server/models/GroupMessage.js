const mongoose = require('mongoose');

const reactionSchema = new mongoose.Schema({
  userId: { type: String, required: true },
  emoji: { type: String, required: true },
}, { _id: false });

const groupMessageSchema = new mongoose.Schema({
  groupId: { type: String, required: true, index: true },
  senderId: { type: String, required: true },
  username: { type: String, required: true },
  msg: { type: String, default: '' },
  timeStamp: { type: String, required: true },

  type: { type: String, enum: ['text', 'call', 'audio', 'image', 'file', 'location', 'contact', 'poll'], default: 'text' },

  // poll
  poll: {
    question: { type: String },
    options: [{
      id: { type: String },
      text: { type: String },
      votes: { type: [String], default: [] },
    }],
    allowMultiple: { type: Boolean, default: false },
    closed: { type: Boolean, default: false },
  },
  audioData: { type: String },

  fileData: { type: String },
  fileName: { type: String },
  fileMime: { type: String },
  fileSize: { type: Number },

  location: {
    lat: { type: Number },
    lng: { type: Number },
  },

  contactShare: {
    id: { type: String },
    username: { type: String },
  },

  // call log (group calls)
  callInfo: {
    callType: { type: String, enum: ['audio', 'video'] },
    status: { type: String, enum: ['missed', 'declined', 'answered'] },
    duration: { type: Number, default: 0 },
  },

  // reply-to quote
  replyTo: {
    messageId: { type: String },
    senderId: { type: String },
    senderName: { type: String },
    text: { type: String },
    type: { type: String },
  },

  // message edit
  editedAt: { type: Date },

  // reactions
  reactions: { type: [reactionSchema], default: [] },

  // pinned in group
  isPinned: { type: Boolean, default: false },
  pinnedBy: { type: String },
  pinnedAt: { type: Date },

  starredBy: { type: [String], default: [] },

  deletedFor: { type: [String], default: [] },
  deletedForEveryone: { type: Boolean, default: false },
});

groupMessageSchema.index({ groupId: 1, timeStamp: 1 });

module.exports = mongoose.models.GroupMessage || mongoose.model('GroupMessage', groupMessageSchema);