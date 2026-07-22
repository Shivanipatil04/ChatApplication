require('dotenv').config();

const express = require('express');
const cors = require('cors');
const http = require('http');
const { Server } = require('socket.io');
const mongoose = require('mongoose');
const helmet = require('helmet');
const rateLimit = require('express-rate-limit');
const authRoutes = require('./Routes/authroutes');
// E2EE integration point
const keyRoutes  = require('./routes/keyRoutes');
const { auth, authenticateToken } = require('./middleware/auth');
const User = require('./models/User');
const Chat = require('./models/Chat');
const Group = require('./models/Group');
const GroupMessage = require('./models/GroupMessage');
const CallHistory = require('./models/CallHistory');
const GroupCallHistory = require('./models/GroupCallHistory');
const Status = require('./models/Status');
const Meeting = require('./models/Meeting');

// ---- Cloudinary + Multer setup ----
const cloudinary = require('cloudinary').v2;
const multer = require('multer');

cloudinary.config({
    cloud_name: process.env.CLOUDINARY_CLOUD_NAME,
    api_key:    process.env.CLOUDINARY_API_KEY,
    api_secret: process.env.CLOUDINARY_API_SECRET,
});

// Warn at startup if credentials are missing — helps catch misconfigured deployments early
if (!process.env.CLOUDINARY_CLOUD_NAME || process.env.CLOUDINARY_CLOUD_NAME === 'your_cloud_name') {
    console.warn('[cloudinary] WARNING: CLOUDINARY_CLOUD_NAME is not set. File uploads will fail.');
}
if (!process.env.CLOUDINARY_API_KEY || process.env.CLOUDINARY_API_KEY === 'your_api_key') {
    console.warn('[cloudinary] WARNING: CLOUDINARY_API_KEY is not set. File uploads will fail.');
}
if (!process.env.CLOUDINARY_API_SECRET || process.env.CLOUDINARY_API_SECRET === 'your_api_secret') {
    console.warn('[cloudinary] WARNING: CLOUDINARY_API_SECRET is not set. File uploads will fail.');
}

// Determine the correct Cloudinary resource_type from the file's MIME type
const resourceTypeFor = (mimetype = '') => {
    if (mimetype.startsWith('image/')) return 'image';
    if (mimetype.startsWith('video/')) return 'video';
    if (mimetype.startsWith('audio/')) return 'video'; // Cloudinary stores audio under 'video'
    return 'raw'; // PDF, DOCX, etc.
};

// Memory storage — we stream the buffer directly to Cloudinary
const multerMemory = multer({
    storage: multer.memoryStorage(),
    limits: { fileSize: 20 * 1024 * 1024 }, // 20 MB hard cap
    fileFilter: (_req, file, cb) => {
        // Allow images, video, audio, and common documents
        const allowed = [
            'image/', 'video/', 'audio/',
            'application/pdf',
            'application/msword',
            'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
            'application/vnd.ms-excel',
            'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
            'application/vnd.ms-powerpoint',
            'application/vnd.openxmlformats-officedocument.presentationml.presentation',
            'text/plain',
            'application/zip',
        ];
        const ok = allowed.some((t) => file.mimetype.startsWith(t));
        cb(ok ? null : new Error('File type not allowed'), ok);
    },
});

const app = express();
const server = http.createServer(app);

const CLIENT_URL = process.env.CLIENT_URL || "http://localhost:5173";

const corsOptions = {
  origin: CLIENT_URL,
  credentials: true,
  methods: ["GET", "POST", "PATCH", "DELETE"],
};

const io = new Server(server, {
  cors: {
    origin: CLIENT_URL,
    credentials: true,
    methods: ["GET", "POST", "PATCH", "DELETE"],
  },
  // audio/image/file messages now send a Cloudinary URL instead of base64 —
  // the socket payload is tiny. Keep a small buffer just in case.
  maxHttpBufferSize: 1 * 1024 * 1024,
});

app.use(helmet({ contentSecurityPolicy: false }));
app.use(cors(corsOptions));
app.use(express.json({ limit: '10mb' }));

// Rate limiting — auth endpoints get a stricter cap
const authLimiter = rateLimit({ windowMs: 15 * 60 * 1000, max: 20, message: { message: 'Too many requests, please try again later.' } });
const apiLimiter = rateLimit({ windowMs: 1 * 60 * 1000, max: 200 });
app.use('/api/auth', authLimiter, authRoutes);
app.use('/api', apiLimiter);
// E2EE integration point
app.use('/api/keys', keyRoutes);

// ============================================================
// UPLOAD ROUTE  — POST /api/upload
// Accepts a single file, streams it to Cloudinary via buffer,
// returns { url, resourceType, originalName }.
// Location and contact shares never hit this endpoint — they
// are plain JSON sent directly over the socket.
// ============================================================
app.post('/api/upload', auth, multerMemory.single('file'), async (req, res) => {
    if (!req.file) return res.status(400).json({ message: 'No file provided' });

    // Fail fast with a clear message if credentials are not configured
    if (!process.env.CLOUDINARY_CLOUD_NAME || process.env.CLOUDINARY_CLOUD_NAME === 'your_cloud_name') {
        return res.status(500).json({ message: 'Cloudinary is not configured. Add CLOUDINARY_CLOUD_NAME, CLOUDINARY_API_KEY, and CLOUDINARY_API_SECRET to your environment variables.' });
    }

    const resType = resourceTypeFor(req.file.mimetype);

    try {
        // Wrap the stream-based Cloudinary uploader in a Promise
        const result = await new Promise((resolve, reject) => {
            const uploadStream = cloudinary.uploader.upload_stream(
                {
                    resource_type: resType,
                    folder: 'chatapp',
                    // Keep original filename (sanitised) so downloads are readable
                    public_id: `${Date.now()}_${req.file.originalname.replace(/[^a-zA-Z0-9._-]/g, '_')}`,
                    // Deliver as attachment so browsers download docs instead of trying to render
                    ...(resType === 'raw' && { type: 'upload', flags: 'attachment' }),
                },
                (err, result) => (err ? reject(err) : resolve(result)),
            );
            uploadStream.end(req.file.buffer);
        });

        res.json({
            url: result.secure_url,
            resourceType: resType,
            originalName: req.file.originalname,
            mimeType: req.file.mimetype,
            publicId: result.public_id,
        });
    } catch (err) {
        console.error('[cloudinary] upload failed:', err?.message || err);
        const msg = err?.message?.includes('Invalid') || err?.message?.includes('credentials')
            ? 'Invalid Cloudinary credentials. Check CLOUDINARY_CLOUD_NAME, API_KEY, and API_SECRET in server/.env'
            : err?.message || 'Upload failed';
        res.status(500).json({ message: msg });
    }
});

mongoose
  .connect(process.env.MONGO_URI)
  .then(() => console.log("MongoDB connected"))
  .catch((err) => console.error("MongoDB connection error:", err));

io.use((socket, next) => {
    try {
        const token = socket.handshake.auth?.token || socket.handshake.headers?.authorization?.replace('Bearer ', '');
        socket.user = authenticateToken(token);
        next();
    } catch (err) {
        console.error('Socket auth failed:', err.message);
        next(new Error('Authentication required'));
    }
});

// userId -> Set of active socket ids (a user can have multiple tabs/devices open)
const onlineUsers = new Map();

// key `${callerId}:${receiverId}` -> { startTime, callType, answered, answeredAt, declined }
const pendingCalls = new Map();

// key: callId -> {
//   hostId, hostUsername, groupId, callType,
//   participants: Map<userId, username>, invited: Set<userId>, declinedIds: Set<userId>,
//   joinTimes: Map<userId, timestampMs>, startTime: timestampMs,
// }
const activeGroupCalls = new Map();
const MAX_GROUP_CALL_PARTICIPANTS = 4;

const MESSAGE_TYPES = ['audio', 'image', 'file', 'location', 'contact'];
// fileData/audioData are now Cloudinary URLs — size check is effectively a no-op
// but kept as a guard against someone sending raw base64 directly.
const MAX_ATTACHMENT_BYTES = 6 * 1024 * 1024;

const broadcastPresence = async (userId, online) => {
    try {
        const current = await User.findById(userId).select('friends').lean();
        const lastSeen = new Date().toISOString();
        if (!online) await User.findByIdAndUpdate(userId, { lastSeen: new Date() });
        (current?.friends || []).forEach((friend) => {
            io.to(friend.userId).emit('presence', { userId, online, lastSeen });
        });
    } catch (err) {
        console.error('Could not broadcast presence:', err);
    }
};

// Saves a CallHistory row + a visible "call" chat message, then emits both to caller & receiver.
const finalizeCall = async (callerId, receiverId, entry, { declinedByReceiver = false } = {}) => {
    try {
        const [caller, receiver] = await Promise.all([
            User.findById(callerId).select('username'),
            User.findById(receiverId).select('username'),
        ]);
        if (!caller || !receiver) return;

        const now = Date.now();
        let status = 'missed';
        let duration = 0;
        if (entry.answered) {
            status = 'answered';
            duration = Math.max(0, Math.round((now - entry.answeredAt) / 1000));
        } else if (declinedByReceiver) {
            status = 'declined';
        }

        await CallHistory.create({
            callerId, receiverId,
            callerUsername: caller.username, receiverUsername: receiver.username,
            callType: entry.callType || 'video',
            status,
            startTime: new Date(entry.startTime),
            endTime: new Date(now),
            duration,
        });

        const timeStamp = new Date().toISOString();
        const chatDoc = await Chat.create({
            senderId: callerId,
            recipientId: receiverId,
            user: caller.username,
            msg: '',
            timeStamp,
            type: 'call',
            callInfo: { callType: entry.callType || 'video', status, duration },
        });

        const payload = { ...chatDoc.toObject(), id: chatDoc._id.toString() };
        io.to(callerId).to(receiverId).emit('msg', payload);
        io.to(callerId).to(receiverId).emit('call-history-updated');
    } catch (err) {
        console.error('Could not finalize call history:', err);
    }
};

// Saves a GroupCallHistory row covering every invited person (answered/missed/declined),
// then drops a visible "call" log — into the group chat for group-scoped calls, or into each
// 1:1 conversation with the host for ad-hoc calls. Called once, right when a call actually ends
// (last participant leaves, or the whole thing disconnects), never per-participant-leave.
const finalizeGroupCall = async (callId, call) => {
    try {
        const now = Date.now();
        const participantEntries = [];
        for (const [uid, username] of call.participants.entries()) {
            const joinedAt = call.joinTimes.get(uid) || call.startTime;
            participantEntries.push({ userId: uid, username, status: 'answered', duration: Math.max(0, Math.round((now - joinedAt) / 1000)) });
        }
        for (const uid of call.invited) {
            const invitedUser = await User.findById(uid).select('username').lean();
            participantEntries.push({
                userId: uid,
                username: invitedUser?.username || 'Unknown',
                status: call.declinedIds.has(uid) ? 'declined' : 'missed',
                duration: 0,
            });
        }
        if (!participantEntries.length) return;

        await GroupCallHistory.create({
            callId,
            groupId: call.groupId,
            hostId: call.hostId,
            hostUsername: call.hostUsername,
            callType: call.callType,
            participants: participantEntries,
            startTime: new Date(call.startTime),
            endTime: new Date(now),
        });

        const anyoneElseAnswered = participantEntries.some((p) => p.status === 'answered' && p.userId !== call.hostId);
        const summaryStatus = anyoneElseAnswered
            ? 'answered'
            : participantEntries.every((p) => p.status === 'missed') ? 'missed' : 'declined';
        const timeStamp = new Date().toISOString();

        if (call.groupId) {
            const saved = await GroupMessage.create({
                groupId: call.groupId,
                senderId: call.hostId,
                username: call.hostUsername,
                msg: '',
                timeStamp,
                type: 'call',
                callInfo: { callType: call.callType, status: summaryStatus, duration: 0 },
            });
            io.to(`group:${call.groupId}`).emit('group-msg', { ...saved.toObject(), id: saved._id.toString() });
        } else {
            for (const entry of participantEntries) {
                if (entry.userId === call.hostId) continue;
                const chatDoc = await Chat.create({
                    senderId: call.hostId,
                    recipientId: entry.userId,
                    user: call.hostUsername,
                    msg: '',
                    timeStamp,
                    type: 'call',
                    callInfo: { callType: call.callType, status: entry.status, duration: entry.duration },
                });
                const payload = { ...chatDoc.toObject(), id: chatDoc._id.toString() };
                io.to(call.hostId).to(entry.userId).emit('msg', payload);
            }
        }

        [...call.participants.keys(), ...call.invited].forEach((uid) => io.to(uid).emit('call-history-updated'));
    } catch (err) {
        console.error('[group-call] finalize error:', err);
    }
};

