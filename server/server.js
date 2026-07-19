require('dotenv').config();

const express = require('express');
const cors = require('cors');
const http = require('http');
const { Server } = require('socket.io');
const mongoose = require('mongoose');
const authRoutes = require('./Routes/authroutes');
const { auth, authenticateToken } = require('./middleware/auth');
const User = require('./models/User');
const Chat = require('./models/Chat');
const Group = require('./models/Group');
const GroupMessage = require('./models/GroupMessage');
const CallHistory = require('./models/CallHistory');

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
  // audio/image/file messages travel over the socket as base64 - bump the default 1MB cap a bit
  maxHttpBufferSize: 8 * 1024 * 1024,
});

app.use(cors(corsOptions));
app.use(express.json({ limit: '10mb' }));
app.use('/api/auth', authRoutes);

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

// key: callId -> { hostId, groupId, callType, participants: Map<userId, username>, invited: Set<userId> }
const activeGroupCalls = new Map();
const MAX_GROUP_CALL_PARTICIPANTS = 4;

const MESSAGE_TYPES = ['audio', 'image', 'file', 'location', 'contact'];
const MAX_ATTACHMENT_BYTES = 6 * 1024 * 1024; // rough cap for base64 payloads (see note below)

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
        case 'call': return message.callInfo?.status === 'missed' ? '📞 Missed call' : '📞 Call';
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

    // ---- Message delete (direct + group) ----
    socket.on('delete-message', async ({ messageId, isGroup, everyone }) => {
        try {
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

    // ---- WebRTC signaling handlers ----
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
                        if (call.participants.size === 0) activeGroupCalls.delete(callId);
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

            activeGroupCalls.set(callId, {
                hostId: userId,
                groupId: groupId || null,
                callType: callType === 'audio' ? 'audio' : 'video',
                participants: new Map([[userId, me.username]]),
                invited: new Set(uniqueTargets),
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

    socket.on('group-call-join', ({ callId }) => {
        const call = activeGroupCalls.get(callId);
        if (!call || (!call.invited.has(userId) && !call.participants.has(userId))) return;
        if (call.participants.size >= MAX_GROUP_CALL_PARTICIPANTS && !call.participants.has(userId)) {
            socket.emit('group-call-error', { message: 'This call is already full.' });
            return;
        }

        call.invited.delete(userId);
        call.participants.set(userId, socket.user.username);
        socket.join(`call:${callId}`);

        const existing = [...call.participants.entries()]
            .filter(([id]) => id !== userId)
            .map(([id, username]) => ({ userId: id, username }));
        socket.emit('group-call-state', { callId, participants: existing });

        socket.to(`call:${callId}`).emit('group-call-participant-joined', { callId, userId, username: socket.user.username });
    });

    // Generic SDP offer/answer/ICE-candidate relay between two participants of the same call.
    socket.on('group-call-signal', ({ callId, targetUserId, data }) => {
        const call = activeGroupCalls.get(callId);
        if (!call || !call.participants.has(userId) || !call.participants.has(targetUserId)) return;
        io.to(targetUserId).emit('group-call-signal', { callId, fromUserId: userId, data });
    });

    socket.on('group-call-decline', ({ callId }) => {
        const call = activeGroupCalls.get(callId);
        if (!call) return;
        call.invited.delete(userId);
        io.to(call.hostId).emit('group-call-declined', { callId, userId });
    });

    socket.on('group-call-leave', ({ callId }) => {
        const call = activeGroupCalls.get(callId);
        if (!call) return;
        call.participants.delete(userId);
        call.invited.delete(userId);
        socket.leave(`call:${callId}`);
        io.to(`call:${callId}`).emit('group-call-participant-left', { callId, userId });
        if (call.participants.size === 0) activeGroupCalls.delete(callId);
    });
});

app.get('/api/friends', auth, async (req, res) => {
    try {
        const me = await User.findById(req.user.userId).select('friends blockedUsers').lean();
        const friendIds = (me?.friends || []).map((friend) => friend.userId);
        const friendUsers = await User.find({ _id: { $in: friendIds } }).select('lastSeen').lean();
        const lastSeenById = new Map(friendUsers.map((entry) => [entry._id.toString(), entry.lastSeen]));
        const blockedSet = new Set(me?.blockedUsers || []);
        res.json((me?.friends || []).map((friend) => ({
            id: friend.userId,
            username: friend.username,
            lastSeen: lastSeenById.get(friend.userId) || null,
            blockedByMe: blockedSet.has(friend.userId),
        })));
    } catch (err) {
        console.error('Could not load friends:', err);
        res.status(500).json({ message: 'Could not load friends' });
    }
});

app.post('/api/friends', auth, async (req, res) => {
    const username = req.body.username?.trim().replace(/^@/, '').toLowerCase();
    if (!username) return res.status(400).json({ message: 'Username is required' });

    try {
        const user = await User.findById(req.user.userId);
        const friend = await User.findOne({ username });
        if (!friend) return res.status(404).json({ message: 'No user found with that username' });
        if (friend._id.toString() === user._id.toString()) return res.status(400).json({ message: 'You cannot add yourself' });
        if (user.friends.some((item) => item.userId === friend._id.toString())) return res.status(409).json({ message: 'This user is already your friend' });

        user.friends.push({ userId: friend._id.toString(), username: friend.username });
        friend.friends.push({ userId: user._id.toString(), username: user.username });
        await Promise.all([user.save(), friend.save()]);
        return res.status(201).json({ friend: { id: friend._id.toString(), username: friend.username, lastSeen: friend.lastSeen, blockedByMe: false } });
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
        const groups = await Group.find({ 'members.userId': req.user.userId }).lean();
        const groupIds = groups.map((group) => group._id.toString());
        const messages = await GroupMessage.find({ groupId: { $in: groupIds } }).sort({ timeStamp: -1 }).lean();
        const latestByGroup = new Map();
        messages.forEach((message) => !latestByGroup.has(message.groupId) && latestByGroup.set(message.groupId, message));
        const result = groups.map((group) => {
            const latest = latestByGroup.get(group._id.toString());
            return {
                id: group._id.toString(), name: group.name, description: group.description || '', createdBy: group.createdBy,
                members: group.members, lastMessage: previewFor(latest), timeStamp: latest?.timeStamp || group.createdAt, createdAt: group.createdAt,
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

        const contacts = await User.find({ _id: { $in: [...latestByContact.keys()] } }).select('username').lean();
        const contactsById = new Map(contacts.map((contact) => [contact._id.toString(), contact]));
        const conversations = [...latestByContact.entries()]
            .map(([contactId, message]) => {
                const contact = contactsById.get(contactId);
                if (!contact) return null;
                return { id: contactId, username: contact.username, lastMessage: previewFor(message), timeStamp: message.timeStamp };
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

// ---- Call history ----
app.get('/api/calls', auth, async (req, res) => {
    try {
        const userId = req.user.userId;
        const calls = await CallHistory.find({ $or: [{ callerId: userId }, { receiverId: userId }] })
            .sort({ startTime: -1 })
            .limit(100)
            .lean();
        res.json(calls.map((call) => ({
            id: call._id.toString(),
            direction: call.callerId === userId ? 'outgoing' : 'incoming',
            contactId: call.callerId === userId ? call.receiverId : call.callerId,
            contactUsername: call.callerId === userId ? call.receiverUsername : call.callerUsername,
            callType: call.callType,
            status: call.status,
            startTime: call.startTime,
            duration: call.duration,
        })));
    } catch (err) {
        console.error('Could not load call history:', err);
        res.status(500).json({ message: 'Could not load call history' });
    }
});

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