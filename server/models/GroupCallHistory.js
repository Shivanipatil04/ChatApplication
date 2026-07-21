const mongoose = require('mongoose');

const participantSchema = new mongoose.Schema({
  userId: { type: String, required: true },
  username: { type: String, required: true },
  // answered -> actually joined the mesh   missed -> invited, never responded   declined -> explicitly declined
  status: { type: String, enum: ['answered', 'missed', 'declined'], required: true },
  duration: { type: Number, default: 0 }, // seconds spent in the call, only meaningful when answered
}, { _id: false });

const groupCallHistorySchema = new mongoose.Schema({
  callId: { type: String, required: true, index: true },
  groupId: { type: String, default: null, index: true }, // null for ad-hoc (non-group) calls
  hostId: { type: String, required: true, index: true },
  hostUsername: { type: String, required: true },
  callType: { type: String, enum: ['audio', 'video'], default: 'video' },
  participants: [participantSchema],
  startTime: { type: Date, required: true },
  endTime: { type: Date },
}, { timestamps: true });

groupCallHistorySchema.index({ 'participants.userId': 1, startTime: -1 });

module.exports = mongoose.models.GroupCallHistory || mongoose.model('GroupCallHistory', groupCallHistorySchema);