// One-way "does A block B" check against a lean user doc.
const hasBlocked = (userDoc, otherUserId) => (userDoc?.blockedUsers || []).includes(otherUserId);

// Preview text shown in the chat-list row / last-message line for any message type.
const previewFor = (message) => {
    if (!message) return '';
    switch (message.type) {
        case 'audio': return '🎤 Voice message';
        case 'image': return '📷 Photo';
        case 'file': return `📄 ${message.fileName || 'Document'}`;
        case 'location': return '📍 Location';
        case 'contact': return '👤 Contact';
        case 'poll': return `📊 ${message.poll?.question || 'Poll'}`;
        case 'call': {
            const isAudio = message.callInfo?.callType === 'audio';
            const type = isAudio ? 'voice' : 'video';
            if (message.callInfo?.status === 'missed') return `📞 Missed ${type} call`;
            if (message.callInfo?.status === 'declined') return `📞 Declined ${type} call`;
            return `📞 ${type.charAt(0).toUpperCase() + type.slice(1)} call`;
        }
        default: return message.msg || '';
    }
};

io.on('connection', (socket)=>{
    if (!socket.user?.userId) {
        socket.disconnect();
        return;
    }

    const userId = socket.user.userId;
    console.log(`User connected: ${socket.user.email}`);
    socket.join(userId);
    Group.find({ 'members.userId': userId }).select('_id').lean()
        .then((groups) => groups.forEach((group) => socket.join(`group:${group._id}`)))
        .catch((err) => console.error('Could not join group rooms:', err));

    // ---- Presence tracking ----
    if (!onlineUsers.has(userId)) onlineUsers.set(userId, new Set());
    onlineUsers.get(userId).add(socket.id);
    if (onlineUsers.get(userId).size === 1) broadcastPresence(userId, true);

    User.findById(userId).select('friends').lean()
        .then((current) => {
            const onlineFriendIds = (current?.friends || [])
                .map((friend) => friend.userId)
                .filter((id) => onlineUsers.has(id));
            socket.emit('presence-bulk', { onlineUserIds: onlineFriendIds });
        })
        .catch((err) => console.error('Could not load initial presence:', err));

    // ---- Typing indicator ----
    socket.on('typing', ({ recipientId, groupId, isTyping }) => {
        if (recipientId) {
            io.to(recipientId).emit('typing', { userId, isTyping });
        } else if (groupId) {
            socket.to(`group:${groupId}`).emit('typing', { userId, username: socket.user.username, groupId, isTyping });
        }
    });

    // ---- Direct message (text, voice note, image, file, location, or contact card) ----
    socket.on('msg', async ({ recipientId, message, type, audioData, fileData, fileName, fileMime, location, contactShare }) => {
        const resolvedType = MESSAGE_TYPES.includes(type) ? type : 'text';
        const text = typeof message === 'string' ? message.trim() : '';

        const attachmentSize = (audioData?.length || 0) + (fileData?.length || 0);
        if (attachmentSize > MAX_ATTACHMENT_BYTES) return;

        const hasPayload =
            (resolvedType === 'audio' && typeof audioData === 'string' && audioData.length > 0) ||
            ((resolvedType === 'image' || resolvedType === 'file') && typeof fileData === 'string' && fileData.length > 0) ||
            (resolvedType === 'location' && typeof location?.lat === 'number' && typeof location?.lng === 'number') ||
            (resolvedType === 'contact' && !!contactShare?.id);

        if ((resolvedType === 'text' && !text) || (resolvedType !== 'text' && !hasPayload) || !recipientId || recipientId === userId) return;

        try {
            const [sender, recipient] = await Promise.all([
                User.findById(userId).select('friends blockedUsers'),
                User.findById(recipientId).select('blockedUsers'),
            ]);
            const isFriend = sender?.friends.some((friend) => friend.userId === recipientId);
            if (!isFriend) return;
            if (hasBlocked(sender, recipientId) || hasBlocked(recipient, userId)) return;

            const chatData = {
                senderId: userId,
                recipientId,
                user: socket.user.name,
                msg: resolvedType === 'text' ? text : '',
                timeStamp: new Date().toISOString(),
                type: resolvedType,
                delivered: onlineUsers.has(recipientId),
                ...(resolvedType === 'audio' ? { audioData } : {}),
                ...((resolvedType === 'image' || resolvedType === 'file') ? { fileData, fileName, fileMime } : {}),
                ...(resolvedType === 'location' ? { location } : {}),
                ...(resolvedType === 'contact' ? { contactShare } : {}),
            };

            const chatmsg = new Chat(chatData);
            await chatmsg.save();
            const savedMessage = { ...chatmsg.toObject(), id: chatmsg._id.toString() };

            io.to(userId).to(recipientId).emit('msg', savedMessage);
        } catch (err) {
            console.error('Error for storage', err);
        }
    });

    // Marks every unread message FROM contactId TO the current user as read,
    // then tells the contact (if online) so they can flip their ticks to blue.
    socket.on('mark-read', async ({ contactId }) => {
        if (!contactId) return;
        try {
            const result = await Chat.updateMany(
                { senderId: contactId, recipientId: userId, read: false },
                { $set: { read: true } }
            );
            if (result.modifiedCount > 0) {
                io.to(contactId).emit('messages-read', { by: userId });
            }
        } catch (err) {
            console.error('Could not mark messages read:', err);
        }
    });

    socket.on('join-group', async ({ groupId }) => {
        const group = await Group.findOne({ _id: groupId, 'members.userId': userId }).select('_id');
        if (group) socket.join(`group:${groupId}`);
    });

    // ---- Group message (same type support as direct messages, minus call logs) ----
    socket.on('group-msg', async ({ groupId, message, type, audioData, fileData, fileName, fileMime, location, contactShare }) => {
        const resolvedType = MESSAGE_TYPES.includes(type) ? type : 'text';
        const text = typeof message === 'string' ? message.trim() : '';

        const attachmentSize = (audioData?.length || 0) + (fileData?.length || 0);
        if (attachmentSize > MAX_ATTACHMENT_BYTES) return;

        const hasPayload =
            (resolvedType === 'audio' && typeof audioData === 'string' && audioData.length > 0) ||
            ((resolvedType === 'image' || resolvedType === 'file') && typeof fileData === 'string' && fileData.length > 0) ||
            (resolvedType === 'location' && typeof location?.lat === 'number' && typeof location?.lng === 'number') ||
            (resolvedType === 'contact' && !!contactShare?.id);

        if ((resolvedType === 'text' && !text) || (resolvedType !== 'text' && !hasPayload) || !groupId) return;

        try {
            const group = await Group.findOne({ _id: groupId, 'members.userId': userId }).select('_id');
            if (!group) return;
            const saved = await GroupMessage.create({
                groupId,
                senderId: userId,
                username: socket.user.username,
                msg: resolvedType === 'text' ? text : '',
                timeStamp: new Date().toISOString(),
                type: resolvedType,
                ...(resolvedType === 'audio' ? { audioData } : {}),
                ...((resolvedType === 'image' || resolvedType === 'file') ? { fileData, fileName, fileMime } : {}),
                ...(resolvedType === 'location' ? { location } : {}),
                ...(resolvedType === 'contact' ? { contactShare } : {}),
            });
            io.to(`group:${groupId}`).emit('group-msg', { ...saved.toObject(), id: saved._id.toString() });
        } catch (err) {
            console.error('Could not save group message:', err);
        }
    });

    // ---- Poll: create (direct) ----
    socket.on('send-poll', async ({ recipientId, question, options, allowMultiple }) => {
        if (!recipientId || !question?.trim() || !Array.isArray(options) || options.length < 2) return;
        try {
            const [sender, recipient] = await Promise.all([
                User.findById(userId).select('friends blockedUsers username'),
                User.findById(recipientId).select('blockedUsers'),
            ]);
            const isFriend = sender?.friends.some((f) => f.userId === recipientId);
            if (!isFriend || hasBlocked(sender, recipientId) || hasBlocked(recipient, userId)) return;

            const pollOptions = options.map((text, i) => ({ id: `opt_${i}_${Date.now()}`, text: text.trim(), votes: [] }));
            const chatDoc = await Chat.create({
                senderId: userId,
                recipientId,
                user: socket.user.name,
                msg: '',
                timeStamp: new Date().toISOString(),
                type: 'poll',
                poll: { question: question.trim(), options: pollOptions, allowMultiple: !!allowMultiple, closed: false },
                delivered: onlineUsers.has(recipientId),
            });
            // Use lean-style plain object to avoid Mongoose ObjectId serialization issues
            const lean = await Chat.findById(chatDoc._id).lean();
            const payload = { ...lean, id: lean._id.toString() };
            io.to(userId).to(recipientId).emit('msg', payload);
        } catch (err) { console.error('Could not create poll:', err); }
    });

    // ---- Poll: create (group) ----
    socket.on('send-group-poll', async ({ groupId, question, options, allowMultiple }) => {
        if (!groupId || !question?.trim() || !Array.isArray(options) || options.length < 2) return;
        try {
            const group = await Group.findOne({ _id: groupId, 'members.userId': userId }).select('_id');
            if (!group) return;
            const pollOptions = options.map((text, i) => ({ id: `opt_${i}_${Date.now()}`, text: text.trim(), votes: [] }));
            const saved = await GroupMessage.create({
                groupId,
                senderId: userId,
                username: socket.user.username,
                msg: '',
                timeStamp: new Date().toISOString(),
                type: 'poll',
                poll: { question: question.trim(), options: pollOptions, allowMultiple: !!allowMultiple, closed: false },
            });
            // Use lean-style plain object to avoid Mongoose ObjectId serialization issues
            const lean = await GroupMessage.findById(saved._id).lean();
            const payload = { ...lean, id: lean._id.toString() };
            io.to(`group:${groupId}`).emit('group-msg', payload);
        } catch (err) { console.error('Could not create group poll:', err); }
    });

    // ---- Poll: vote (direct + group) ----
    socket.on('poll-vote', async ({ messageId, optionId, isGroup }) => {
        try {
            const Model = isGroup ? GroupMessage : Chat;
            const doc = await Model.findById(messageId);
            if (!doc || doc.type !== 'poll' || doc.poll?.closed) return;

            // Verify the voter is a participant
            if (isGroup) {
                const grp = await Group.findOne({ _id: doc.groupId, 'members.userId': userId }).select('_id');
                if (!grp) return;
            } else {
                if (doc.senderId !== userId && doc.recipientId !== userId) return;
            }

            const option = doc.poll.options.find((o) => o.id === optionId);
            if (!option) return;

            if (!doc.poll.allowMultiple) {
                // Remove user's vote from all options first (single-choice)
                doc.poll.options.forEach((o) => { o.votes = o.votes.filter((v) => v !== userId); });
            }

            // Toggle: if already voted for this option, remove the vote
            const alreadyVoted = option.votes.includes(userId);
            if (alreadyVoted) {
                option.votes = option.votes.filter((v) => v !== userId);
            } else {
                option.votes.push(userId);
            }

            doc.markModified('poll');
            await doc.save();

            const payload = { messageId, poll: doc.poll };
            if (isGroup) {
                io.to(`group:${doc.groupId}`).emit('poll-updated', payload);
            } else {
                io.to(doc.senderId).to(doc.recipientId).emit('poll-updated', payload);
            }
        } catch (err) { console.error('Could not record vote:', err); }
    });

    // ---- Poll: close (only sender can close) ----
    socket.on('poll-close', async ({ messageId, isGroup }) => {
        try {
            const Model = isGroup ? GroupMessage : Chat;
            const doc = await Model.findById(messageId);
            if (!doc || doc.type !== 'poll' || doc.senderId !== userId) return;
            doc.poll.closed = true;
            doc.markModified('poll');
            await doc.save();
            const payload = { messageId, poll: doc.poll };
            if (isGroup) {
                io.to(`group:${doc.groupId}`).emit('poll-updated', payload);
            } else {
                io.to(doc.senderId).to(doc.recipientId).emit('poll-updated', payload);
            }
        } catch (err) { console.error('Could not close poll:', err); }
    });

    // ---- Message delete (direct + group) ----
    socket.on('delete-message', async ({ messageId, isGroup, everyone }) => {        try {
            const Model = isGroup ? GroupMessage : Chat;
            const doc = await Model.findById(messageId);
            if (!doc) return;
            const isSender = doc.senderId === userId;

            if (everyone) {
                if (!isSender) return; // only the sender can delete for everyone
                doc.deletedForEveryone = true;
                doc.msg = '';
                doc.audioData = undefined;
                doc.fileData = undefined;
                await doc.save();
                if (isGroup) {
                    io.to(`group:${doc.groupId}`).emit('msg-deleted', { messageId, isGroup: true, everyone: true });
                } else {
                    io.to(doc.senderId).to(doc.recipientId).emit('msg-deleted', { messageId, isGroup: false, everyone: true });
                }
            } else {
                if (!doc.deletedFor.includes(userId)) {
                    doc.deletedFor.push(userId);
                    await doc.save();
                }
                // "delete for me" only affects the requester's own view
                socket.emit('msg-deleted', { messageId, isGroup: !!isGroup, everyone: false });
            }
        } catch (err) {
            console.error('Could not delete message:', err);
        }
    });

    // ---- WebRTC signaling handlers (1:1 calls) ----
    socket.on('call-user', async ({ targetUserId, offer, callType }) => {
        try {
            console.log(`[webrtc] call-user from ${userId} -> ${targetUserId}`);
            const [sender, target] = await Promise.all([
                User.findById(userId).select('friends username blockedUsers'),
                User.findById(targetUserId).select('blockedUsers'),
            ]);
            const blocked = hasBlocked(sender, targetUserId) || hasBlocked(target, userId);
            if (offer && !blocked && sender?.friends.some((friend) => friend.userId === targetUserId)) {
                pendingCalls.set(`${userId}:${targetUserId}`, {
                    startTime: Date.now(),
                    callType: callType === 'audio' ? 'audio' : 'video',
                    answered: false,
                    answeredAt: null,
                    declined: false,
                });
                console.log('[webrtc] forwarding incoming-call to', targetUserId);
                io.to(targetUserId).emit('incoming-call', { from: { id: userId, username: sender.username }, offer, callType });
            }
        } catch (err) {
            console.error('[webrtc] call-user error:', err);
        }
    });

    socket.on('call-answer', async ({ callerId, answer }) => {
        try {
            console.log(`[webrtc] call-answer from ${userId} -> ${callerId}`);
            const responder = await User.findById(userId).select('friends');
            if (callerId && answer && responder?.friends.some((friend) => friend.userId === callerId)) {
                const entry = pendingCalls.get(`${callerId}:${userId}`);
                if (entry) { entry.answered = true; entry.answeredAt = Date.now(); }
                console.log('[webrtc] forwarding call-answered to', callerId);
                io.to(callerId).emit('call-answered', { answer });
            }
        } catch (err) {
            console.error('[webrtc] call-answer error:', err);
        }
    });

    socket.on('ice-candidate', async ({ targetUserId, candidate }) => {
        try {
            const sender = await User.findById(userId).select('friends');
            if (targetUserId && candidate && sender?.friends.some((friend) => friend.userId === targetUserId)) {
                io.to(targetUserId).emit('ice-candidate', { candidate });
            }
        } catch (err) {
            console.error('[webrtc] ice-candidate error:', err);
        }
    });

    // ---- Reconnect-on-drop for 1:1 calls: plain SDP relay, no pendingCalls bookkeeping ----
    // (the initial call-user/call-answer pair already logged this call; a renegotiation
    // mid-call is just keeping the same call's media path alive, not a new call.)
    socket.on('renegotiate-offer', async ({ targetUserId, offer }) => {
        try {
            const sender = await User.findById(userId).select('friends');
            if (targetUserId && offer && sender?.friends.some((friend) => friend.userId === targetUserId)) {
                io.to(targetUserId).emit('renegotiate-offer', { fromUserId: userId, offer });
            }
        } catch (err) {
            console.error('[webrtc] renegotiate-offer error:', err);
        }
    });

    socket.on('renegotiate-answer', async ({ targetUserId, answer }) => {
        try {
            const sender = await User.findById(userId).select('friends');
            if (targetUserId && answer && sender?.friends.some((friend) => friend.userId === targetUserId)) {
                io.to(targetUserId).emit('renegotiate-answer', { fromUserId: userId, answer });
            }
        } catch (err) {
            console.error('[webrtc] renegotiate-answer error:', err);
        }
    });

    // Callee explicitly hits "Decline" on an unanswered incoming call
    socket.on('call-decline', ({ callerId }) => {
        const entry = pendingCalls.get(`${callerId}:${userId}`);
        if (entry) entry.declined = true;
        io.to(callerId).emit('call-ended');
        const key = `${callerId}:${userId}`;
        const finalEntry = pendingCalls.get(key);
        pendingCalls.delete(key);
        if (finalEntry) finalizeCall(callerId, userId, finalEntry, { declinedByReceiver: true });
    });

    // Hangup (either side), or caller cancels before it was answered
    socket.on('call-end', async ({ targetUserId }) => {
        try {
            console.log(`[webrtc] call-end from ${userId} -> ${targetUserId}`);
            const sender = await User.findById(userId).select('friends');
            if (targetUserId && sender?.friends.some((friend) => friend.userId === targetUserId)) {
                io.to(targetUserId).emit('call-ended');
            }
            const keyA = `${userId}:${targetUserId}`;
            const keyB = `${targetUserId}:${userId}`;
            const entry = pendingCalls.get(keyA) || pendingCalls.get(keyB);
            const [callerId, receiverId] = pendingCalls.has(keyA) ? [userId, targetUserId] : [targetUserId, userId];
            if (entry) {
                pendingCalls.delete(keyA);
                pendingCalls.delete(keyB);
                await finalizeCall(callerId, receiverId, entry, { declinedByReceiver: entry.declined });
            }
        } catch (err) {
            console.error('[webrtc] call-end error:', err);
        }
    });

    socket.on('disconnect', () => {
        console.log("User disconnected");
        const sockets = onlineUsers.get(userId);
        if (sockets) {
            sockets.delete(socket.id);
            if (sockets.size === 0) {
                onlineUsers.delete(userId);
                broadcastPresence(userId, false);

                activeGroupCalls.forEach((call, callId) => {
                    if (call.participants.has(userId)) {
                        call.participants.delete(userId);
                        io.to(`call:${callId}`).emit('group-call-participant-left', { callId, userId });
                        if (!call.leftIds) call.leftIds = new Set();
                        call.leftIds.add(userId);
                        if (call.participants.size === 0) {
                            if (call.groupId) io.to(`group:${call.groupId}`).emit('group-call-ended-in-group', { callId, groupId: call.groupId });
                            finalizeGroupCall(callId, call);
                            activeGroupCalls.delete(callId);
                        } else if (call.groupId) {
                            io.to(`group:${call.groupId}`).emit('group-call-still-active', { callId, groupId: call.groupId });
                        }
                    } else if (call.invited.has(userId)) {
                        call.invited.delete(userId);
                    }
                });
            }
        }
    });

    // ---- Group video calling (mesh, capped at MAX_GROUP_CALL_PARTICIPANTS) ----
    // Host starts a call and invites up to MAX_GROUP_CALL_PARTICIPANTS - 1 people, either
    // scoped to an existing group (all targets must be members) or ad-hoc (all targets must
    // be friends, and neither side may have blocked the other).
    socket.on('group-call-invite', async ({ callId, targetUserIds, groupId, callType }) => {
        try {
            if (!callId || activeGroupCalls.has(callId) || !Array.isArray(targetUserIds) || !targetUserIds.length) return;
            const uniqueTargets = [...new Set(targetUserIds.filter((id) => id && id !== userId))];
            if (!uniqueTargets.length || uniqueTargets.length > MAX_GROUP_CALL_PARTICIPANTS - 1) {
                socket.emit('group-call-error', { message: `Group calls are limited to ${MAX_GROUP_CALL_PARTICIPANTS} participants.` });
                return;
            }

            const me = await User.findById(userId).select('username friends blockedUsers');
            if (!me) return;

            if (groupId) {
                const group = await Group.findOne({ _id: groupId, 'members.userId': userId }).select('members').lean();
                if (!group) return;
                const memberIds = new Set(group.members.map((m) => m.userId));
                if (!uniqueTargets.every((id) => memberIds.has(id))) return;
            } else {
                const friendIds = new Set((me.friends || []).map((f) => f.userId));
                const blockedSet = new Set(me.blockedUsers || []);
                const others = await User.find({ _id: { $in: uniqueTargets } }).select('blockedUsers').lean();
                const blockedMeBack = new Set(others.filter((u) => (u.blockedUsers || []).includes(userId)).map((u) => u._id.toString()));
                if (!uniqueTargets.every((id) => friendIds.has(id) && !blockedSet.has(id) && !blockedMeBack.has(id))) return;
            }

            const now = Date.now();
            activeGroupCalls.set(callId, {
                hostId: userId,
                hostUsername: me.username,
                groupId: groupId || null,
                callType: callType === 'audio' ? 'audio' : 'video',
                participants: new Map([[userId, me.username]]),
                invited: new Set(uniqueTargets),
                declinedIds: new Set(),
                joinTimes: new Map([[userId, now]]),
                startTime: now,
            });
            socket.join(`call:${callId}`);

            uniqueTargets.forEach((targetId) => {
                io.to(targetId).emit('group-call-invite', {
                    callId,
                    from: { id: userId, username: me.username },
                    participantIds: [userId, ...uniqueTargets],
                    groupId: groupId || null,
                    callType: callType === 'audio' ? 'audio' : 'video',
                });
            });
        } catch (err) {
            console.error('[group-call] invite error:', err);
        }
    });

    // Invite additional people into a call that's already in progress. Reuses the exact same
    // join flow as the initial invite (group-call-join / group-call-state / participant-joined
    // already support a participant arriving after others are already connected).
    socket.on('group-call-invite-more', async ({ callId, targetUserIds }) => {
        try {
            const call = activeGroupCalls.get(callId);
            if (!call || !call.participants.has(userId) || !Array.isArray(targetUserIds)) return;

            const uniqueTargets = [...new Set(targetUserIds.filter((id) => id && id !== userId && !call.participants.has(id) && !call.invited.has(id)))];
            if (!uniqueTargets.length) return;
            if (call.participants.size + call.invited.size + uniqueTargets.length > MAX_GROUP_CALL_PARTICIPANTS) {
                socket.emit('group-call-error', { message: `Group calls are limited to ${MAX_GROUP_CALL_PARTICIPANTS} participants.` });
                return;
            }

            const me = await User.findById(userId).select('username friends blockedUsers');
            if (!me) return;

            if (call.groupId) {
                const group = await Group.findOne({ _id: call.groupId, 'members.userId': userId }).select('members').lean();
                if (!group) return;
                const memberIds = new Set(group.members.map((m) => m.userId));
                if (!uniqueTargets.every((id) => memberIds.has(id))) return;
            } else {
                const friendIds = new Set((me.friends || []).map((f) => f.userId));
                const blockedSet = new Set(me.blockedUsers || []);
                const others = await User.find({ _id: { $in: uniqueTargets } }).select('blockedUsers').lean();
                const blockedMeBack = new Set(others.filter((u) => (u.blockedUsers || []).includes(userId)).map((u) => u._id.toString()));
                if (!uniqueTargets.every((id) => friendIds.has(id) && !blockedSet.has(id) && !blockedMeBack.has(id))) return;
            }

            uniqueTargets.forEach((id) => call.invited.add(id));
            const participantIds = [...call.participants.keys(), ...call.invited];
            uniqueTargets.forEach((targetId) => {
                io.to(targetId).emit('group-call-invite', {
                    callId,
                    from: { id: userId, username: me.username },
                    participantIds,
                    groupId: call.groupId,
                    callType: call.callType,
                });
            });
        } catch (err) {
            console.error('[group-call] invite-more error:', err);
        }
    });

    socket.on('group-call-join', ({ callId }) => {
        const call = activeGroupCalls.get(callId);
        if (!call || (!call.invited.has(userId) && !call.participants.has(userId))) return;
        if (call.participants.size >= MAX_GROUP_CALL_PARTICIPANTS && !call.participants.has(userId)) {
            socket.emit('group-call-error', { message: 'This call is already full.' });
            return;
        }

        call.invited.delete(userId);
        call.declinedIds.delete(userId);
        call.participants.set(userId, socket.user.username);
        call.joinTimes.set(userId, Date.now());
        socket.join(`call:${callId}`);

        const existing = [...call.participants.entries()]
            .filter(([id]) => id !== userId)
            .map(([id, username]) => ({ userId: id, username }));
        socket.emit('group-call-state', { callId, participants: existing });

        socket.to(`call:${callId}`).emit('group-call-participant-joined', { callId, userId, username: socket.user.username });
    });

    // Generic SDP offer/answer/ICE-candidate relay between two participants of the same call.
    // This also carries ICE-restart renegotiation offers for the reconnect-on-drop path, since
    // an "offer" arriving on an already-open mesh peer connection is handled identically either way.
    socket.on('group-call-signal', ({ callId, targetUserId, data }) => {
        const call = activeGroupCalls.get(callId);
        if (!call || !call.participants.has(userId) || !call.participants.has(targetUserId)) return;
        io.to(targetUserId).emit('group-call-signal', { callId, fromUserId: userId, data });
    });

    socket.on('group-call-decline', ({ callId }) => {
        const call = activeGroupCalls.get(callId);
        if (!call) return;
        call.invited.delete(userId);
        call.declinedIds.add(userId);
        io.to(call.hostId).emit('group-call-declined', { callId, userId });
    });

    socket.on('group-call-leave', ({ callId }) => {
        const call = activeGroupCalls.get(callId);
        if (!call) return;
        call.participants.delete(userId);
        call.invited.delete(userId);
        // Track who left so they can rejoin within the same call
        if (!call.leftIds) call.leftIds = new Set();
        call.leftIds.add(userId);
        socket.leave(`call:${callId}`);
        io.to(`call:${callId}`).emit('group-call-participant-left', { callId, userId });
        // Notify the group chat room (if scoped to a group) so the group header can show a rejoin banner
        if (call.groupId) {
            io.to(`group:${call.groupId}`).emit('group-call-still-active', { callId, groupId: call.groupId });
        }
        if (call.participants.size === 0) {
            // Tell the group chat room the call is over so rejoin banners dismiss
            if (call.groupId) io.to(`group:${call.groupId}`).emit('group-call-ended-in-group', { callId, groupId: call.groupId });
            finalizeGroupCall(callId, call);
            activeGroupCalls.delete(callId);
        }
    });

    // Rejoin a call the user previously left (but which is still active)
    socket.on('group-call-rejoin', ({ callId }) => {
        const call = activeGroupCalls.get(callId);
        if (!call) { socket.emit('group-call-error', { message: 'That call has ended.' }); return; }
        if (call.participants.size >= MAX_GROUP_CALL_PARTICIPANTS && !call.participants.has(userId)) {
            socket.emit('group-call-error', { message: 'This call is already full.' }); return;
        }
        call.leftIds?.delete(userId);
        call.participants.set(userId, socket.user.username);
        call.joinTimes.set(userId, Date.now());
        socket.join(`call:${callId}`);

        const existing = [...call.participants.entries()]
            .filter(([id]) => id !== userId)
            .map(([id, username]) => ({ userId: id, username }));
        socket.emit('group-call-state', { callId, participants: existing });
        socket.to(`call:${callId}`).emit('group-call-participant-joined', { callId, userId, username: socket.user.username });
    });

    // Query whether a specific call is still active (used to validate rejoin banner on load)
    socket.on('group-call-check-active', ({ callId }) => {
        const alive = activeGroupCalls.has(callId) && activeGroupCalls.get(callId).participants.size > 0;
        socket.emit('group-call-active-status', { callId, alive });
    });

    // ---- Meeting socket events ----
    registerMeetingSocketHandlers(socket, userId);

});

