const mongoose = require('mongoose');

const callHistorySchema = new mongoose.Schema({
  callerId: { type: String, required: true, index: true },
  receiverId: { type: String, required: true, index: true },
  callerUsername: { type: String, required: true },
  receiverUsername: { type: String, required: true },
  callType: { type: String, enum: ['audio', 'video'], default: 'video' },
  // missed   -> never answered, caller gave up / receiver didn't respond
  // declined -> receiver explicitly rejected it
  // answered -> call connected, then ended
  status: { type: String, enum: ['missed', 'declined', 'answered'], required: true },
  startTime: { type: Date, required: true },
  endTime: { type: Date },
  duration: { type: Number, default: 0 }, // seconds, only meaningful when answered
}, { timestamps: true });

callHistorySchema.index({ callerId: 1, startTime: -1 });
callHistorySchema.index({ receiverId: 1, startTime: -1 });

module.exports = mongoose.models.CallHistory || mongoose.model('CallHistory', callHistorySchema);