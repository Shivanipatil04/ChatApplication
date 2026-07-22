const mongoose = require('mongoose');

const participantSchema = new mongoose.Schema({
  userId:   { type: String, required: true },
  username: { type: String, required: true },
  name:     { type: String, default: '' },
  role:     { type: String, enum: ['host', 'co-host', 'attendee'], default: 'attendee' },
  joinedAt: { type: Date },
  leftAt:   { type: Date },
  micMuted: { type: Boolean, default: false },
  camOff:   { type: Boolean, default: false },
}, { _id: false });

const meetingSchema = new mongoose.Schema({
  meetingId:   { type: String, required: true, unique: true, index: true }, // human-readable e.g. "abc-1234-xyz"
  passcode:    { type: String, default: '' },          // optional 6-digit
  title:       { type: String, default: 'My Meeting' },
  hostId:      { type: String, required: true, index: true },
  hostName:    { type: String, required: true },
  scheduledAt: { type: Date, default: null },          // null = instant meeting
  recurring:   { type: String, enum: ['none','daily','weekly','monthly'], default: 'none' },
  status:      { type: String, enum: ['waiting','active','ended'], default: 'waiting' },
  locked:      { type: Boolean, default: false },
  waitingRoom: { type: Boolean, default: true },
  participants:       [participantSchema],
  waitingParticipants:[participantSchema],             // people waiting for host approval
  chatEnabled: { type: Boolean, default: true },
  hostOnlyInvite: { type: Boolean, default: false }, // when true, only host can add participants
  startedAt:   { type: Date },
  endedAt:     { type: Date },
}, { timestamps: true });

module.exports = mongoose.models.Meeting || mongoose.model('Meeting', meetingSchema);