app.get('/api/friends', auth, async (req, res) => {
    try {
        const me = await User.findById(req.user.userId).select('friends blockedUsers').lean();
        const friendIds = (me?.friends || []).map((friend) => friend.userId);
        const friendUsers = await User.find({ _id: { $in: friendIds } }).select('lastSeen name email').lean();
        const friendDataById = new Map(friendUsers.map((u) => [u._id.toString(), u]));
        const blockedSet = new Set(me?.blockedUsers || []);
        res.json((me?.friends || []).map((friend) => ({
            id: friend.userId,
            name: friend.name || friendDataById.get(friend.userId)?.name || friend.username,
            username: friend.username,
            email: friendDataById.get(friend.userId)?.email || '',
            lastSeen: friendDataById.get(friend.userId)?.lastSeen || null,
            blockedByMe: blockedSet.has(friend.userId),
        })));
    } catch (err) {
        console.error('Could not load friends:', err);
        res.status(500).json({ message: 'Could not load friends' });
    }
});

app.post('/api/friends', auth, async (req, res) => {
    const query = req.body.query?.trim() || req.body.username?.trim().replace(/^@/, '').toLowerCase();
    if (!query) return res.status(400).json({ message: 'Name or email is required' });

    try {
        const user = await User.findById(req.user.userId);
        // Search by email (exact, case-insensitive) OR name (partial, case-insensitive)
        const friend = await User.findOne({
            $and: [
                { _id: { $ne: user._id } },
                { $or: [
                    { email: { $regex: `^${query}$`, $options: 'i' } },
                    { name: { $regex: query, $options: 'i' } },
                    { username: { $regex: `^${query}$`, $options: 'i' } }, // keep as fallback
                ]},
            ],
        });
        if (!friend) return res.status(404).json({ message: 'No user found with that name or email' });
        if (friend._id.toString() === user._id.toString()) return res.status(400).json({ message: 'You cannot add yourself' });
        if (user.friends.some((item) => item.userId === friend._id.toString())) return res.status(409).json({ message: 'This user is already your friend' });

        user.friends.push({ userId: friend._id.toString(), username: friend.username, name: friend.name });
        friend.friends.push({ userId: user._id.toString(), username: user.username, name: user.name });
        await Promise.all([user.save(), friend.save()]);
        return res.status(201).json({ friend: { id: friend._id.toString(), name: friend.name, username: friend.username, email: friend.email, lastSeen: friend.lastSeen, blockedByMe: false } });
    } catch (err) {
        console.error('Could not add friend:', err);
        return res.status(500).json({ message: 'Could not add friend' });
    }
});

