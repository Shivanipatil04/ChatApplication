const express = require('express');
const cors = require('cors');
const http = require('http');
const {Server} = require('socket.io');
const mongoose = require('mongoose');
const authRoutes = require('./Routes/authroutes');

const app = express();
const server = http.createServer(app);
const io = new Server(server, {
  cors: {
    origin: "http://localhost:5173",
    methods: ["GET", "POST"]
  }
});

app.use(cors());
app.use(express.json());
app.use('/api', authRoutes);

mongoose.connect("mongodb://localhost:27017/chatapp")
  .then(() => console.log('MongoDB connected'))
  .catch((err) => console.error('MongoDB connection error:', err));

io.on('connection', (socket)=>{
    console.log("User connected");

    socket.user = "Anonymous";
    //Handling message
    socket.on('msg', async (message) => {
        const chatData = {
            user: socket.user,
            msg: message,
            timeStamp: new Date().toISOString()
        };

        const chatmsg = new Chat(chatData);
        try {
            await chatmsg.save();
        } catch (err) {
            console.error("Error for storage", err);
        }

        io.emit('msg', chatData);
    });

    //handling users
    socket.on('username', (user) => {
        socket.user = user || 'Anonymous';
    });

    //handling disconnection
    socket.on('disconnect', () => {
        console.log("User disconnected");
    });
});

//structure of chat message
const chat = new mongoose.Schema({
    user: {
        type: String,
        required: true
    },
    msg: {
        type: String,
        required: true
    },
    timeStamp: {
        type: String,
        required: true
    }
});

const Chat = mongoose.model('Chat',chat);


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