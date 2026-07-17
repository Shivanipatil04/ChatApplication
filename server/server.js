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

const app = express();
const server = http.createServer(app);
const corsOptions = { origin: true, methods: ['GET', 'POST'] };
const io = new Server(server, {
  cors: {
    origin: true,
    methods: ['GET', 'POST']
  }
});

app.use(cors(corsOptions));
app.use(express.json());
app.use('/api/auth', authRoutes);

mongoose.connect(process.env.MONGO_URI)
.then(() => {
    console.log("MongoDB Connected");

    server.listen(PORT, () => {
        console.log(`Server running on ${PORT}`);
    });

})
.catch(err => {
    console.log(err);
});

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

io.on('connection', (socket)=>{
    if (!socket.user?.userId) {
        socket.disconnect();
        return;
    }

    console.log(`User connected: ${socket.user.email}`);
    socket.join(socket.user.userId);

    socket.on('msg', async ({ recipientId, message }) => {
        const text = typeof message === 'string' ? message.trim() : '';
        if (!text || !recipientId || recipientId === socket.user.userId) return;

        try {
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
            await chatmsg.save();
            const savedMessage = { ...chatData, id: chatmsg._id.toString() };

            io.to(socket.user.userId).to(recipientId).emit('msg', savedMessage);
        } catch (err) {
            console.error('Error for storage', err);
        }
    });

<<<<<<< Updated upstream
    socket.on('call-user', ({ recipientId, offer }) => {
    io.to(recipientId).emit('call-user', {
        offer,
        senderId: socket.user.userId,
    })
    })
=======
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

        if (
            offer &&
            sender?.friends.some(friend => friend.userId === targetUserId)
        ) {
            io.to(targetUserId).emit('incoming-call', {
                from: {
                    id: socket.user.userId,
                    username: sender.username
                },
                offer
            });
        }
    });

    socket.on('call-answer', async ({ callerId, answer }) => {
        const responder = await User.findById(socket.user.userId).select('friends');

        if (
            callerId &&
            answer &&
            responder?.friends.some(friend => friend.userId === callerId)
        ) {
            io.to(callerId).emit('call-answered', {
                answer
            });
        }
    });

    socket.on('ice-candidate', async ({ targetUserId, candidate }) => {
        const sender = await User.findById(socket.user.userId).select('friends');

        if (
            targetUserId &&
            candidate &&
            sender?.friends.some(friend => friend.userId === targetUserId)
        ) {
            io.to(targetUserId).emit('ice-candidate', {
                candidate
            });
        }
    });

    socket.on('call-end', async ({ targetUserId }) => {
        const sender = await User.findById(socket.user.userId).select('friends');

        if (
            targetUserId &&
            sender?.friends.some(friend => friend.userId === targetUserId)
        ) {
            io.to(targetUserId).emit('call-ended');
        }
    });
    
    socket.on("disconnect", () => {

        if(currentCall){
>>>>>>> Stashed changes

        io.to(otherUser).emit("call-ended");

        }

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

server.listen(PORT, '0.0.0.0', () => {
    console.log(`Server is Running on port ${PORT}`);
});