// ---- Block / unblock a friend ----
app.post('/api/friends/:id/block', auth, async (req, res) => {
    try {
        await User.findByIdAndUpdate(req.user.userId, { $addToSet: { blockedUsers: req.params.id } });
        res.json({ success: true, blockedByMe: true });
    } catch (err) {
        console.error('Could not block user:', err);
        res.status(500).json({ message: 'Could not block user' });
    }
});

app.post('/api/friends/:id/unblock', auth, async (req, res) => {
    try {
        await User.findByIdAndUpdate(req.user.userId, { $pull: { blockedUsers: req.params.id } });
        res.json({ success: true, blockedByMe: false });
    } catch (err) {
        console.error('Could not unblock user:', err);
        res.status(500).json({ message: 'Could not unblock user' });
    }
});

app.post('/api/groups', auth, async (req, res) => {
    const name = req.body.name?.trim();
    const memberIds = [...new Set((req.body.memberIds || []).filter((id) => id && id !== req.user.userId))];
    if (!name) return res.status(400).json({ message: 'Group name is required' });
    if (!memberIds.length) return res.status(400).json({ message: 'Select at least one friend for the group' });

    try {
        const currentUser = await User.findById(req.user.userId).select('username friends').lean();
        const friendIds = new Set((currentUser?.friends || []).map((friend) => friend.userId));
        if (!memberIds.every((id) => friendIds.has(id))) return res.status(403).json({ message: 'Groups can contain only your friends' });
        const members = await User.find({ _id: { $in: memberIds } }).select('username').lean();
        if (members.length !== memberIds.length) return res.status(404).json({ message: 'One or more friends could not be found' });

        const group = await Group.create({
            name,
            createdBy: req.user.userId,
            members: [
                { userId: req.user.userId, username: currentUser.username },
                ...members.map((member) => ({ userId: member._id.toString(), username: member.username })),
            ],
        });
        group.members.forEach((member) => io.in(member.userId).socketsJoin(`group:${group._id}`));
        res.status(201).json({
            id: group._id.toString(), name: group.name, description: group.description || '',
            createdBy: group.createdBy, members: group.members, lastMessage: '', timeStamp: group.createdAt, createdAt: group.createdAt,
        });
    } catch (err) {
        console.error('Could not create group:', err);
        res.status(500).json({ message: 'Could not create group' });
    }
});

app.get('/api/groups', auth, async (req, res) => {
    try {
        const userId = req.user.userId;
        const groups = await Group.find({ 'members.userId': userId }).lean();
        const groupIds = groups.map((group) => group._id.toString());
        const messages = await GroupMessage.find({ groupId: { $in: groupIds } }).sort({ timeStamp: -1 }).lean();
        const latestByGroup = new Map();
        messages.forEach((message) => !latestByGroup.has(message.groupId) && latestByGroup.set(message.groupId, message));

        // Build a map of lastRead timestamp per group for this user
        const lastReadByGroup = new Map();
        groups.forEach((group) => {
            const entry = (group.lastRead || []).find((r) => r.userId === userId);
            if (entry?.timestamp) lastReadByGroup.set(group._id.toString(), new Date(entry.timestamp));
        });

        // Count messages from others that arrived after the user last read each group
        const unreadByGroup = new Map();
        for (const [groupId, lastReadAt] of lastReadByGroup.entries()) {
            const count = await GroupMessage.countDocuments({
                groupId,
                senderId: { $ne: userId },
                timeStamp: { $gt: lastReadAt.toISOString() },
                deletedForEveryone: false,
                deletedFor: { $ne: userId },
            });
            if (count > 0) unreadByGroup.set(groupId, count);
        }
        // Groups never opened (no lastRead entry) — count all messages from others
        for (const group of groups) {
            const gid = group._id.toString();
            if (!lastReadByGroup.has(gid)) {
                const count = await GroupMessage.countDocuments({
                    groupId: gid,
                    senderId: { $ne: userId },
                    deletedForEveryone: false,
                    deletedFor: { $ne: userId },
                });
                if (count > 0) unreadByGroup.set(gid, count);
            }
        }

        const result = groups.map((group) => {
            const latest = latestByGroup.get(group._id.toString());
            return {
                id: group._id.toString(), name: group.name, description: group.description || '', createdBy: group.createdBy,
                members: group.members, lastMessage: previewFor(latest), timeStamp: latest?.timeStamp || group.createdAt, createdAt: group.createdAt,
                unreadCount: unreadByGroup.get(group._id.toString()) || 0,
            };
        }).sort((a, b) => new Date(b.timeStamp) - new Date(a.timeStamp));
        res.json(result);
    } catch (err) {
        console.error('Could not load groups:', err);
        res.status(500).json({ message: 'Could not load groups' });
    }
});

// Rename the group and/or edit its description. Any current member may do this.
app.patch('/api/groups/:groupId', auth, async (req, res) => {
    try {
        const group = await Group.findOne({ _id: req.params.groupId, 'members.userId': req.user.userId });
        if (!group) return res.status(403).json({ message: 'You are not a member of this group' });

        if (typeof req.body.name === 'string') {
            const name = req.body.name.trim();
            if (!name) return res.status(400).json({ message: 'Group name cannot be empty' });
            group.name = name;
        }
        if (typeof req.body.description === 'string') {
            group.description = req.body.description.trim().slice(0, 500);
        }
        await group.save();

        const payload = {
            id: group._id.toString(), name: group.name, description: group.description || '',
            createdBy: group.createdBy, members: group.members, createdAt: group.createdAt,
        };
        io.to(`group:${group._id}`).emit('group-updated', payload);
        res.json(payload);
    } catch (err) {
        console.error('Could not update group:', err);
        res.status(500).json({ message: 'Could not update group' });
    }
});

