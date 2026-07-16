import React, { useState, useEffect } from 'react'
import { io } from 'socket.io-client'

const socket = io("http://localhost:5000");

const ChatApp = () => {
  const [user, setUser] = useState("");
  const [usernameInput, setUsernameInput] = useState("");
  const [message, setMessage] = useState("");
  const [messages, setMessages] = useState([]);

  useEffect(() => {
    socket.on('msg', (incomingmsg) => {
      setMessages((prev) => [...prev, incomingmsg]);
    });

    return () => {
      socket.off('msg');
    };
  }, []);

  const sendmsg = (e) => {
    e.preventDefault();
    if (!user.trim()) {
      alert('Please set your username first');
      return;
    }

    if (message.trim() !== "") {
      socket.emit('msg', message);
      setMessage("");
    }
  };

  const handleUsernameSubmit = (e) => {
    e.preventDefault();
    const chosenUser = usernameInput.trim();
    if (!chosenUser) return;

    setUser(chosenUser);
    socket.emit('username', chosenUser);
  };

  return (
    <div className='container' style={{margin: "40px auto", padding: "20px", maxWidth: "840px", background: "#f8fafc", color: "#1f2937", textAlign: "center", borderRadius: "14px"}}>

        <div className='username'>
          <form onSubmit={handleUsernameSubmit}>
            <label>Set your username:</label>
            <input
              type="text"
              value={usernameInput}
              onChange={(e) => setUsernameInput(e.target.value)}
              placeholder="Enter your name"
            />
            <button type="submit">Set Name</button>
          </form>
        </div>

        <div className='User'>
          <h1>{user ? `Hello, ${user}` : 'No name set'}</h1>
        </div>

        <div className='chat'>
          {messages.map((m, index) => (
            <div key={index} className={`message ${m.user === user ? 'me' : ''}`}>
              <div className="sender">{m.user}</div>
              <div className="text">{m.msg}</div>
              <div className="time">{new Date(m.timeStamp).toLocaleTimeString()}</div>
            </div>
          ))}
        </div>

        <div className='inputbar'>
            <form onSubmit={sendmsg}>
            <input
                type="text"
                value={message}
                onChange={(e) => setMessage(e.target.value)}
                placeholder="Typing a message..."
            />
            <button type="submit">Send</button>
            </form>
        </div>
    </div>
  )
}

export default ChatApp