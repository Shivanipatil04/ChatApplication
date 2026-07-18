import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { io } from 'socket.io-client'
import { useNavigate } from 'react-router-dom'
import { API_URL, api } from '../config/api'
import {
  Video, Search, MoreVertical, Paperclip, Send, X, MessageSquarePlus,
  UsersRound, LogOut, CheckCheck, ChevronDown, PhoneOff, ArrowLeft,
  Smile, Camera, Mic, FileText, Image as ImageIcon, Headphones, MapPin,
  User as UserIcon,
} from 'lucide-react'
import './ChatApp.css'

const RTC_CONFIGURATION = { iceServers: [{ urls: 'stun:stun.l.google.com:19302' }] };

const mergeMessages = (...lists) => {
  const byId = new Map();
  lists.flat().forEach((item) => byId.set(item.id, item));
  return [...byId.values()].sort((a, b) => new Date(a.timeStamp) - new Date(b.timeStamp));
};

const formatDateLabel = (iso) => {
  const date = new Date(iso);
  const today = new Date();
  const yesterday = new Date();
  yesterday.setDate(today.getDate() - 1);
  const sameDay = (a, b) => a.toDateString() === b.toDateString();
  if (sameDay(date, today)) return 'TODAY';
  if (sameDay(date, yesterday)) return 'YESTERDAY';
  return date.toLocaleDateString([], { day: 'numeric', month: 'short', year: 'numeric' });
};