// Add one or more friends to an existing group. Requester must already be a member,
// and every added user must be a friend of the requester (same rule as group creation).
app.post('/api/groups/:groupId/members', auth, async (req, res) => {
    try {
        const group = await Group.findOne({ _id: req.params.groupId, 'members.userId': req.user.userId });
        if (!group) return res.status(403).json({ message: 'You are not a member of this group' });

        const existingIds = new Set(group.members.map((m) => m.userId));
        const newIds = [...new Set((req.body.memberIds || []).filter((id) => id && !existingIds.has(id)))];
        if (!newIds.length) return res.status(400).json({ message: 'Select at least one friend to add' });

        const requester = await User.findById(req.user.userId).select('friends').lean();
        const friendIds = new Set((requester?.friends || []).map((f) => f.userId));
        if (!newIds.every((id) => friendIds.has(id))) return res.status(403).json({ message: 'You can only add your own friends' });

        const newUsers = await User.find({ _id: { $in: newIds } }).select('username').lean();
        if (newUsers.length !== newIds.length) return res.status(404).json({ message: 'One or more friends could not be found' });

        group.members.push(...newUsers.map((u) => ({ userId: u._id.toString(), username: u.username })));
        await group.save();
        newUsers.forEach((u) => io.in(u._id.toString()).socketsJoin(`group:${group._id}`));

        const payload = {
            id: group._id.toString(), name: group.name, description: group.description || '',
            createdBy: group.createdBy, members: group.members, createdAt: group.createdAt,
        };
        io.to(`group:${group._id}`).emit('group-updated', payload);
        res.json(payload);
    } catch (err) {
        console.error('Could not add group members:', err);
        res.status(500).json({ message: 'Could not add group members' });
    }
});

// Leave a group. If the last member leaves, the group is deleted.
app.post('/api/groups/:groupId/leave', auth, async (req, res) => {
    try {
        const group = await Group.findOne({ _id: req.params.groupId, 'members.userId': req.user.userId });
        if (!group) return res.status(403).json({ message: 'You are not a member of this group' });

        group.members = group.members.filter((m) => m.userId !== req.user.userId);
        if (!group.members.length) {
            await Group.deleteOne({ _id: group._id });
        } else {
            await group.save();
            io.to(`group:${group._id}`).emit('group-updated', {
                id: group._id.toString(), name: group.name, description: group.description || '',
                createdBy: group.createdBy, members: group.members, createdAt: group.createdAt,
            });
        }
        io.in(req.user.userId).socketsLeave(`group:${group._id}`);
        res.json({ success: true });
    } catch (err) {
        console.error('Could not leave group:', err);
        res.status(500).json({ message: 'Could not leave group' });
    }
});

// Mark a group as read — updates lastRead timestamp for the calling user.
// Called by the client when the user opens a group chat.
app.post('/api/groups/:groupId/read', auth, async (req, res) => {
    try {
        const userId = req.user.userId;
        const { groupId } = req.params;
        await Group.updateOne(
            { _id: groupId, 'members.userId': userId },
            {
                $pull:  { lastRead: { userId } },       // remove old entry
            },
        );
        await Group.updateOne(
            { _id: groupId, 'members.userId': userId },
            {
                $push:  { lastRead: { userId, timestamp: new Date() } }, // add fresh entry
            },
        );
        res.json({ ok: true });
    } catch (err) {
        console.error('Could not mark group read:', err);
        res.status(500).json({ message: 'Could not mark group read' });
    }
});

app.get('/api/groups/:groupId/messages', auth, async (req, res) => {
    try {
        const group = await Group.findOne({ _id: req.params.groupId, 'members.userId': req.user.userId }).select('_id');
        if (!group) return res.status(403).json({ message: 'You are not a member of this group' });
        const messages = await GroupMessage.find({ groupId: group._id.toString(), deletedFor: { $ne: req.user.userId } }).sort({ timeStamp: 1 }).lean();
        res.json(messages.map((message) => ({
            id: message._id.toString(), groupId: message.groupId, senderId: message.senderId,
            username: message.username, msg: message.msg, timeStamp: message.timeStamp,
            type: message.type || 'text', audioData: message.audioData,
            fileData: message.fileData, fileName: message.fileName, fileMime: message.fileMime,
            location: message.location, contactShare: message.contactShare,
            callInfo: message.callInfo,
            poll: message.poll || null,
            editedAt: message.editedAt || null,
            reactions: message.reactions || [],
            deletedForEveryone: message.deletedForEveryone || false,
        })));
    } catch (err) {
        console.error('Could not load group messages:', err);
        res.status(500).json({ message: 'Could not load group messages' });
    }
});

// DELETE a message: body { everyone: boolean }
app.delete('/api/groups/:groupId/messages/:id', auth, async (req, res) => {
    try {
        const message = await GroupMessage.findById(req.params.id);
        if (!message || message.groupId !== req.params.groupId) return res.status(404).json({ message: 'Message not found' });
        const everyone = !!req.body.everyone;
        if (everyone) {
            if (message.senderId !== req.user.userId) return res.status(403).json({ message: 'Only the sender can delete for everyone' });
            message.deletedForEveryone = true;
            message.msg = '';
            message.audioData = undefined;
            message.fileData = undefined;
        } else if (!message.deletedFor.includes(req.user.userId)) {
            message.deletedFor.push(req.user.userId);
        }
        await message.save();
        res.json({ success: true });
    } catch (err) {
        console.error('Could not delete group message:', err);
        res.status(500).json({ message: 'Could not delete message' });
    }
});

app.get('/api/conversations', auth, async (req, res) => {
    try {
        const userId = req.user.userId;
        const currentUser = await User.findById(userId).select('friends').lean();
        const friendIds = new Set((currentUser?.friends || []).map((friend) => friend.userId));
        const messages = await Chat.find({ $or: [{ senderId: userId }, { recipientId: userId }] }).sort({ timeStamp: -1 }).lean();
        const latestByContact = new Map();
        messages.forEach((message) => {
            const contactId = message.senderId === userId ? message.recipientId : message.senderId;
            if (friendIds.has(contactId) && !latestByContact.has(contactId)) latestByContact.set(contactId, message);
        });

        const contacts = await User.find({ _id: { $in: [...latestByContact.keys()] } }).select('username name email').lean();
        const contactsById = new Map(contacts.map((contact) => [contact._id.toString(), contact]));

        // Count unread messages per contact (sent TO me, not read yet)
        const unreadCounts = await Chat.aggregate([
            { $match: { recipientId: userId, read: false, deletedForEveryone: false, deletedFor: { $ne: userId } } },
            { $group: { _id: '$senderId', count: { $sum: 1 } } },
        ]);
        const unreadByContact = new Map(unreadCounts.map((r) => [r._id, r.count]));

        const conversations = [...latestByContact.entries()]
            .map(([contactId, message]) => {
                const contact = contactsById.get(contactId);
                if (!contact) return null;
                return {
                    id: contactId,
                    name: contact.name,
                    username: contact.username,
                    email: contact.email,
                    lastMessage: previewFor(message),
                    timeStamp: message.timeStamp,
                    unreadCount: unreadByContact.get(contactId) || 0,
                };
            })
            .filter(Boolean);
        res.json(conversations);
    } catch (err) {
        console.error('Could not load conversations:', err);
        res.status(500).json({ message: 'Could not load conversations' });
    }
});

app.get('/api/messages/:contactId', auth, async (req, res) => {
    try {
        const { userId } = req.user;
        const { contactId } = req.params;
        const currentUser = await User.findById(userId).select('friends').lean();
        const isFriend = currentUser?.friends.some((friend) => friend.userId === contactId);
        if (!isFriend) return res.status(403).json({ message: 'You can only view messages with friends' });
        const messages = await Chat.find({
            $or: [
                { senderId: userId, recipientId: contactId },
                { senderId: contactId, recipientId: userId },
            ],
            deletedFor: { $ne: userId },
        }).sort({ timeStamp: 1 }).lean();
        res.json(messages.map((message) => ({
            id: message._id.toString(),
            senderId: message.senderId,
            recipientId: message.recipientId,
            user: message.user,
            msg: message.msg,
            timeStamp: message.timeStamp,
            type: message.type || 'text',
            audioData: message.audioData,
            fileData: message.fileData,
            fileName: message.fileName,
            fileMime: message.fileMime,
            location: message.location,
            contactShare: message.contactShare,
            callInfo: message.callInfo,
            poll: message.poll || null,
            editedAt: message.editedAt || null,
            reactions: message.reactions || [],
            delivered: message.delivered || false,
            read: message.read || false,
            deletedForEveryone: message.deletedForEveryone || false,
        })));
    } catch (err) {
        console.error('Could not load messages:', err);
        res.status(500).json({ message: 'Could not load messages' });
    }
});

// DELETE a direct message: body { everyone: boolean }
app.delete('/api/messages/:id', auth, async (req, res) => {
    try {
        const message = await Chat.findById(req.params.id);
        if (!message) return res.status(404).json({ message: 'Message not found' });
        const isParticipant = message.senderId === req.user.userId || message.recipientId === req.user.userId;
        if (!isParticipant) return res.status(403).json({ message: 'Not your message' });

        const everyone = !!req.body.everyone;
        if (everyone) {
            if (message.senderId !== req.user.userId) return res.status(403).json({ message: 'Only the sender can delete for everyone' });
            message.deletedForEveryone = true;
            message.msg = '';
            message.audioData = undefined;
            message.fileData = undefined;
        } else if (!message.deletedFor.includes(req.user.userId)) {
            message.deletedFor.push(req.user.userId);
        }
        await message.save();
        res.json({ success: true });
    } catch (err) {
        console.error('Could not delete message:', err);
        res.status(500).json({ message: 'Could not delete message' });
    }
});

// Clear an entire direct conversation — this is "delete for me" applied to every message,
// same as the per-message version. The other person's copy is untouched.
app.post('/api/messages/clear', auth, async (req, res) => {
    const { contactId } = req.body;
    if (!contactId) return res.status(400).json({ message: 'contactId is required' });
    try {
        await Chat.updateMany(
            { $or: [{ senderId: req.user.userId, recipientId: contactId }, { senderId: contactId, recipientId: req.user.userId }] },
            { $addToSet: { deletedFor: req.user.userId } },
        );
        res.json({ success: true });
    } catch (err) {
        console.error('Could not clear chat:', err);
        res.status(500).json({ message: 'Could not clear chat' });
    }
});

// Clear a group conversation for the requester only (everyone else keeps their history).
app.post('/api/groups/:groupId/messages/clear', auth, async (req, res) => {
    try {
        const group = await Group.findOne({ _id: req.params.groupId, 'members.userId': req.user.userId }).select('_id');
        if (!group) return res.status(403).json({ message: 'You are not a member of this group' });
        await GroupMessage.updateMany({ groupId: req.params.groupId }, { $addToSet: { deletedFor: req.user.userId } });
        res.json({ success: true });
    } catch (err) {
        console.error('Could not clear group chat:', err);
        res.status(500).json({ message: 'Could not clear group chat' });
    }
});

// ---- Call history (1:1 + group, merged and sorted) ----
app.get('/api/calls', auth, async (req, res) => {
    try {
        const userId = req.user.userId;

        const directCalls = await CallHistory.find({ $or: [{ callerId: userId }, { receiverId: userId }] })
            .sort({ startTime: -1 }).limit(100).lean();

        const groupCalls = await GroupCallHistory.find({ 'participants.userId': userId })
            .sort({ startTime: -1 }).limit(100).lean();

        const directRows = directCalls.map((call) => ({
            id: call._id.toString(),
            kind: 'direct',
            direction: call.callerId === userId ? 'outgoing' : 'incoming',
            contactId: call.callerId === userId ? call.receiverId : call.callerId,
            contactUsername: call.callerId === userId ? call.receiverUsername : call.callerUsername,
            callType: call.callType,
            status: call.status,
            startTime: call.startTime,
            duration: call.duration,
        }));

        const groupRows = groupCalls.map((call) => {
            const mine = call.participants.find((p) => p.userId === userId);
            return {
                id: call._id.toString(),
                kind: 'group',
                direction: call.hostId === userId ? 'outgoing' : 'incoming',
                groupId: call.groupId,
                hostUsername: call.hostUsername,
                otherParticipants: call.participants.filter((p) => p.userId !== userId).map((p) => p.username),
                callType: call.callType,
                status: mine?.status || 'missed',
                startTime: call.startTime,
                duration: mine?.duration || 0,
            };
        });

        const merged = [...directRows, ...groupRows].sort((a, b) => new Date(b.startTime) - new Date(a.startTime)).slice(0, 100);
        res.json(merged);
    } catch (err) {
        console.error('Could not load call history:', err);
        res.status(500).json({ message: 'Could not load call history' });
    }
});

