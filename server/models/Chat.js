const mongoose = require('mongoose');

const reactionSchema = new mongoose.Schema({
  userId: { type: String, required: true },
  emoji: { type: String, required: true },
}, { _id: false });

const chatSchema = new mongoose.Schema({
  senderId: { type: String, required: true, index: true },
  recipientId: { type: String, required: true, index: true },
  user: { type: String, required: true },
  msg: { type: String, default: '' },
  timeStamp: { type: String, required: true },

  // 'text' | 'call' | 'audio' | 'image' | 'file' | 'location' | 'contact' | 'poll'
  type: { type: String, enum: ['text', 'call', 'audio', 'image', 'file', 'location', 'contact', 'poll'], default: 'text' },

  // call log
  callInfo: {
    callType: { type: String, enum: ['audio', 'video'] },
    status: { type: String, enum: ['missed', 'declined', 'answered'] },
    duration: { type: Number, default: 0 },
  },

  // poll
  poll: {
    question: { type: String },
    options: [{
      id: { type: String },
      text: { type: String },
      votes: { type: [String], default: [] }, // array of userIds
    }],
    allowMultiple: { type: Boolean, default: false },
    closed: { type: Boolean, default: false },
  },

  // voice message
  audioData: { type: String },

  // image / file
  fileData: { type: String },
  fileName: { type: String },
  fileMime: { type: String },
  fileSize: { type: Number },

  // location
  location: {
    lat: { type: Number },
    lng: { type: Number },
  },

  // contact card
  contactShare: {
    id: { type: String },
    username: { type: String },
  },

  // reply-to quote
  replyTo: {
    messageId: { type: String },
    senderId: { type: String },
    senderName: { type: String },
    text: { type: String },    // preview text of the quoted message
    type: { type: String },    // quoted message type (text/image/audio/etc.)
  },

  // message edit
  editedAt: { type: Date },

  // reactions: [{ userId, emoji }] — one emoji per user, replace if user reacts again
  reactions: { type: [reactionSchema], default: [] },

  // pinned in conversation
  isPinned: { type: Boolean, default: false },
  pinnedBy: { type: String },
  pinnedAt: { type: Date },

  delivered: { type: Boolean, default: false },
  read: { type: Boolean, default: false },
  starredBy: { type: [String], default: [] },

  // delete-for-me: userIds who should no longer see this message
  deletedFor: { type: [String], default: [] },
  // delete-for-everyone
  deletedForEveryone: { type: Boolean, default: false },
});

chatSchema.index({ senderId: 1, recipientId: 1, timeStamp: 1 });

module.exports = mongoose.models.Chat || mongoose.model('Chat', chatSchema);