const initialOf = (name = '') => name.trim().charAt(0).toUpperCase() || '?';

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

  // ---- UI-only state ----
  const [searchQuery, setSearchQuery] = useState('');
  const [activePopover, setActivePopover] = useState(null); // 'newChat' | 'newGroup' | null
  const [infoPanel, setInfoPanel] = useState(null); // 'self' | 'contact' | null
  const [activeTab, setActiveTab] = useState('chats'); // 'chats' | 'status' | 'calls' (mobile view)
  const [onlineUserIds, setOnlineUserIds] = useState(() => new Set());
  const [lastSeenMap, setLastSeenMap] = useState({}); // contactId -> ISO string
  const [typingMap, setTypingMap] = useState({}); // direct: contactId -> boolean | group: groupId -> Set(usernames)

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
  const chatScrollRef = useRef(null);
  const typingTimeoutRef = useRef(null);
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
  useEffect(() => {
    if (chatScrollRef.current) chatScrollRef.current.scrollTop = chatScrollRef.current.scrollHeight;
  }, [messages, selected]);

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
        setLastSeenMap(Object.fromEntries(friendResult.data.filter((f) => f.lastSeen).map((f) => [f.id, f.lastSeen])));
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
    socket.on('connect_error', (err) => { console.error('[webrtc] socket connect_error', err); logout(); });
    socket.on('msg', (item) => {
      const contactId = item.senderId === user.id ? item.recipientId : item.senderId;
      const contact = contactsRef.current.find((entry) => entry.id === contactId);
      if (contact) setConversations((previous) => [{ ...contact, lastMessage: item.msg, timeStamp: item.timeStamp }, ...previous.filter((entry) => entry.id !== contactId)]);
      if (selectedRef.current?.type === 'direct' && selectedRef.current.data.id === contactId) setMessages((previous) => mergeMessages(previous, [item]));
      setTypingMap((previous) => ({ ...previous, [contactId]: false }));
    });
    socket.on('group-msg', (item) => {
      const group = groupsRef.current.find((entry) => entry.id === item.groupId);
      if (group) setGroups((previous) => [{ ...group, lastMessage: item.msg, timeStamp: item.timeStamp }, ...previous.filter((entry) => entry.id !== item.groupId)]);
      if (selectedRef.current?.type === 'group' && selectedRef.current.data.id === item.groupId) setMessages((previous) => mergeMessages(previous, [item]));
      setTypingMap((previous) => {
        const current = new Set(previous[item.groupId] || []);
        current.delete(item.username);
        return { ...previous, [item.groupId]: current };
      });
    });
    socket.on('presence-bulk', ({ onlineUserIds: ids }) => setOnlineUserIds(new Set(ids)));
    socket.on('presence', ({ userId: id, online, lastSeen }) => {
      setOnlineUserIds((previous) => {
        const next = new Set(previous);
        if (online) next.add(id); else next.delete(id);
        return next;
      });
      if (!online) setLastSeenMap((previous) => ({ ...previous, [id]: lastSeen }));
    });
    socket.on('typing', ({ userId: fromId, username: fromUsername, groupId, isTyping }) => {
      if (groupId) {
        setTypingMap((previous) => {
          const current = new Set(previous[groupId] || []);
          if (isTyping) current.add(fromUsername); else current.delete(fromUsername);
          return { ...previous, [groupId]: current };
        });
      } else {
        setTypingMap((previous) => ({ ...previous, [fromId]: isTyping }));
      }
    });
    socket.on('incoming-call', (call) => {
      console.log('[webrtc] incoming-call', call && call.from && call.from.id);
      const contact = contactsRef.current.find((entry) => entry.id === call.from.id) || call.from;
      setIncomingCall({ ...call, contact });
    });

    socket.on('call-answered', async ({ answer }) => {
      console.log('[webrtc] call-answered received');
      try {
        if (!peerConnectionRef.current) {
          console.warn('[webrtc] call-answered but no peerConnection');
          return;
        }
        await peerConnectionRef.current.setRemoteDescription(new RTCSessionDescription(answer));
        console.log('[webrtc] setRemoteDescription (answer) complete');
        await addQueuedCandidates();
      } catch (err) {
        console.error('[webrtc] error handling call-answered', err);
      }
    });

    socket.on('ice-candidate', async ({ candidate }) => {
      console.log('[webrtc] received ice-candidate', candidate);
      try {
        if (peerConnectionRef.current?.remoteDescription) {
          await peerConnectionRef.current.addIceCandidate(new RTCIceCandidate(candidate));
          console.log('[webrtc] added remote candidate');
        } else {
          queuedCandidatesRef.current.push(candidate);
          console.log('[webrtc] queued remote candidate');
        }
      } catch (err) {
        console.error('[webrtc] error adding remote candidate', err);
      }
    });

    socket.on('call-ended', () => closeCall(false));

    return () => { closeCall(false); socket.disconnect(); };
  }, [authorization, closeCall, logout, token, user.id]);

  const createPeerConnection = (targetUserId, stream) => {
    if (peerConnectionRef.current) {
      console.warn('[webrtc] createPeerConnection: existing peer detected - closing');
      try { peerConnectionRef.current.close(); } catch (e) { /* ignore */ }
      peerConnectionRef.current = null;
      queuedCandidatesRef.current = [];
    }

    const peer = new RTCPeerConnection(RTC_CONFIGURATION);
    callTargetRef.current = targetUserId;
    stream.getTracks().forEach((track) => {
      const sender = peer.addTrack(track, stream);
      console.log('[webrtc] added local track', track.kind, sender && sender.track && sender.track.kind);
    });

    peer.onicecandidate = ({ candidate }) => {
      console.log('[webrtc] onicecandidate', candidate);
      if (candidate) socketRef.current?.emit('ice-candidate', { targetUserId, candidate });
    };

    peer.ontrack = (event) => {
      console.log('[webrtc] ontrack', event);
      const stream = event.streams && event.streams[0];
      if (stream) {
        console.log('[webrtc] remote stream received', stream.id);
        setRemoteStream(stream);
      }
    };

    peer.oniceconnectionstatechange = () => console.log('[webrtc] iceConnectionState', peer.iceConnectionState);
    peer.onconnectionstatechange = () => console.log('[webrtc] connectionState', peer.connectionState);

    peerConnectionRef.current = peer;
    return peer;
  };

  const addQueuedCandidates = async () => {
    const peer = peerConnectionRef.current;
    if (!peer) return;
    console.log('[webrtc] addQueuedCandidates count=', queuedCandidatesRef.current.length);
    for (const candidate of queuedCandidatesRef.current) {
      try {
        await peer.addIceCandidate(new RTCIceCandidate(candidate));
        console.log('[webrtc] added queued candidate', candidate);
      } catch (err) {
        console.error('[webrtc] error adding queued candidate', err);
      }
    }
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
      console.log('[webrtc] created offer');
      await peer.setLocalDescription(offer);
      console.log('[webrtc] setLocalDescription (offer)');
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
      console.log('[webrtc] setting remote description (offer)');
      await peer.setRemoteDescription(new RTCSessionDescription(incomingCall.offer));
      console.log('[webrtc] setRemoteDescription (offer) complete');
      await addQueuedCandidates();
      const answer = await peer.createAnswer();
      console.log('[webrtc] created answer');
      await peer.setLocalDescription(answer);
      console.log('[webrtc] setLocalDescription (answer)');
      socketRef.current?.emit('call-answer', { callerId: incomingCall.from.id, answer });
      setIncomingCall(null);
    } catch {
      setError('Camera or microphone access is required to answer this call.');
      closeCall(true);
    }
  };

  const selectChat = async (type, data) => {
    clearTimeout(typingTimeoutRef.current);
    emitTyping(false);
    setSelected({ type, data });
    setMessages([]);
    setError('');
    setActivePopover(null);
    if (infoPanel === 'self') setInfoPanel(null);
    try {
      const url = type === 'group' ? `/api/groups/${data.id}/messages` : `/api/messages/${data.id}`;
      const result = await api.get(url, authorization);
      setMessages((previous) => mergeMessages(result.data, previous));
      if (type === 'group') socketRef.current?.emit('join-group', { groupId: data.id });
    } catch (requestError) {
      setError(requestError.response?.data?.message || 'Could not load this conversation.');
    }
  };

  const emitTyping = (isTyping) => {
    if (!selected) return;
    const payload = selected.type === 'group'
      ? { groupId: selected.data.id, isTyping }
      : { recipientId: selected.data.id, isTyping };
    socketRef.current?.emit('typing', payload);
  };

  const handleMessageChange = (event) => {
    setMessage(event.target.value);
    if (!selected) return;
    emitTyping(true);
    clearTimeout(typingTimeoutRef.current);
    typingTimeoutRef.current = setTimeout(() => emitTyping(false), 2000);
  };

  const sendMessage = (event) => {
    event.preventDefault();
    if (!selected || !message.trim()) return;
    clearTimeout(typingTimeoutRef.current);
    emitTyping(false);
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

  const toggleGroupMember = (id) => {
    setGroupMembers((previous) => previous.includes(id) ? previous.filter((item) => item !== id) : [...previous, id]);
  };

  const createGroup = async (event) => {
    event.preventDefault();
    try {
      const result = await api.post('/api/groups', { name: groupName, memberIds: groupMembers }, authorization);
      setGroups((previous) => [result.data, ...previous]);
      setGroupName('');
      setGroupMembers([]);
      setActivePopover(null);
      socketRef.current?.emit('join-group', { groupId: result.data.id });
      selectChat('group', result.data);
    } catch (requestError) { setError(requestError.response?.data?.message || 'Could not create group.'); }
  };

  const availableContacts = contacts.filter((contact) => !conversations.some((chat) => chat.id === contact.id));
  const query = searchQuery.trim().toLowerCase();
  const filteredConversations = conversations.filter((c) => c.username.toLowerCase().includes(query));
  const filteredGroups = groups.filter((g) => g.name.toLowerCase().includes(query));

  const groupedMessages = useMemo(() => {
    const result = [];
    let lastLabel = null;
    messages.forEach((item) => {
      const label = formatDateLabel(item.timeStamp);
      if (label !== lastLabel) { result.push({ label, items: [] }); lastLabel = label; }
      result[result.length - 1].items.push(item);
    });
    return result;
  }, [messages]);

  const scrollToBottom = () => {
    if (chatScrollRef.current) chatScrollRef.current.scrollTo({ top: chatScrollRef.current.scrollHeight, behavior: 'smooth' });
  };

  const isDirectOnline = selected?.type === 'direct' && onlineUserIds.has(selected.data.id);
  const isDirectTyping = selected?.type === 'direct' && Boolean(typingMap[selected.data.id]);
  const directLastSeen = selected?.type === 'direct' ? lastSeenMap[selected.data.id] : null;
  const groupTypingUsers = selected?.type === 'group' ? Array.from(typingMap[selected.data.id] || []) : [];
  const isGroupTyping = groupTypingUsers.length > 0;

  let statusText = '';
  if (selected?.type === 'direct') {
    if (isDirectTyping) statusText = 'typing…';
    else if (isDirectOnline) statusText = 'online';
    else if (directLastSeen) statusText = `last seen ${new Date(directLastSeen).toLocaleString([], { day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' })}`;
  } else if (isGroupTyping) {
    statusText = `${groupTypingUsers.join(', ')} ${groupTypingUsers.length > 1 ? 'are' : 'is'} typing…`;
  }

  return (
    <div className={`ww-shell ${selected ? 'has-chat-open' : ''}`}>
      {/* -------- Icon rail -------- */}
      <aside className="ww-rail">
        <button type="button" className="ww-rail-avatar" title="Your profile" onClick={() => setInfoPanel(infoPanel === 'self' ? null : 'self')}>
          {initialOf(user.name)}
        </button>
        <div className="ww-rail-icons">
          <button type="button" title="New chat" className={activePopover === 'newChat' ? 'active' : ''} onClick={() => setActivePopover(activePopover === 'newChat' ? null : 'newChat')}>
            <MessageSquarePlus size={22} />
          </button>
          <button type="button" title="New group" className={activePopover === 'newGroup' ? 'active' : ''} onClick={() => setActivePopover(activePopover === 'newGroup' ? null : 'newGroup')}>
            <UsersRound size={22} />
          </button>
        </div>
        <div className="ww-rail-bottom">
          <button type="button" title="Log out" onClick={logout}>
            <LogOut size={22} />
          </button>
        </div>
      </aside>

      {/* -------- Chat list -------- */}
      <section className="ww-list-panel">
        <header className="ww-list-header">
          <div className="ww-list-header-top">
            <h2>ChatApp</h2>
            <div className="ww-list-header-icons">
              <button type="button" title="Search"><Search size={20} /></button>
              <button type="button" title="Menu" onClick={() => setActivePopover(activePopover === 'menu' ? null : 'menu')}>
                <MoreVertical size={20} />
              </button>
            </div>
          </div>
          <div className="ww-mobile-tabs">
            <button type="button" className={activeTab === 'chats' ? 'active' : ''} onClick={() => setActiveTab('chats')}>CHATS</button>
            <button type="button" className={activeTab === 'status' ? 'active' : ''} onClick={() => setActiveTab('status')}>STATUS</button>
            <button type="button" className={activeTab === 'calls' ? 'active' : ''} onClick={() => setActiveTab('calls')}>CALLS</button>
          </div>
        </header>

        {activePopover === 'menu' && (
          <div className="ww-menu-dropdown">
            <button type="button" onClick={() => setActivePopover('newGroup')}>New group</button>
            <button type="button" onClick={() => { setInfoPanel('self'); setActivePopover(null); }}>Profile</button>
            <button type="button" onClick={logout}>Log out</button>
          </div>
        )}

        <div className="ww-search-bar">
          <Search size={16} />
          <input
            value={searchQuery}
            onChange={(event) => setSearchQuery(event.target.value)}
            placeholder="Search or start a new chat"
          />
        </div>

        {activePopover === 'newChat' && (
          <div className="ww-popover">
            <div className="ww-popover-header">
              <h3>New chat</h3>
              <button type="button" onClick={() => setActivePopover(null)}><X size={18} /></button>
            </div>
            <form className="ww-popover-form" onSubmit={addFriend}>
              <input
                value={friendUsername}
                onChange={(event) => setFriendUsername(event.target.value)}
                placeholder="Add friend by username, e.g. @alex1234"
              />
              <button type="submit">Add</button>
            </form>
            <div className="ww-popover-list">
              {availableContacts.map((contact) => (
                <button type="button" key={contact.id} onClick={() => selectChat('direct', contact)}>
                  <span className="ww-mini-avatar">{initialOf(contact.username)}</span>
                  @{contact.username}
                </button>
              ))}
              {!availableContacts.length && <p className="ww-popover-empty">All your friends already have an open chat.</p>}
            </div>
          </div>
        )}

        {activePopover === 'newGroup' && (
          <div className="ww-popover">
            <div className="ww-popover-header">
              <h3>New group</h3>
              <button type="button" onClick={() => setActivePopover(null)}><X size={18} /></button>
            </div>
            <form className="ww-popover-form" onSubmit={createGroup}>
              <input value={groupName} onChange={(event) => setGroupName(event.target.value)} placeholder="Group name" />
              <div className="ww-checkbox-list">
                {contacts.map((contact) => (
                  <label key={contact.id}>
                    <input
                      type="checkbox"
                      checked={groupMembers.includes(contact.id)}
                      onChange={() => toggleGroupMember(contact.id)}
                    />
                    @{contact.username}
                  </label>
                ))}
                {!contacts.length && <p className="ww-popover-empty">Add friends first to create a group.</p>}
              </div>
              <button type="submit" disabled={!groupName.trim() || !groupMembers.length}>Create group</button>
            </form>
          </div>
        )}

        {activeTab !== 'chats' ? (
          <div className="ww-tab-placeholder">
            {activeTab === 'status' ? 'Status updates will appear here.' : 'Your call history will appear here.'}
          </div>
        ) : (
        <div className="ww-conversation-list">
          <p className="ww-section-label">Chats</p>
          {filteredConversations.map((chat) => (
            <button
              type="button"
              key={chat.id}
              className={`ww-conversation ${selected?.type === 'direct' && selected.data.id === chat.id ? 'active' : ''}`}
              onClick={() => selectChat('direct', chat)}
            >
              <span className={`ww-avatar ${onlineUserIds.has(chat.id) ? 'online' : ''}`}>{initialOf(chat.username)}</span>
              <span className="ww-conversation-body">
                <span className="ww-conversation-top">
                  <strong>@{chat.username}</strong>
                  {chat.timeStamp && <span className="ww-conversation-time">{new Date(chat.timeStamp).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}</span>}
                </span>
                <span className="ww-conversation-preview">{chat.lastMessage}</span>
              </span>
            </button>
          ))}
          {!filteredConversations.length && <p className="ww-empty-chats">No private chats yet.</p>}

          <p className="ww-section-label">Groups</p>
          {filteredGroups.map((group) => (
            <button
              type="button"
              key={group.id}
              className={`ww-conversation ${selected?.type === 'group' && selected.data.id === group.id ? 'active' : ''}`}
              onClick={() => selectChat('group', group)}
            >
              <span className="ww-avatar group">{initialOf(group.name)}</span>
              <span className="ww-conversation-body">
                <span className="ww-conversation-top">
                  <strong>{group.name}</strong>
                  {group.timeStamp && <span className="ww-conversation-time">{new Date(group.timeStamp).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}</span>}
                </span>
                <span className="ww-conversation-preview">{group.lastMessage || `${group.members.length} members`}</span>
              </span>
            </button>
          ))}
          {!filteredGroups.length && <p className="ww-empty-chats">No groups yet.</p>}
        </div>
        )}

        {activeTab === 'chats' && (
          <button type="button" className="ww-fab" title="New chat" onClick={() => setActivePopover('newChat')}>
            <MessageSquarePlus size={22} />
          </button>
        )}
      </section>

      {/* -------- Conversation -------- */}
      <main className="ww-conversation-panel">
        {selected ? (
          <>
            <header className="ww-conversation-header">
              <div className="ww-conversation-identity-wrap">
                <button type="button" className="ww-back-btn" title="Back" onClick={() => setSelected(null)}>
                  <ArrowLeft size={22} />
                </button>
                <button type="button" className="ww-conversation-identity" onClick={() => setInfoPanel('contact')}>
                  <span className={`ww-avatar ${isDirectOnline ? 'online' : ''}`}>{initialOf(selected.type === 'group' ? selected.data.name : selected.data.username)}</span>
                  <span className="ww-identity-text">
                    <h1>{selected.type === 'group' ? selected.data.name : `@${selected.data.username}`}</h1>
                    {statusText && <span className={`ww-status-line ${isDirectTyping || isGroupTyping ? 'typing' : ''}`}>{statusText}</span>}
                  </span>
                </button>
              </div>
              <div className="ww-header-icons">
                {selected.type === 'direct' && (
                  <button type="button" title="Video call" onClick={startCall}><Video size={20} /></button>
                )}
                <button type="button" title="Search in chat"><Search size={20} /></button>
                <button type="button" title="More options"><MoreVertical size={20} /></button>
              </div>
            </header>

            <div className="ww-chat" ref={chatScrollRef}>
              {groupedMessages.map((group) => (
                <React.Fragment key={group.label}>
                  <div className="ww-date-chip"><span>{group.label}</span></div>
                  {group.items.map((item) => (
                    <div key={item.id} className={`ww-message ${item.senderId === user.id ? 'me' : ''}`}>
                      {selected.type === 'group' && item.senderId !== user.id && <div className="ww-sender">@{item.username}</div>}
                      <div className="ww-bubble-text">{item.msg}</div>
                      <div className="ww-meta">
                        <span className="ww-time">{new Date(item.timeStamp).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}</span>
                        {item.senderId === user.id && <CheckCheck size={14} className="ww-check" />}
                      </div>
                    </div>
                  ))}
                </React.Fragment>
              ))}
              {!messages.length && <p className="ww-empty-chats">Say hello 👋 — no messages here yet.</p>}
              {(isDirectTyping || isGroupTyping) && (
                <div className="ww-typing-bubble">
                  <span className="ww-dot" /><span className="ww-dot" /><span className="ww-dot" />
                </div>
              )}
            </div>

            <button type="button" className="ww-scroll-fab" onClick={scrollToBottom} title="Scroll to latest">
              <ChevronDown size={18} />
            </button>

            <form className="ww-inputbar" onSubmit={sendMessage}>
              <button type="button" className="ww-emoji" title="Emoji"><Smile size={20} /></button>
              <button
                type="button"
                className="ww-attach"
                title="Attach"
                onClick={() => setActivePopover(activePopover === 'attach' ? null : 'attach')}
              >
                <Paperclip size={20} />
              </button>
              <input value={message} onChange={handleMessageChange} placeholder="Type a message here .." />
              <button type="button" className="ww-camera-btn" title="Camera"><Camera size={20} /></button>
              {message.trim() ? (
                <button type="submit" className="ww-send" title="Send"><Send size={18} /></button>
              ) : (
                <button type="button" className="ww-send ww-mic" title="Voice message"><Mic size={18} /></button>
              )}
            </form>

            {activePopover === 'attach' && (
              <div className="ww-attach-sheet-overlay" onClick={() => setActivePopover(null)}>
                <div className="ww-attach-sheet" onClick={(event) => event.stopPropagation()}>
                  <div className="ww-attach-grid">
                    <button type="button" onClick={() => setActivePopover(null)}>
                      <span className="ww-attach-icon doc"><FileText size={22} /></span>Document
                    </button>
                    <button type="button" onClick={() => setActivePopover(null)}>
                      <span className="ww-attach-icon cam"><Camera size={22} /></span>Camera
                    </button>
                    <button type="button" onClick={() => setActivePopover(null)}>
                      <span className="ww-attach-icon gal"><ImageIcon size={22} /></span>Gallery
                    </button>
                    <button type="button" onClick={() => setActivePopover(null)}>
                      <span className="ww-attach-icon aud"><Headphones size={22} /></span>Audio
                    </button>
                    <button type="button" onClick={() => setActivePopover(null)}>
                      <span className="ww-attach-icon loc"><MapPin size={22} /></span>Location
                    </button>
                    <button type="button" onClick={() => setActivePopover(null)}>
                      <span className="ww-attach-icon con"><UserIcon size={22} /></span>Contact
                    </button>
                  </div>
                </div>
              </div>
            )}
          </>
        ) : (
          <div className="ww-empty-conversation">
            <p>Select a chat, create a group, or start a new conversation.</p>
          </div>
        )}
        {error && <p className="ww-auth-error">{error}</p>}
      </main>

      {/* -------- Contact / profile info -------- */}
      {infoPanel && (infoPanel === 'self' || selected) && (
        <aside className="ww-info-panel">
          <header className="ww-info-header">
            <button type="button" onClick={() => setInfoPanel(null)}><X size={20} /></button>
            <h2>{infoPanel === 'self' ? 'Profile' : selected.type === 'group' ? 'Group Info' : 'Contact Info'}</h2>
          </header>
          <div className="ww-info-body">
            <div className="ww-info-avatar">
              {initialOf(infoPanel === 'self' ? user.name : selected.type === 'group' ? selected.data.name : selected.data.username)}
            </div>
            <h3>{infoPanel === 'self' ? user.name : selected.type === 'group' ? selected.data.name : `@${selected.data.username}`}</h3>
            <p className="ww-info-sub">
              {infoPanel === 'self' ? `@${user.username}` : selected.type === 'group' ? `${selected.data.members.length} members` : 'Friend'}
            </p>

            {infoPanel !== 'self' && selected.type === 'group' ? (
              <div className="ww-info-section">
                <h4>Members</h4>
                <ul className="ww-member-list">
                  {selected.data.members.map((member) => (
                    <li key={member.userId}>
                      <span className="ww-mini-avatar">{initialOf(member.username)}</span>
                      @{member.username}
                    </li>
                  ))}
                </ul>
              </div>
            ) : (
              <div className="ww-info-section">
                <h4>Media, Links and Documents</h4>
                <div className="ww-media-grid">
                  <div className="ww-media-placeholder" />
                  <div className="ww-media-placeholder" />
                  <div className="ww-media-placeholder" />
                </div>
              </div>
            )}
          </div>
        </aside>
      )}

      {/* -------- Call modals -------- */}
      {incomingCall && (
        <div className="ww-call-modal">
          <span className="ww-info-avatar small">{initialOf(incomingCall.contact.username)}</span>
          <p>@{incomingCall.contact.username} is calling…</p>
          <div className="ww-call-actions">
            <button type="button" className="accept" onClick={acceptCall}><Video size={16} /> Accept</button>
            <button type="button" className="decline" onClick={() => closeCall(true)}><PhoneOff size={16} /> Decline</button>
          </div>
        </div>
      )}
      {activeCall && (
        <div className="ww-call-modal video">
          <p>Video call with @{activeCall.username}</p>
          <div className="ww-video-grid">
            <video ref={localVideoRef} autoPlay muted playsInline />
            <video ref={remoteVideoRef} autoPlay playsInline />
          </div>
          <button type="button" className="decline" onClick={() => closeCall(true)}><PhoneOff size={16} /> End call</button>
        </div>
      )}
    </div>
  );
};

export default ChatApp;