// DELETE /api/calls — clear all call history for the current user
app.delete('/api/calls', auth, async (req, res) => {
    try {
        const userId = req.user.userId;
        await Promise.all([
            CallHistory.deleteMany({ $or: [{ callerId: userId }, { receiverId: userId }] }),
            GroupCallHistory.deleteMany({ 'participants.userId': userId }),
        ]);
        res.json({ message: 'Call history cleared' });
    } catch (err) {
        console.error('Could not clear call history:', err);
        res.status(500).json({ message: 'Could not clear call history' });
    }
});

// ============================================================
// PROFILE ROUTES
// ============================================================

// GET own profile
app.get('/api/profile', auth, async (req, res) => {
    try {
        const user = await User.findById(req.user.userId).select('-password').lean();
        if (!user) return res.status(404).json({ message: 'User not found' });
        res.json({ id: user._id.toString(), name: user.name, username: user.username, email: user.email, phone: user.phone || '', bio: user.bio || '', avatar: user.avatar || '' });
    } catch (err) {
        res.status(500).json({ message: 'Could not load profile' });
    }
});

// PATCH own profile (name, bio, phone, avatar)
app.patch('/api/profile', auth, async (req, res) => {
    try {
        const { name, bio, phone, avatar } = req.body;
        const user = await User.findById(req.user.userId);
        if (!user) return res.status(404).json({ message: 'User not found' });

        if (typeof name === 'string' && name.trim()) user.name = name.trim().slice(0, 60);
        if (typeof bio === 'string') user.bio = bio.trim().slice(0, 500);
        if (typeof phone === 'string') user.phone = phone.trim().slice(0, 20);
        if (typeof avatar === 'string') {
            // Accept base64 data URLs; enforce a ~2MB cap on the base64 string
            if (avatar.length > 2_800_000) return res.status(400).json({ message: 'Avatar image is too large (max ~2 MB)' });
            user.avatar = avatar;
        }
        await user.save();
        res.json({ id: user._id.toString(), name: user.name, username: user.username, email: user.email, phone: user.phone, bio: user.bio, avatar: user.avatar });
    } catch (err) {
        console.error('Could not update profile:', err);
        res.status(500).json({ message: 'Could not update profile' });
    }
});

// Toggle a reaction on a direct message
app.post('/api/messages/:id/react', auth, async (req, res) => {
  try {
    const { emoji } = req.body;
    if (!emoji) return res.status(400).json({ message: 'emoji is required' });
    const msg = await Chat.findById(req.params.id);
    if (!msg) return res.status(404).json({ message: 'Message not found' });
    const isParticipant = msg.senderId === req.user.userId || msg.recipientId === req.user.userId;
    if (!isParticipant) return res.status(403).json({ message: 'Not your conversation' });

    const existing = msg.reactions.find((r) => r.userId === req.user.userId);
    if (existing) {
      if (existing.emoji === emoji) {
        msg.reactions = msg.reactions.filter((r) => r.userId !== req.user.userId);
      } else {
        existing.emoji = emoji;
      }
    } else {
      msg.reactions.push({ userId: req.user.userId, emoji });
    }
    await msg.save();
    io.to(msg.senderId).to(msg.recipientId).emit('message-reaction', { messageId: msg._id.toString(), reactions: msg.reactions, isGroup: false });
    res.json({ reactions: msg.reactions });
  } catch (err) {
    res.status(500).json({ message: 'Could not update reaction' });
  }
});

// Toggle a reaction on a group message
app.post('/api/groups/:groupId/messages/:id/react', auth, async (req, res) => {
  try {
    const { emoji } = req.body;
    if (!emoji) return res.status(400).json({ message: 'emoji is required' });
    const group = await Group.findOne({ _id: req.params.groupId, 'members.userId': req.user.userId }).select('_id');
    if (!group) return res.status(403).json({ message: 'Not a member' });
    const msg = await GroupMessage.findOne({ _id: req.params.id, groupId: req.params.groupId });
    if (!msg) return res.status(404).json({ message: 'Message not found' });

    const existing = msg.reactions.find((r) => r.userId === req.user.userId);
    if (existing) {
      if (existing.emoji === emoji) {
        msg.reactions = msg.reactions.filter((r) => r.userId !== req.user.userId);
      } else {
        existing.emoji = emoji;
      }
    } else {
      msg.reactions.push({ userId: req.user.userId, emoji });
    }
    await msg.save();
    io.to(`group:${req.params.groupId}`).emit('message-reaction', { messageId: msg._id.toString(), reactions: msg.reactions, isGroup: true });
    res.json({ reactions: msg.reactions });
  } catch (err) {
    res.status(500).json({ message: 'Could not update reaction' });
  }
});

// ============================================================
// MESSAGE STAR/UNSTAR ROUTES
// ============================================================

// Star/Unstar a direct message
app.post('/api/messages/:id/star', auth, async (req, res) => {
  try {
    const { star } = req.body;
    const msg = await Chat.findById(req.params.id);
    if (!msg) return res.status(404).json({ message: 'Message not found' });
    const isParticipant = msg.senderId === req.user.userId || msg.recipientId === req.user.userId;
    if (!isParticipant) return res.status(403).json({ message: 'Not your conversation' });

    if (star) {
      if (!msg.starredBy.includes(req.user.userId)) msg.starredBy.push(req.user.userId);
    } else {
      msg.starredBy = msg.starredBy.filter((id) => id !== req.user.userId);
    }
    await msg.save();
    io.to(msg.senderId).to(msg.recipientId).emit('message-starred', { messageId: msg._id.toString(), starredBy: msg.starredBy });
    res.json({ success: true, starredBy: msg.starredBy });
  } catch (err) {
    res.status(500).json({ message: 'Could not star message' });
  }
});

// Star/Unstar a group message
app.post('/api/groups/:groupId/messages/:id/star', auth, async (req, res) => {
  try {
    const { star } = req.body;
    const group = await Group.findOne({ _id: req.params.groupId, 'members.userId': req.user.userId }).select('_id');
    if (!group) return res.status(403).json({ message: 'Not a member' });
    const msg = await GroupMessage.findOne({ _id: req.params.id, groupId: req.params.groupId });
    if (!msg) return res.status(404).json({ message: 'Message not found' });

    if (star) {
      if (!msg.starredBy.includes(req.user.userId)) msg.starredBy.push(req.user.userId);
    } else {
      msg.starredBy = msg.starredBy.filter((id) => id !== req.user.userId);
    }
    await msg.save();
    io.to(`group:${req.params.groupId}`).emit('message-starred', { messageId: msg._id.toString(), starredBy: msg.starredBy });
    res.json({ success: true, starredBy: msg.starredBy });
  } catch (err) {
    res.status(500).json({ message: 'Could not star message' });
  }
});

// ============================================================
// MESSAGE EDIT ROUTES
// ============================================================
const EDIT_WINDOW_MS = 15 * 60 * 1000; // 15 minutes

// Edit a direct message
app.patch('/api/messages/:id', auth, async (req, res) => {
    try {
        const { newText } = req.body;
        if (typeof newText !== 'string' || !newText.trim()) return res.status(400).json({ message: 'newText is required' });
        const msg = await Chat.findById(req.params.id);
        if (!msg) return res.status(404).json({ message: 'Message not found' });
        if (msg.senderId !== req.user.userId) return res.status(403).json({ message: 'Only the sender can edit' });
        if (msg.type !== 'text') return res.status(400).json({ message: 'Only text messages can be edited' });
        if (Date.now() - new Date(msg.timeStamp).getTime() > EDIT_WINDOW_MS) return res.status(400).json({ message: 'Edit window expired (15 min)' });
        msg.msg = newText.trim().slice(0, 4000);
        msg.editedAt = new Date();
        await msg.save();
        io.to(msg.senderId).to(msg.recipientId).emit('message-edited', { messageId: msg._id.toString(), newText: msg.msg, editedAt: msg.editedAt, isGroup: false });
        res.json({ success: true });
    } catch (err) {
        res.status(500).json({ message: 'Could not edit message' });
    }
});

// Edit a group message
app.patch('/api/groups/:groupId/messages/:id', auth, async (req, res) => {
    try {
        const { newText } = req.body;
        if (typeof newText !== 'string' || !newText.trim()) return res.status(400).json({ message: 'newText is required' });
        const group = await Group.findOne({ _id: req.params.groupId, 'members.userId': req.user.userId }).select('_id');
        if (!group) return res.status(403).json({ message: 'Not a member' });
        const msg = await GroupMessage.findOne({ _id: req.params.id, groupId: req.params.groupId });
        if (!msg) return res.status(404).json({ message: 'Message not found' });
        if (msg.senderId !== req.user.userId) return res.status(403).json({ message: 'Only the sender can edit' });
        if (msg.type !== 'text') return res.status(400).json({ message: 'Only text messages can be edited' });
        if (Date.now() - new Date(msg.timeStamp).getTime() > EDIT_WINDOW_MS) return res.status(400).json({ message: 'Edit window expired (15 min)' });
        msg.msg = newText.trim().slice(0, 4000);
        msg.editedAt = new Date();
        await msg.save();
        io.to(`group:${req.params.groupId}`).emit('message-edited', { messageId: msg._id.toString(), newText: msg.msg, editedAt: msg.editedAt, isGroup: true });
        res.json({ success: true });
    } catch (err) {
        res.status(500).json({ message: 'Could not edit message' });
    }
});

// ============================================================
// MESSAGE PIN ROUTES
// ============================================================

// Pin/Unpin a direct message
app.patch('/api/messages/:id/pin', auth, async (req, res) => {
    try {
        const { pin } = req.body; // true = pin, false = unpin
        const msg = await Chat.findById(req.params.id);
        if (!msg) return res.status(404).json({ message: 'Message not found' });
        const isParticipant = msg.senderId === req.user.userId || msg.recipientId === req.user.userId;
        if (!isParticipant) return res.status(403).json({ message: 'Not your conversation' });
        msg.isPinned = !!pin;
        msg.pinnedBy = pin ? req.user.userId : undefined;
        msg.pinnedAt = pin ? new Date() : undefined;
        await msg.save();
        io.to(msg.senderId).to(msg.recipientId).emit('message-pinned', { messageId: msg._id.toString(), isPinned: msg.isPinned, isGroup: false });
        res.json({ success: true });
    } catch (err) {
        res.status(500).json({ message: 'Could not pin message' });
    }
});

// Pin/Unpin a group message
app.patch('/api/groups/:groupId/messages/:id/pin', auth, async (req, res) => {
    try {
        const { pin } = req.body;
        const group = await Group.findOne({ _id: req.params.groupId, 'members.userId': req.user.userId }).select('_id');
        if (!group) return res.status(403).json({ message: 'Not a member' });
        const msg = await GroupMessage.findOne({ _id: req.params.id, groupId: req.params.groupId });
        if (!msg) return res.status(404).json({ message: 'Message not found' });
        msg.isPinned = !!pin;
        msg.pinnedBy = pin ? req.user.userId : undefined;
        msg.pinnedAt = pin ? new Date() : undefined;
        await msg.save();
        io.to(`group:${req.params.groupId}`).emit('message-pinned', { messageId: msg._id.toString(), isPinned: msg.isPinned, isGroup: true });
        res.json({ success: true });
    } catch (err) {
        res.status(500).json({ message: 'Could not pin message' });
    }
});

// ============================================================
// PINNED CHATS (sidebar)
// ============================================================

app.post('/api/pinned-chats', auth, async (req, res) => {
    try {
        const { key } = req.body; // "direct:<userId>" or "group:<groupId>"
        if (!key) return res.status(400).json({ message: 'key is required' });
        const user = await User.findById(req.user.userId);
        if (!user) return res.status(404).json({ message: 'User not found' });
        if (!user.pinnedChats.includes(key)) {
            if (user.pinnedChats.length >= 3) return res.status(400).json({ message: 'You can only pin up to 3 chats' });
            user.pinnedChats.push(key);
            await user.save();
        }
        res.json({ pinnedChats: user.pinnedChats });
    } catch (err) {
        res.status(500).json({ message: 'Could not pin chat' });
    }
});

