import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { io } from 'socket.io-client'
import { useNavigate } from 'react-router-dom'
import { API_URL, api } from '../config/api'
const RTC_CONFIGURATION = { iceServers: [{ urls: 'stun:stun.l.google.com:19302' }] };

const mergeMessages = (...lists) => {
  const byId = new Map();
  lists.flat().forEach((item) => byId.set(item.id, item));
  return [...byId.values()].sort((a, b) => new Date(a.timeStamp) - new Date(b.timeStamp));
};

const ChatApp = () => {
  const user = JSON.parse(localStorage.getItem('chatUser') || '{}');
  const token = localStorage.getItem('chatToken');
  const authorization = useMemo(() => ({ headers: { Authorization: `Bearer ${token}` } }), [token]);
  const [contacts, setContacts] = useState([]);
  const [conversations, setConversations] = useState([]);
  const [groups, setGroups] = useState([]);
  const [selected, setSelected] = useState(null);
  const [messages, setMessages] = useState([]);
  const [message, setMessage] = useState('');
  const [friendUsername, setFriendUsername] = useState('');
  const [groupName, setGroupName] = useState('');
  const [groupMembers, setGroupMembers] = useState([]);
  const [error, setError] = useState('');
  const [incomingCall, setIncomingCall] = useState(null);
  const [activeCall, setActiveCall] = useState(null);
  const [localStream, setLocalStream] = useState(null);
  const [remoteStream, setRemoteStream] = useState(null);
  const socketRef = useRef(null);
  const selectedRef = useRef(null);
  const contactsRef = useRef([]);
  const groupsRef = useRef([]);
  const peerConnectionRef = useRef(null);
  const callTargetRef = useRef(null);
  const queuedCandidatesRef = useRef([]);
  const localVideoRef = useRef(null);
  const remoteVideoRef = useRef(null);
  const localStreamRef = useRef(null);
  const navigate = useNavigate();

  const logout = useCallback(() => {
    localStorage.removeItem('chatToken');
    localStorage.removeItem('chatUser');
    navigate('/login');
  }, [navigate]);

  useEffect(() => { selectedRef.current = selected; }, [selected]);
  useEffect(() => { contactsRef.current = contacts; }, [contacts]);
  useEffect(() => { groupsRef.current = groups; }, [groups]);
  useEffect(() => { localStreamRef.current = localStream; if (localVideoRef.current) localVideoRef.current.srcObject = localStream; }, [localStream]);
  useEffect(() => { if (remoteVideoRef.current) remoteVideoRef.current.srcObject = remoteStream; }, [remoteStream]);

  const closeCall = useCallback((notify = true) => {
    if (notify && callTargetRef.current) socketRef.current?.emit('call-end', { targetUserId: callTargetRef.current });
    peerConnectionRef.current?.close();
    peerConnectionRef.current = null;
    localStreamRef.current?.getTracks().forEach((track) => track.stop());
    setLocalStream(null);
    setRemoteStream(null);
    setActiveCall(null);
    setIncomingCall(null);
    callTargetRef.current = null;
    queuedCandidatesRef.current = [];
  }, []);

  useEffect(() => {
    const loadData = async () => {
      try {
        const [friendResult, conversationResult, groupResult] = await Promise.all([
          api.get('/api/friends', authorization),
          api.get('/api/conversations', authorization),
          api.get('/api/groups', authorization),
        ]);
        setContacts(friendResult.data);
        setConversations(conversationResult.data);
        setGroups(groupResult.data);
      } catch (requestError) {
        setError(requestError.response?.data?.message || 'Could not load chats.');
      }
    };
    loadData();

    const socket = io(API_URL, {
      auth: { token },
      transports: ['websocket', 'polling'],
      reconnection: true,
    });

    socketRef.current = socket;
    socket.on('connect_error', logout);
    socket.on('msg', (item) => {
      const contactId = item.senderId === user.id ? item.recipientId : item.senderId;
      const contact = contactsRef.current.find((entry) => entry.id === contactId);
      if (contact) setConversations((previous) => [{ ...contact, lastMessage: item.msg, timeStamp: item.timeStamp }, ...previous.filter((entry) => entry.id !== contactId)]);
      if (selectedRef.current?.type === 'direct' && selectedRef.current.data.id === contactId) setMessages((previous) => mergeMessages(previous, [item]));
    });
    socket.on('group-msg', (item) => {
      const group = groupsRef.current.find((entry) => entry.id === item.groupId);
      if (group) setGroups((previous) => [{ ...group, lastMessage: item.msg, timeStamp: item.timeStamp }, ...previous.filter((entry) => entry.id !== item.groupId)]);
      if (selectedRef.current?.type === 'group' && selectedRef.current.data.id === item.groupId) setMessages((previous) => mergeMessages(previous, [item]));
    });
    socket.on('incoming-call', (call) => {
      const contact = contactsRef.current.find((entry) => entry.id === call.from.id) || call.from;
      setIncomingCall({ ...call, contact });
    });
    socket.on('call-answered', async ({ answer }) => {
      if (peerConnectionRef.current) await peerConnectionRef.current.setRemoteDescription(new RTCSessionDescription(answer));
    });
    socket.on('ice-candidate', async ({ candidate }) => {
      if (peerConnectionRef.current?.remoteDescription) await peerConnectionRef.current.addIceCandidate(new RTCIceCandidate(candidate));
      else queuedCandidatesRef.current.push(candidate);
    });
    socket.on('call-ended', () => closeCall(false));

    return () => { closeCall(false); socket.disconnect(); };
  }, [authorization, closeCall, logout, token, user.id]);

  const createPeerConnection = (targetUserId, stream) => {
    const peer = new RTCPeerConnection(RTC_CONFIGURATION);
    callTargetRef.current = targetUserId;
    stream.getTracks().forEach((track) => peer.addTrack(track, stream));
    peer.onicecandidate = ({ candidate }) => candidate && socketRef.current?.emit('ice-candidate', { targetUserId, candidate });
    peer.ontrack = ({ streams }) => setRemoteStream(streams[0]);
    peerConnectionRef.current = peer;
    return peer;
  };

  const addQueuedCandidates = async () => {
    const peer = peerConnectionRef.current;
    for (const candidate of queuedCandidatesRef.current) await peer.addIceCandidate(new RTCIceCandidate(candidate));
    queuedCandidatesRef.current = [];
  };

  const startCall = async () => {
    if (selected?.type !== 'direct') return;
    try {
      const stream = await navigator.mediaDevices.getUserMedia({ video: true, audio: true });
      setLocalStream(stream);
      setActiveCall(selected.data);
      const peer = createPeerConnection(selected.data.id, stream);
      const offer = await peer.createOffer();
      await peer.setLocalDescription(offer);
      socketRef.current?.emit('call-user', { targetUserId: selected.data.id, offer });
    } catch {
      setError('Camera or microphone access is required to start a video call.');
      closeCall(false);
    }
  };

  const acceptCall = async () => {
    if (!incomingCall) return;
    try {
      const stream = await navigator.mediaDevices.getUserMedia({ video: true, audio: true });
      setLocalStream(stream);
      setActiveCall(incomingCall.contact);
      const peer = createPeerConnection(incomingCall.from.id, stream);
      await peer.setRemoteDescription(new RTCSessionDescription(incomingCall.offer));
      await addQueuedCandidates();
      const answer = await peer.createAnswer();
      await peer.setLocalDescription(answer);
      socketRef.current?.emit('call-answer', { callerId: incomingCall.from.id, answer });
      setIncomingCall(null);
    } catch {
      setError('Camera or microphone access is required to answer this call.');
      closeCall(true);
    }
  };

  const selectChat = async (type, data) => {
    setSelected({ type, data });
    setMessages([]);
    setError('');
    try {
      const url = type === 'group' ? `/api/groups/${data.id}/messages` : `/api/messages/${data.id}`;
      const result = await api.get(url, authorization);
      setMessages((previous) => mergeMessages(result.data, previous));
      if (type === 'group') socketRef.current?.emit('join-group', { groupId: data.id });
    } catch (requestError) {
      setError(requestError.response?.data?.message || 'Could not load this conversation.');
    }
  };

  const sendMessage = (event) => {
    event.preventDefault();
    if (!selected || !message.trim()) return;
    if (selected.type === 'group') socketRef.current?.emit('group-msg', { groupId: selected.data.id, message });
    else socketRef.current?.emit('msg', { recipientId: selected.data.id, message });
    setMessage('');
  };

  const addFriend = async (event) => {
    event.preventDefault();
    try {
      const username = friendUsername.trim().replace(/^@/, '');
      const result = await api.post('/api/friends', { username }, authorization);
      setContacts((previous) => [...previous, result.data.friend]);
      setFriendUsername('');
    } catch (requestError) { setError(requestError.response?.data?.message || 'Could not add friend.'); }
  };

  const createGroup = async (event) => {
    event.preventDefault();
    try {
      const result = await api.post('/api/groups', { name: groupName, memberIds: groupMembers }, authorization);
      setGroups((previous) => [result.data, ...previous]);
      setGroupName('');
      setGroupMembers([]);
      socketRef.current?.emit('join-group', { groupId: result.data.id });
      selectChat('group', result.data);
    } catch (requestError) { setError(requestError.response?.data?.message || 'Could not create group.'); }
  };

  const availableContacts = contacts.filter((contact) => !conversations.some((chat) => chat.id === contact.id));

  return <div className="chat-layout">
    <aside className="chat-sidebar">
      <div className="chat-sidebar-header"><div><strong>{user.name}</strong><span className="username">@{user.username}</span></div><button type="button" onClick={logout}>Log out</button></div>
      <form className="add-friend" onSubmit={addFriend}><label htmlFor="friend-username">Add friend by username</label><input id="friend-username" value={friendUsername} onChange={(event) => setFriendUsername(event.target.value)} placeholder="@alex1234" /><button type="submit">Add</button></form>
      <label className="new-chat-label" htmlFor="new-chat">Start a new chat</label>
      <select id="new-chat" defaultValue="" onChange={(event) => { const contact = availableContacts.find((item) => item.id === event.target.value); if (contact) selectChat('direct', contact); event.target.value = ''; }}><option value="" disabled>Select a friend</option>{availableContacts.map((contact) => <option key={contact.id} value={contact.id}>@{contact.username}</option>)}</select>
      <form className="group-form" onSubmit={createGroup}>
        <label>Create group</label><input value={groupName} onChange={(event) => setGroupName(event.target.value)} placeholder="Group name" />
        <select multiple value={groupMembers} onChange={(event) => setGroupMembers([...event.target.selectedOptions].map((option) => option.value))}>{contacts.map((contact) => <option key={contact.id} value={contact.id}>@{contact.username}</option>)}</select>
        <button type="submit">Create group</button>
      </form>
      <div className="conversation-list"><p className="section-label">Chats</p>{conversations.map((chat) => <button type="button" key={chat.id} className={`conversation ${selected?.type === 'direct' && selected.data.id === chat.id ? 'active' : ''}`} onClick={() => selectChat('direct', chat)}><strong>@{chat.username}</strong><span>{chat.lastMessage}</span></button>)}{!conversations.length && <p className="empty-chats">No private chats yet.</p>}</div>
      <div className="conversation-list"><p className="section-label">Groups</p>{groups.map((group) => <button type="button" key={group.id} className={`conversation ${selected?.type === 'group' && selected.data.id === group.id ? 'active' : ''}`} onClick={() => selectChat('group', group)}><strong>{group.name}</strong><span>{group.lastMessage || `${group.members.length} members`}</span></button>)}{!groups.length && <p className="empty-chats">No groups yet.</p>}</div>
    </aside>
    <main className="conversation-panel">
      {selected ? <><header className="conversation-header"><h1>{selected.type === 'group' ? selected.data.name : `@${selected.data.username}`}</h1>{selected.type === 'direct' && <button type="button" onClick={startCall}>Video call</button>}</header>
        <div className="chat">{messages.map((item) => <div key={item.id} className={`message ${item.senderId === user.id ? 'me' : ''}`}>{selected.type === 'group' && <div className="sender">@{item.username}</div>}<div className="text">{item.msg}</div><div className="time">{new Date(item.timeStamp).toLocaleTimeString()}</div></div>)}</div>
        <form className="inputbar" onSubmit={sendMessage}><input value={message} onChange={(event) => setMessage(event.target.value)} placeholder="Type a message" /><button type="submit">Send</button></form>
      </> : <div className="empty-conversation">Select a chat, create a group, or start a new conversation.</div>}
      {error && <p className="auth-error">{error}</p>}
    </main>
    {incomingCall && <div className="call-modal"><p>@{incomingCall.contact.username} is calling</p><button type="button" onClick={acceptCall}>Accept</button><button type="button" onClick={() => closeCall(true)}>Decline</button></div>}
    {activeCall && <div className="call-modal video-call"><p>Video call with @{activeCall.username}</p><div><video ref={localVideoRef} autoPlay muted playsInline /><video ref={remoteVideoRef} autoPlay playsInline /></div><button type="button" onClick={() => closeCall(true)}>End call</button></div>}
  </div>
}

export default ChatApp
