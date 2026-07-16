const mongoose = require('mongoose');

const chatSchema = new mongoose.Schema({
  senderId: { type: String, required: true, index: true },
  recipientId: { type: String, required: true, index: true },
  user: { type: String, required: true },
  msg: { type: String, required: true },
  timeStamp: { type: String, required: true },
});

chatSchema.index({ senderId: 1, recipientId: 1, timeStamp: 1 });

module.exports = mongoose.models.Chat || mongoose.model('Chat', chatSchema);