app.delete('/api/pinned-chats', auth, async (req, res) => {
    try {
        const { key } = req.body;
        if (!key) return res.status(400).json({ message: 'key is required' });
        const user = await User.findById(req.user.userId);
        if (!user) return res.status(404).json({ message: 'User not found' });
        user.pinnedChats = user.pinnedChats.filter((k) => k !== key);
        await user.save();
        res.json({ pinnedChats: user.pinnedChats });
    } catch (err) {
        res.status(500).json({ message: 'Could not unpin chat' });
    }
});

app.get('/api/pinned-chats', auth, async (req, res) => {
    try {
        const user = await User.findById(req.user.userId).select('pinnedChats').lean();
        res.json({ pinnedChats: user?.pinnedChats || [] });
    } catch (err) {
        res.status(500).json({ message: 'Could not load pinned chats' });
    }
});

// ============================================================
// STARRED MESSAGES
// ============================================================

app.get('/api/starred', auth, async (req, res) => {
    try {
        const userId = req.user.userId;
        const [directStarred, groupStarred] = await Promise.all([
            Chat.find({ starredBy: userId, deletedForEveryone: false, deletedFor: { $ne: userId } }).sort({ timeStamp: -1 }).limit(200).lean(),
            GroupMessage.find({ starredBy: userId, deletedForEveryone: false, deletedFor: { $ne: userId } }).sort({ timeStamp: -1 }).limit(200).lean(),
        ]);
        const direct = directStarred.map((m) => ({ ...m, id: m._id.toString(), isGroup: false }));
        const group = groupStarred.map((m) => ({ ...m, id: m._id.toString(), isGroup: true }));
        const merged = [...direct, ...group].sort((a, b) => new Date(b.timeStamp) - new Date(a.timeStamp));
        res.json(merged);
    } catch (err) {
        res.status(500).json({ message: 'Could not load starred messages' });
    }
});

// ============================================================
// GLOBAL SEARCH
// ============================================================

app.get('/api/search', auth, async (req, res) => {
    try {
        const { q } = req.query;
        if (!q || q.trim().length < 2) return res.json({ users: [], groups: [], messages: [] });
        const query = q.trim();
        const userId = req.user.userId;

        const me = await User.findById(userId).select('friends').lean();
        const friendIds = (me?.friends || []).map((f) => f.userId);

        const [users, groups, messages] = await Promise.all([
            // search among friends only
            User.find({
                _id: { $in: friendIds },
                $or: [
                    { name: { $regex: query, $options: 'i' } },
                    { email: { $regex: query, $options: 'i' } },
                    { username: { $regex: query, $options: 'i' } },
                ],
            }).select('username name email avatar').limit(10).lean(),

            // search groups the user belongs to
            Group.find({
                'members.userId': userId,
                name: { $regex: query, $options: 'i' },
            }).select('name description').limit(10).lean(),

            // search messages involving this user
            Chat.find({
                $or: [{ senderId: userId }, { recipientId: userId }],
                type: 'text',
                msg: { $regex: query, $options: 'i' },
                deletedForEveryone: false,
                deletedFor: { $ne: userId },
            }).sort({ timeStamp: -1 }).limit(20).lean(),
        ]);

        res.json({
            users: users.map((u) => ({ id: u._id.toString(), username: u.username, name: u.name, email: u.email || '', avatar: u.avatar || '' })),
            groups: groups.map((g) => ({ id: g._id.toString(), name: g.name, description: g.description || '' })),
            messages: messages.map((m) => ({ id: m._id.toString(), senderId: m.senderId, recipientId: m.recipientId, msg: m.msg, timeStamp: m.timeStamp })),
        });
    } catch (err) {
        res.status(500).json({ message: 'Search failed' });
    }
});

// ============================================================
// STATUS ROUTES
// ============================================================

// GET all statuses of friends (+ own) posted in last 24h
app.get('/api/status', auth, async (req, res) => {
    try {
        const me = await User.findById(req.user.userId).select('friends name').lean();
        const friendIds = (me?.friends || []).map((f) => f.userId);
        const allIds = [req.user.userId, ...friendIds];

        const statuses = await Status.find({ userId: { $in: allIds } })
            .sort({ createdAt: -1 }).lean();

        // Group by userId
        const byUser = new Map();
        statuses.forEach((s) => {
            if (!byUser.has(s.userId)) byUser.set(s.userId, []);
            byUser.get(s.userId).push({ ...s, id: s._id.toString() });
        });

        // Get user names
        const users = await User.find({ _id: { $in: allIds } }).select('name username').lean();
        const userMap = new Map(users.map((u) => [u._id.toString(), u]));

        const result = [...byUser.entries()].map(([userId, items]) => {
            const u = userMap.get(userId);
            return {
                userId,
                name: u?.name || u?.username || 'Unknown',
                isMe: userId === req.user.userId,
                items: items.map((s) => ({
                    id: s.id,
                    text: s.text,
                    emoji: s.emoji,
                    bgColor: s.bgColor,
                    createdAt: s.createdAt,
                    viewed: (s.viewers || []).includes(req.user.userId),
                    viewCount: (s.viewers || []).length,
                })),
            };
        });

        res.json(result);
    } catch (err) {
        console.error('Could not load statuses:', err);
        res.status(500).json({ message: 'Could not load statuses' });
    }
});

// POST create a new status
app.post('/api/status', auth, async (req, res) => {
    try {
        const { text, emoji, bgColor } = req.body;
        if (!text?.trim() && !emoji?.trim()) return res.status(400).json({ message: 'Status text or emoji required' });

        const status = await Status.create({
            userId: req.user.userId,
            text: text?.trim() || '',
            emoji: emoji?.trim() || '',
            bgColor: bgColor || '#128C7E',
        });
        res.status(201).json({ id: status._id.toString(), text: status.text, emoji: status.emoji, bgColor: status.bgColor, createdAt: status.createdAt, viewed: false, viewCount: 0 });
    } catch (err) {
        console.error('Could not post status:', err);
        res.status(500).json({ message: 'Could not post status' });
    }
});

// DELETE own status item
app.delete('/api/status/:id', auth, async (req, res) => {
    try {
        const status = await Status.findById(req.params.id);
        if (!status) return res.status(404).json({ message: 'Status not found' });
        if (status.userId !== req.user.userId) return res.status(403).json({ message: 'Not your status' });
        await status.deleteOne();
        res.json({ message: 'Status deleted' });
    } catch (err) {
        res.status(500).json({ message: 'Could not delete status' });
    }
});

// POST mark a status as viewed
app.post('/api/status/:id/view', auth, async (req, res) => {
    try {
        await Status.findByIdAndUpdate(req.params.id, { $addToSet: { viewers: req.user.userId } });
        res.json({ ok: true });
    } catch (err) {
        res.status(500).json({ message: 'Could not mark viewed' });
    }
});

// GET viewers of a specific status (owner only)
app.get('/api/status/:id/viewers', auth, async (req, res) => {
    try {
        const status = await Status.findById(req.params.id).lean();
        if (!status) return res.status(404).json({ message: 'Status not found' });
        if (status.userId !== req.user.userId) return res.status(403).json({ message: 'Not your status' });
        const viewerIds = status.viewers || [];
        const users = await User.find({ _id: { $in: viewerIds } }).select('name username').lean();
        const userMap = new Map(users.map((u) => [u._id.toString(), u]));
        res.json(viewerIds.map((id) => ({
            userId: id,
            name: userMap.get(id)?.name || userMap.get(id)?.username || 'Unknown',
            username: userMap.get(id)?.username || '',
        })));
    } catch (err) {
        res.status(500).json({ message: 'Could not load viewers' });
    }
});

// ============================================================
// MEETINGS ROUTES
// ============================================================

// Helper: generate a human-readable meeting ID like "abc-1234-xyz"
const genMeetingId = () => {
    const seg = (n) => Math.random().toString(36).substring(2, 2 + n);
    return `${seg(3)}-${Math.floor(1000 + Math.random() * 9000)}-${seg(3)}`;
};

// Active meeting rooms in memory: meetingId → Set<socketId>
// Used for real-time signaling; ground truth is MongoDB
const activeMeetingRooms = new Map();

// POST /api/meetings — create instant or scheduled meeting
app.post('/api/meetings', auth, async (req, res) => {
    try {
        const { title, scheduledAt, recurring, passcode, waitingRoom } = req.body;
        const me = await User.findById(req.user.userId).select('username name').lean();
        if (!me) return res.status(401).json({ message: 'Not found' });

        let meetingId;
        let attempts = 0;
        do { meetingId = genMeetingId(); attempts++; } while (await Meeting.exists({ meetingId }) && attempts < 10);

        const meeting = await Meeting.create({
            meetingId,
            title:       title?.trim() || 'My Meeting',
            hostId:      req.user.userId,
            hostName:    me.name || me.username,
            scheduledAt: scheduledAt ? new Date(scheduledAt) : null,
            recurring:   recurring || 'none',
            passcode:    passcode?.trim() || '',
            waitingRoom: waitingRoom !== false,
            status:      scheduledAt ? 'waiting' : 'active',
            startedAt:   scheduledAt ? null : new Date(),
        });
        res.status(201).json(meetingToDTO(meeting));
    } catch (err) {
        console.error('[meetings] create error:', err);
        res.status(500).json({ message: 'Could not create meeting' });
    }
});

// GET /api/meetings — list meetings hosted by or attended by current user
app.get('/api/meetings', auth, async (req, res) => {
    try {
        const userId = req.user.userId;
        const meetings = await Meeting.find({
            $or: [{ hostId: userId }, { 'participants.userId': userId }],
            status: { $ne: 'ended' },
        }).sort({ createdAt: -1 }).limit(50).lean();
        res.json(meetings.map(meetingToDTO));
    } catch (err) {
        res.status(500).json({ message: 'Could not load meetings' });
    }
});

// GET /api/meetings/:id — get a single meeting (public info, used for join-by-ID screen)
app.get('/api/meetings/:id', auth, async (req, res) => {
    try {
        const meeting = await Meeting.findOne({ meetingId: req.params.id }).lean();
        if (!meeting) return res.status(404).json({ message: 'Meeting not found' });
        res.json(meetingToDTO(meeting));
    } catch (err) {
        res.status(500).json({ message: 'Could not load meeting' });
    }
});

// PATCH /api/meetings/:id — update title, lock, chat, waitingRoom (host only)
app.patch('/api/meetings/:id', auth, async (req, res) => {
    try {
        const meeting = await Meeting.findOne({ meetingId: req.params.id });
        if (!meeting) return res.status(404).json({ message: 'Meeting not found' });
        if (meeting.hostId !== req.user.userId) return res.status(403).json({ message: 'Host only' });
        const { title, locked, chatEnabled, waitingRoom, hostOnlyInvite } = req.body;
        if (title          !== undefined) meeting.title          = title.trim();
        if (locked         !== undefined) meeting.locked         = !!locked;
        if (chatEnabled    !== undefined) meeting.chatEnabled    = !!chatEnabled;
        if (waitingRoom    !== undefined) meeting.waitingRoom    = !!waitingRoom;
        if (hostOnlyInvite !== undefined) meeting.hostOnlyInvite = !!hostOnlyInvite;
        await meeting.save();
        io.to(`meeting:${meeting.meetingId}`).emit('meeting-updated', meetingToDTO(meeting));
        res.json(meetingToDTO(meeting));
    } catch (err) {
        res.status(500).json({ message: 'Could not update meeting' });
    }
});

// DELETE /api/meetings/:id — end/delete meeting (host only)
app.delete('/api/meetings/:id', auth, async (req, res) => {
    try {
        const meeting = await Meeting.findOne({ meetingId: req.params.id });
        if (!meeting) return res.status(404).json({ message: 'Meeting not found' });
        if (meeting.hostId !== req.user.userId) return res.status(403).json({ message: 'Host only' });
        meeting.status  = 'ended';
        meeting.endedAt = new Date();
        await meeting.save();
        io.to(`meeting:${meeting.meetingId}`).emit('meeting-ended', { meetingId: meeting.meetingId });
        res.json({ message: 'Meeting ended' });
    } catch (err) {
        res.status(500).json({ message: 'Could not end meeting' });
    }
});

