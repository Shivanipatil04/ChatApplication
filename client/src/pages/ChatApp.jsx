import React, { useCallback, useEffect, useRef, useState } from 'react'
import axios from 'axios'
import { io } from 'socket.io-client'
import { useNavigate } from 'react-router-dom'

const API_URL = 'http://localhost:5000';

const mergeMessages = (...messageLists) => {
  const messagesById = new Map();
  messageLists.flat().forEach((message) => messagesById.set(message.id, message));
  return [...messagesById.values()].sort((a, b) => new Date(a.timeStamp) - new Date(b.timeStamp));
};

const ChatApp = () => {
  const user = JSON.parse(localStorage.getItem('chatUser') || '{}');
  const token = localStorage.getItem('chatToken');
  const [contacts, setContacts] = useState([]);
  const [conversations, setConversations] = useState([]);
  const [selectedContact, setSelectedContact] = useState(null);
  const [messages, setMessages] = useState([]);
  const [message, setMessage] = useState('');
  const [friendUsername, setFriendUsername] = useState('');
  const [friendError, setFriendError] = useState('');
  const [error, setError] = useState('');
  const socketRef = useRef(null);
  const selectedContactRef = useRef(null);
  const contactsRef = useRef([]);
  const navigate = useNavigate();

  const authorization = { headers: { Authorization: `Bearer ${token}` } };

  const logout = useCallback(() => {
    localStorage.removeItem('chatToken');
    localStorage.removeItem('chatUser');
    navigate('/login');
  }, [navigate]);

  useEffect(() => {
    selectedContactRef.current = selectedContact;
  }, [selectedContact]);

  useEffect(() => {
    contactsRef.current = contacts;
  }, [contacts]);

  useEffect(() => {
    const loadChatData = async () => {
      try {
        const [usersResponse, conversationsResponse] = await Promise.all([
          axios.get(`${API_URL}/api/friends`, { headers: { Authorization: `Bearer ${token}` } }),
          axios.get(`${API_URL}/api/conversations`, { headers: { Authorization: `Bearer ${token}` } }),
        ]);
        setContacts(usersResponse.data);
        setConversations(conversationsResponse.data);
      } catch (requestError) {
        setError(requestError.response?.data?.message || 'Could not load your chats.');
      }
    };
    loadChatData();

    const socket = io(API_URL, { auth: { token } });
    socketRef.current = socket;
    socket.on('connect_error', logout);
    socket.on('msg', (incomingMessage) => {
      const contactId = incomingMessage.senderId === user.id ? incomingMessage.recipientId : incomingMessage.senderId;
      const contact = contactsRef.current.find((item) => item.id === contactId);

      if (contact) {
        setConversations((previous) => [
          { ...contact, lastMessage: incomingMessage.msg, timeStamp: incomingMessage.timeStamp },
          ...previous.filter((item) => item.id !== contactId),
        ]);
      }
      if (selectedContactRef.current?.id === contactId) {
        setMessages((previous) => mergeMessages(previous, [incomingMessage]));
      }
    });

    return () => socket.disconnect();
  }, [logout, token, user.id]);

  const selectContact = async (contact) => {
    setSelectedContact(contact);
    setMessages([]);
    setError('');
    try {
      const { data } = await axios.get(`${API_URL}/api/messages/${contact.id}`, authorization);
      setMessages((previous) => mergeMessages(data, previous));
    } catch (requestError) {
      setError(requestError.response?.data?.message || 'Could not load this conversation.');
    }
  };

  const sendMessage = (event) => {
    event.preventDefault();
    if (!selectedContact || !message.trim()) return;
    socketRef.current?.emit('msg', { recipientId: selectedContact.id, message });
    setMessage('');
  };

  const addFriend = async (event) => {
    event.preventDefault();
    if (!friendUsername.trim()) return;
    setFriendError('');
    setError('');
    try {
      const username = friendUsername.trim().replace(/^@/, '');
      const { data } = await axios.post(`${API_URL}/api/friends`, { username }, authorization);
      setContacts((previous) => [...previous, data.friend]);
      setFriendUsername('');
    } catch (requestError) {
      setFriendError(requestError.response?.data?.message || 'Could not add friend.');
    }
  };

  const availableContacts = contacts.filter((contact) => !conversations.some((conversation) => conversation.id === contact.id));

  return (
    <div className="chat-layout">
      <aside className="chat-sidebar">
        <div className="chat-sidebar-header">
          <div><strong>{user.name}</strong><span className="username">@{user.username}</span></div>
          <button type="button" onClick={logout}>Log out</button>
        </div>
        <form className="add-friend" onSubmit={addFriend}>
          <label htmlFor="friend-username">Add friend by username</label>
          <input id="friend-username" value={friendUsername} onChange={(event) => setFriendUsername(event.target.value)} placeholder="e.g. alex1234" />
          <button type="submit">Add</button>
          {friendError && <p className="auth-error">{friendError}</p>}
        </form>
        <label className="new-chat-label" htmlFor="new-chat">Start a new chat</label>
        <select id="new-chat" defaultValue="" onChange={(event) => {
          const contact = availableContacts.find((item) => item.id === event.target.value);
          if (contact) selectContact(contact);
          event.target.value = '';
        }}>
          <option value="" disabled>Select a person</option>
          {availableContacts.map((contact) => <option key={contact.id} value={contact.id}>@{contact.username}</option>)}
        </select>
        <div className="conversation-list">
          {conversations.map((conversation) => (
            <button type="button" key={conversation.id} className={`conversation ${selectedContact?.id === conversation.id ? 'active' : ''}`} onClick={() => selectContact(conversation)}>
              <strong>@{conversation.username}</strong>
              <span>{conversation.lastMessage}</span>
            </button>
          ))}
          {!conversations.length && <p className="empty-chats">No chats yet. Start a new conversation.</p>}
        </div>
      </aside>

      <main className="conversation-panel">
        {selectedContact ? <>
          <header className="conversation-header"><h1>@{selectedContact.username}</h1></header>
          <div className="chat">
            {messages.map((item) => (
              <div key={item.id} className={`message ${item.senderId === user.id ? 'me' : ''}`}>
                <div className="text">{item.msg}</div>
                <div className="time">{new Date(item.timeStamp).toLocaleTimeString()}</div>
              </div>
            ))}
          </div>
          <form className="inputbar" onSubmit={sendMessage}>
            <input value={message} onChange={(event) => setMessage(event.target.value)} placeholder={`Message @${selectedContact.username}`} />
            <button type="submit">Send</button>
          </form>
        </> : <div className="empty-conversation">Select a person to start chatting.</div>}
        {error && <p className="auth-error">{error}</p>}
      </main>
    </div>
  )
}

export default ChatApp
