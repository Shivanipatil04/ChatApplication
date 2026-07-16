const mongoose = require('mongoose');

const groupMessageSchema = new mongoose.Schema({
  groupId: { type: String, required: true, index: true },
  senderId: { type: String, required: true },
  username: { type: String, required: true },
  msg: { type: String, required: true },
  timeStamp: { type: String, required: true },
});

groupMessageSchema.index({ groupId: 1, timeStamp: 1 });

module.exports = mongoose.models.GroupMessage || mongoose.model('GroupMessage', groupMessageSchema);
