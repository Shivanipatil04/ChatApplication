require('dotenv').config();

const express = require('express');
const cors = require('cors');
const http = require('http');
const {Server} = require('socket.io');
const mongoose = require('mongoose');
const authRoutes = require('./Routes/authroutes');
const { auth, authenticateToken } = require('./middleware/auth');
const User = require('./models/User');
const Chat = require('./models/Chat');
const Group = require('./models/Group');
const GroupMessage = require('./models/GroupMessage');

const app = express();
const server = http.createServer(app);
const clientOrigins = ['http://localhost:5173', 'http://localhost:5174'];
const io = new Server(server, {
  cors: {
    origin: clientOrigins,
    methods: ["GET", "POST"]
  }
});

app.use(cors({ origin: clientOrigins, methods: ['GET', 'POST'] }));
app.use(express.json());
app.use('/api/auth', authRoutes);

mongoose.connect("mongodb://localhost:27017/chatapp")
  .then(() => console.log('MongoDB connected'))
  .catch((err) => console.error('MongoDB connection error:', err));

io.use((socket, next) => {
    try {
        socket.user = authenticateToken(socket.handshake.auth?.token);
        next();
    } catch {
        next(new Error('Authentication required'));
    }
});

io.on('connection', (socket)=>{
    console.log(`User connected: ${socket.user.email}`);
    socket.join(socket.user.userId);
    Group.find({ 'members.userId': socket.user.userId }).select('_id').lean()
        .then((groups) => groups.forEach((group) => socket.join(`group:${group._id}`)))
        .catch((err) => console.error('Could not join group rooms:', err));

    socket.on('msg', async ({ recipientId, message }) => {
        const text = typeof message === 'string' ? message.trim() : '';
        if (!text || !recipientId || recipientId === socket.user.userId) return;

        const sender = await User.findById(socket.user.userId).select('friends');
        const isFriend = sender?.friends.some((friend) => friend.userId === recipientId);
        if (!isFriend) return;

        const chatData = {
            senderId: socket.user.userId,
            recipientId,
            user: socket.user.name,
            msg: text,
            timeStamp: new Date().toISOString()
        };

        const chatmsg = new Chat(chatData);
        try {
            await chatmsg.save();
            const savedMessage = { ...chatData, id: chatmsg._id.toString() };
            io.to(socket.user.userId).to(recipientId).emit('msg', savedMessage);
        } catch (err) {
            console.error("Error for storage", err);
        }
    });

    socket.on('join-group', async ({ groupId }) => {
        const group = await Group.findOne({ _id: groupId, 'members.userId': socket.user.userId }).select('_id');
        if (group) socket.join(`group:${groupId}`);
    });

    socket.on('group-msg', async ({ groupId, message }) => {
        const text = typeof message === 'string' ? message.trim() : '';
        if (!text || !groupId) return;
        try {
            const group = await Group.findOne({ _id: groupId, 'members.userId': socket.user.userId }).select('_id');
            if (!group) return;
            const saved = await GroupMessage.create({
                groupId,
                senderId: socket.user.userId,
                username: socket.user.username,
                msg: text,
                timeStamp: new Date().toISOString(),
            });
            io.to(`group:${groupId}`).emit('group-msg', {
                id: saved._id.toString(), groupId, senderId: saved.senderId,
                username: saved.username, msg: saved.msg, timeStamp: saved.timeStamp,
            });
        } catch (err) {
            console.error('Could not save group message:', err);
        }
    });

    socket.on('call-user', async ({ targetUserId, offer }) => {
        const sender = await User.findById(socket.user.userId).select('friends username');
        if (offer && sender?.friends.some((friend) => friend.userId === targetUserId)) {
            io.to(targetUserId).emit('incoming-call', { from: { id: socket.user.userId, username: sender.username }, offer });
        }
    });

    socket.on('call-answer', async ({ callerId, answer }) => {
        const responder = await User.findById(socket.user.userId).select('friends');
        if (callerId && answer && responder?.friends.some((friend) => friend.userId === callerId)) {
            io.to(callerId).emit('call-answered', { answer });
        }
    });

    socket.on('ice-candidate', async ({ targetUserId, candidate }) => {
        const sender = await User.findById(socket.user.userId).select('friends');
        if (targetUserId && candidate && sender?.friends.some((friend) => friend.userId === targetUserId)) {
            io.to(targetUserId).emit('ice-candidate', { candidate });
        }
    });

    socket.on('call-end', async ({ targetUserId }) => {
        const sender = await User.findById(socket.user.userId).select('friends');
        if (targetUserId && sender?.friends.some((friend) => friend.userId === targetUserId)) {
            io.to(targetUserId).emit('call-ended');
        }
    });


    socket.on('disconnect', () => {
        console.log("User disconnected");
    });
});

app.get('/api/friends', auth, async (req, res) => {
    try {
        const user = await User.findById(req.user.userId).select('friends').lean();
        res.json((user?.friends || []).map((friend) => ({ id: friend.userId, username: friend.username })));
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
        return res.status(201).json({ friend: { id: friend._id.toString(), username: friend.username } });
    } catch (err) {
        console.error('Could not add friend:', err);
        return res.status(500).json({ message: 'Could not add friend' });
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
        res.status(201).json({ id: group._id.toString(), name: group.name, members: group.members, lastMessage: '', timeStamp: group.createdAt });
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
            return { id: group._id.toString(), name: group.name, members: group.members, lastMessage: latest?.msg || '', timeStamp: latest?.timeStamp || group.createdAt };
        }).sort((a, b) => new Date(b.timeStamp) - new Date(a.timeStamp));
        res.json(result);
    } catch (err) {
        console.error('Could not load groups:', err);
        res.status(500).json({ message: 'Could not load groups' });
    }
});

app.get('/api/groups/:groupId/messages', auth, async (req, res) => {
    try {
        const group = await Group.findOne({ _id: req.params.groupId, 'members.userId': req.user.userId }).select('_id');
        if (!group) return res.status(403).json({ message: 'You are not a member of this group' });
        const messages = await GroupMessage.find({ groupId: group._id.toString() }).sort({ timeStamp: 1 }).lean();
        res.json(messages.map((message) => ({ id: message._id.toString(), groupId: message.groupId, senderId: message.senderId, username: message.username, msg: message.msg, timeStamp: message.timeStamp })));
    } catch (err) {
        console.error('Could not load group messages:', err);
        res.status(500).json({ message: 'Could not load group messages' });
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
                return contact && {
                    id: contactId,
                    username: contact.username,
                    lastMessage: message.msg,
                    timeStamp: message.timeStamp,
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
        }).sort({ timeStamp: 1 }).lean();
        res.json(messages.map((message) => ({
            id: message._id.toString(),
            senderId: message.senderId,
            recipientId: message.recipientId,
            user: message.user,
            msg: message.msg,
            timeStamp: message.timeStamp,
        })));
    } catch (err) {
        console.error('Could not load messages:', err);
        res.status(500).json({ message: 'Could not load messages' });
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

server.listen(PORT, () => {
    console.log(`Server is Running on port ${PORT}`);
});