// Serialise a Meeting document for the wire
function meetingToDTO(m) {
    return {
        id:           m._id?.toString() || m.id,
        meetingId:    m.meetingId,
        title:        m.title,
        hostId:       m.hostId,
        hostName:     m.hostName,
        scheduledAt:  m.scheduledAt,
        recurring:    m.recurring,
        status:       m.status,
        locked:       m.locked,
        waitingRoom:  m.waitingRoom,
        chatEnabled:  m.chatEnabled,
        hostOnlyInvite: m.hostOnlyInvite || false,
        passcodeRequired: !!m.passcode,
        participants: (m.participants || []).map((p) => ({
            userId: p.userId, username: p.username, name: p.name, role: p.role,
            micMuted: p.micMuted, camOff: p.camOff,
        })),
        waitingCount: (m.waitingParticipants || []).length,
        startedAt:    m.startedAt,
        createdAt:    m.createdAt,
    };
}

// ---- Meeting socket events ----
// These are registered inside the main io.on('connection') block via a helper
// so they share the authenticated userId / socket.user already set up there.
// We attach the handler registrar to the socket in the connection callback below.

function registerMeetingSocketHandlers(socket, userId) {

    // Join or request to join a meeting
    socket.on('meeting-join', async ({ meetingId, passcode, name }) => {
        try {
            const meeting = await Meeting.findOne({ meetingId });
            if (!meeting) { socket.emit('meeting-error', { meetingId, message: 'Meeting not found.' }); return; }
            if (meeting.status === 'ended') { socket.emit('meeting-error', { meetingId, message: 'This meeting has ended.' }); return; }
            if (meeting.locked && meeting.hostId !== userId) { socket.emit('meeting-error', { meetingId, message: 'This meeting is locked.' }); return; }
            if (meeting.passcode && meeting.passcode !== passcode && meeting.hostId !== userId) {
                socket.emit('meeting-error', { meetingId, message: 'Incorrect passcode.' }); return;
            }

            const me = await User.findById(userId).select('username name').lean();
            const participantName = name?.trim() || me?.name || me?.username || 'Guest';

            // Waiting room — send to waiting list unless host
            if (meeting.waitingRoom && meeting.hostId !== userId) {
                const alreadyWaiting = meeting.waitingParticipants.some((p) => p.userId === userId);
                if (!alreadyWaiting) {
                    meeting.waitingParticipants.push({ userId, username: me?.username || userId, name: participantName, role: 'attendee' });
                    await meeting.save();
                }
                socket.emit('meeting-waiting', { meetingId, message: 'Waiting for the host to let you in…' });
                io.to(meeting.hostId).emit('meeting-waiting-update', {
                    meetingId,
                    waiting: meeting.waitingParticipants.map((p) => ({ userId: p.userId, name: p.name, username: p.username })),
                });
                return;
            }

            await admitToMeeting(socket, userId, participantName, me?.username || userId, meeting, meeting.hostId === userId ? 'host' : 'attendee');
        } catch (err) {
            console.error('[meetings] join error:', err);
            socket.emit('meeting-error', { meetingId, message: 'Could not join meeting.' });
        }
    });

    // Host admits a waiting participant
    socket.on('meeting-admit', async ({ meetingId, targetUserId }) => {
        try {
            const meeting = await Meeting.findOne({ meetingId });
            if (!meeting || meeting.hostId !== userId) return;
            const waiting = meeting.waitingParticipants.find((p) => p.userId === targetUserId);
            if (!waiting) return;
            meeting.waitingParticipants = meeting.waitingParticipants.filter((p) => p.userId !== targetUserId);
            await meeting.save();

            // Tell the waiting socket to proceed
            io.to(targetUserId).emit('meeting-admitted', { meetingId });

            // Also tell the host the waiting list changed
            io.to(userId).emit('meeting-waiting-update', {
                meetingId,
                waiting: meeting.waitingParticipants.map((p) => ({ userId: p.userId, name: p.name, username: p.username })),
            });
        } catch (err) { console.error('[meetings] admit error:', err); }
    });

    // Waiting participant was admitted — now actually join
    socket.on('meeting-join-admitted', async ({ meetingId }) => {
        try {
            const meeting = await Meeting.findOne({ meetingId });
            if (!meeting || meeting.status === 'ended') return;
            const me = await User.findById(userId).select('username name').lean();
            await admitToMeeting(socket, userId, me?.name || me?.username || 'Guest', me?.username || userId, meeting, 'attendee');
        } catch (err) { console.error('[meetings] join-admitted error:', err); }
    });

    // Host denies a waiting participant
    socket.on('meeting-deny', async ({ meetingId, targetUserId }) => {
        try {
            const meeting = await Meeting.findOne({ meetingId });
            if (!meeting || meeting.hostId !== userId) return;
            meeting.waitingParticipants = meeting.waitingParticipants.filter((p) => p.userId !== targetUserId);
            await meeting.save();
            io.to(targetUserId).emit('meeting-denied', { meetingId, message: 'The host did not let you in.' });
            io.to(userId).emit('meeting-waiting-update', {
                meetingId,
                waiting: meeting.waitingParticipants.map((p) => ({ userId: p.userId, name: p.name, username: p.username })),
            });
        } catch (err) { console.error('[meetings] deny error:', err); }
    });

    // Leave meeting
    socket.on('meeting-leave', async ({ meetingId }) => {
        try {
            socket.leave(`meeting:${meetingId}`);
            const meeting = await Meeting.findOne({ meetingId });
            if (!meeting) return;
            meeting.participants = meeting.participants.map((p) =>
                p.userId === userId ? { ...p, leftAt: new Date() } : p
            );
            await meeting.save();
            io.to(`meeting:${meetingId}`).emit('meeting-participant-left', { meetingId, userId });

            // If host leaves, end meeting
            if (meeting.hostId === userId) {
                meeting.status  = 'ended';
                meeting.endedAt = new Date();
                await meeting.save();
                io.to(`meeting:${meetingId}`).emit('meeting-ended', { meetingId });
            }
        } catch (err) { console.error('[meetings] leave error:', err); }
    });

    // Host mutes/unmutes a participant
    socket.on('meeting-host-mute', async ({ meetingId, targetUserId, mute }) => {
        try {
            const meeting = await Meeting.findOne({ meetingId });
            if (!meeting || meeting.hostId !== userId) return;
            meeting.participants = meeting.participants.map((p) =>
                p.userId === targetUserId ? { ...p, micMuted: !!mute } : p
            );
            await meeting.save();
            io.to(`meeting:${meetingId}`).emit('meeting-participant-updated', {
                meetingId, userId: targetUserId, micMuted: !!mute,
            });
            io.to(targetUserId).emit('meeting-muted-by-host', { meetingId, mute });
        } catch (err) { console.error('[meetings] host-mute error:', err); }
    });

    // Host mutes ALL participants at once
    socket.on('meeting-mute-all', async ({ meetingId }) => {
        try {
            const meeting = await Meeting.findOne({ meetingId });
            if (!meeting || meeting.hostId !== userId) return;
            const otherIds = meeting.participants
                .filter((p) => p.userId !== userId)
                .map((p) => p.userId);
            meeting.participants = meeting.participants.map((p) =>
                p.userId === userId ? p : { ...p, micMuted: true }
            );
            await meeting.save();
            // Broadcast individual updates + muted-by-host to each participant
            otherIds.forEach((uid) => {
                io.to(`meeting:${meetingId}`).emit('meeting-participant-updated', { meetingId, userId: uid, micMuted: true });
                io.to(uid).emit('meeting-muted-by-host', { meetingId, mute: true });
            });
        } catch (err) { console.error('[meetings] mute-all error:', err); }
    });

    // Host removes a participant
    socket.on('meeting-remove-participant', async ({ meetingId, targetUserId }) => {
        try {
            const meeting = await Meeting.findOne({ meetingId });
            if (!meeting || meeting.hostId !== userId) return;
            meeting.participants = meeting.participants.filter((p) => p.userId !== targetUserId);
            await meeting.save();
            io.to(targetUserId).emit('meeting-removed', { meetingId });
            io.to(`meeting:${meetingId}`).emit('meeting-participant-left', { meetingId, userId: targetUserId });
        } catch (err) { console.error('[meetings] remove-participant error:', err); }
    });

    // Host locks/unlocks the meeting
    socket.on('meeting-set-lock', async ({ meetingId, locked }) => {
        try {
            const meeting = await Meeting.findOne({ meetingId });
            if (!meeting || meeting.hostId !== userId) return;
            meeting.locked = !!locked;
            await meeting.save();
            io.to(`meeting:${meetingId}`).emit('meeting-updated', meetingToDTO(meeting));
        } catch (err) { console.error('[meetings] set-lock error:', err); }
    });

    // Host toggles "only host can invite participants"
    socket.on('meeting-set-host-only-invite', async ({ meetingId, hostOnlyInvite }) => {
        try {
            const meeting = await Meeting.findOne({ meetingId });
            if (!meeting || meeting.hostId !== userId) return;
            meeting.hostOnlyInvite = !!hostOnlyInvite;
            await meeting.save();
            io.to(`meeting:${meetingId}`).emit('meeting-updated', meetingToDTO(meeting));
        } catch (err) { console.error('[meetings] set-host-only-invite error:', err); }
    });

    // In-meeting chat message
    socket.on('meeting-chat', async ({ meetingId, message }) => {
        try {
            const meeting = await Meeting.findOne({ meetingId, status: { $ne: 'ended' } });
            if (!meeting || !meeting.chatEnabled) return;
            const isParticipant = meeting.participants.some((p) => p.userId === userId);
            if (!isParticipant) return;
            const me = await User.findById(userId).select('username name').lean();
            const payload = {
                meetingId,
                from:    { userId, username: me?.username, name: me?.name || me?.username },
                message: String(message).trim().slice(0, 2000),
                at:      new Date().toISOString(),
            };
            io.to(`meeting:${meetingId}`).emit('meeting-chat', payload);
        } catch (err) { console.error('[meetings] chat error:', err); }
    });

    // WebRTC mesh signaling for meeting peers (same pattern as group calls)
    socket.on('meeting-signal', ({ meetingId, targetUserId, data }) => {
        io.to(targetUserId).emit('meeting-signal', { meetingId, fromUserId: userId, data });
    });

    // Non-verbal: raise hand
    socket.on('meeting-raise-hand', ({ meetingId, raised }) => {
        io.to(`meeting:${meetingId}`).emit('meeting-hand-raised', { meetingId, userId, raised });
    });

    // Non-verbal: emoji reaction
    socket.on('meeting-reaction', ({ meetingId, emoji }) => {
        io.to(`meeting:${meetingId}`).emit('meeting-reaction', { meetingId, userId, emoji });
    });
}

// Helper: do the actual room-join + DB write + broadcast
async function admitToMeeting(socket, userId, name, username, meeting, role) {
    const alreadyIn = meeting.participants.some((p) => p.userId === userId);
    if (!alreadyIn) {
        meeting.participants.push({ userId, username, name, role, joinedAt: new Date() });
        if (meeting.status === 'waiting') { meeting.status = 'active'; meeting.startedAt = new Date(); }
        await meeting.save();
    }

    socket.join(`meeting:${meeting.meetingId}`);

    const others = meeting.participants
        .filter((p) => p.userId !== userId && !p.leftAt)
        .map((p) => ({ userId: p.userId, username: p.username, name: p.name, role: p.role, micMuted: p.micMuted, camOff: p.camOff }));

    socket.emit('meeting-joined', {
        meetingId:    meeting.meetingId,
        title:        meeting.title,
        hostId:       meeting.hostId,
        locked:       meeting.locked,
        chatEnabled:  meeting.chatEnabled,
        waitingRoom:  meeting.waitingRoom,
        hostOnlyInvite: meeting.hostOnlyInvite || false,
        participants: others,
        myRole:       role,
    });

    socket.to(`meeting:${meeting.meetingId}`).emit('meeting-participant-joined', {
        meetingId: meeting.meetingId,
        participant: { userId, username, name, role, micMuted: false, camOff: false },
    });
}

const PORT = process.env.PORT || 5000;
server.on('error', (err) => {
    if (err.code === 'EADDRINUSE') {
        console.error(`Port ${PORT} in use, trying ${PORT + 1}`);
        server.listen(PORT + 1);
    } else {
        console.error('Server error:', err);
        process.exit(1);
    }
});

server.listen(PORT, '0.0.0.0', () => {
    console.log(`Server is Running on port ${PORT}`);
});