import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { io } from 'socket.io-client'
import { useNavigate } from 'react-router-dom'
import { API_URL, api } from '../config/api'
import {
  Video, Search, MoreVertical, Paperclip, Send, X, MessageSquarePlus,
  UsersRound, LogOut, Check, CheckCheck, ChevronDown, PhoneOff, ArrowLeft,
  Smile, Camera, Mic, FileText, Image as ImageIcon, Headphones, MapPin,
  User as UserIcon, Phone, PhoneIncoming, PhoneOutgoing, PhoneMissed,
  Trash2, Users, Link2, Share2, Info, StopCircle, Forward, Ban, ShieldCheck,
  MessageCircle, Clock, Palette, Download, Flag, Star, Bell, BellOff, Lock,
  UserPlus, Pencil, Eye,
} from 'lucide-react'
import './ChatApp.css'

// Public STUN + free demo TURN relay (openrelay.metered.ca) so calls still connect across
// NATs/firewalls that STUN alone can't traverse. This is a shared, rate-limited demo relay —
// fine for development and small deployments, but for production reliability swap in a
// dedicated TURN service (Twilio Network Traversal, Xirsys) or self-hosted coturn.
const RTC_CONFIGURATION = {
  iceServers: [
    { urls: 'stun:stun.l.google.com:19302' },
    {
      urls: [
        'turn:openrelay.metered.ca:80',
        'turn:openrelay.metered.ca:443',
        'turn:openrelay.metered.ca:443?transport=tcp',
      ],
      username: 'openrelayproject',
      credential: 'openrelayproject',
    },
  ],
};

const MAX_GROUP_CALL_PARTICIPANTS = 4;

const THEME_COLORS = ['#e0e7ff', '#fde68a', '#bbf7d0', '#fecaca', '#fbcfe8', '#bae6fd', '#ddd6fe', '#fed7aa'];
const CHAT_SETTINGS_KEY = 'ww-chat-settings';

const EMOJIS = [
  '😀', '😂', '😍', '😊', '👍', '🙏', '🎉', '❤️', '😢', '😮',
  '🔥', '👏', '😅', '🤔', '😎', '🥳', '😴', '🙌', '💯', '✨',
  '😇', '🤗', '😜', '😭', '🙃', '😬', '🤝', '👀', '🚀', '🎂',
];

const MAX_ATTACHMENT_BYTES = 5 * 1024 * 1024; // matches the server-side cap

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

const formatDuration = (seconds = 0) => {
  const m = Math.floor(seconds / 60);
  const s = seconds % 60;
  return `${m}:${String(s).padStart(2, '0')}`;
};

// Same preview text logic as the server's previewFor(), for live socket updates.
const previewFor = (item) => {
  switch (item.type) {
    case 'audio': return '🎤 Voice message';
    case 'image': return '📷 Photo';
    case 'file': return `📄 ${item.fileName || 'Document'}`;
    case 'location': return '📍 Location';
    case 'contact': return '👤 Contact';
    case 'call': return item.callInfo?.status === 'missed' ? '📞 Missed call' : '📞 Call';
    default: return item.msg;
  }
};

const readFileAsDataURL = (file) => new Promise((resolve, reject) => {
  const reader = new FileReader();
  reader.onload = () => resolve(reader.result);
  reader.onerror = reject;
  reader.readAsDataURL(file);
});

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
  const [notice, setNotice] = useState('');
  const [incomingCall, setIncomingCall] = useState(null);
  const [activeCall, setActiveCall] = useState(null);
  const [localStream, setLocalStream] = useState(null);
  const [remoteStream, setRemoteStream] = useState(null);

  // ---- UI-only state ----
  const [searchQuery, setSearchQuery] = useState('');
  const [activePopover, setActivePopover] = useState(null); // 'newChat' | 'newGroup' | 'chatMenu' | 'menu' | 'attach' | 'shareContact' | null
  const [infoPanel, setInfoPanel] = useState(null); // 'self' | 'contact' | null
  const [activeTab, setActiveTab] = useState('chats'); // 'chats' | 'status' | 'calls' (mobile view)
  const [showCallsPanel, setShowCallsPanel] = useState(false); // desktop calls panel
  const [onlineUserIds, setOnlineUserIds] = useState(() => new Set());
  const [lastSeenMap, setLastSeenMap] = useState({}); // contactId -> ISO string
  const [typingMap, setTypingMap] = useState({}); // direct: contactId -> boolean | group: groupId -> Set(usernames)
  const [callHistory, setCallHistory] = useState([]);
  const [confirmLogout, setConfirmLogout] = useState(false);
  const [showEmojiPicker, setShowEmojiPicker] = useState(false);
  const [forwardingMessage, setForwardingMessage] = useState(null);

  // ---- Group video calling (mesh, capped at MAX_GROUP_CALL_PARTICIPANTS) ----
  const [groupCallInvite, setGroupCallInvite] = useState(null); // { callId, from, participantIds, groupId, callType }
  const [groupCall, setGroupCall] = useState(null); // { callId, groupId }
  const [groupCallParticipants, setGroupCallParticipants] = useState([]); // [{ userId, username, stream }] (excludes self)
  const [localGroupStream, setLocalGroupStream] = useState(null);
  const [callPickerContacts, setCallPickerContacts] = useState([]);
  const [callPickerGroupId, setCallPickerGroupId] = useState(null);
  const [callPickerSelection, setCallPickerSelection] = useState([]);

  // ---- Direct vs Groups list toggle ----
  const [chatListView, setChatListView] = useState('direct'); // 'direct' | 'groups'

  // ---- Per-chat settings (theme, disappearing, mute, media visibility, lock, favourite) ----
  // Persisted client-side only — see the note in my reply about what's enforced vs. cosmetic.
  const [chatSettings, setChatSettings] = useState(() => {
    try { return JSON.parse(localStorage.getItem(CHAT_SETTINGS_KEY) || '{}'); } catch { return {}; }
  });
  useEffect(() => {
    try { localStorage.setItem(CHAT_SETTINGS_KEY, JSON.stringify(chatSettings)); } catch { /* storage unavailable */ }
  }, [chatSettings]);

  // ---- Group edit-in-place (name / description) ----
  const [editingGroupField, setEditingGroupField] = useState(null); // 'name' | 'description' | null
  const [groupNameDraft, setGroupNameDraft] = useState('');
  const [groupDescriptionDraft, setGroupDescriptionDraft] = useState('');

  // ---- Add members to an existing group ----
  const [addMembersSelection, setAddMembersSelection] = useState([]);

  // in-chat search
  const [chatSearchOpen, setChatSearchOpen] = useState(false);
  const [chatSearchQuery, setChatSearchQuery] = useState('');

  // voice recording
  const [isRecording, setIsRecording] = useState(false);
  const [recordSeconds, setRecordSeconds] = useState(0);

  // per-message delete/forward menu
  const [messageMenuId, setMessageMenuId] = useState(null);

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
  const mediaRecorderRef = useRef(null);
  const audioChunksRef = useRef([]);
  const recordTimerRef = useRef(null);
  const searchInputRef = useRef(null);
  const galleryInputRef = useRef(null);
  const documentInputRef = useRef(null);
  const audioFileInputRef = useRef(null);
  const cameraInputRef = useRef(null);
  const groupPeersRef = useRef({}); // remoteUserId -> RTCPeerConnection
  const groupCallIdRef = useRef(null);
  const localGroupVideoRef = useRef(null);
  const localGroupStreamRef = useRef(null);
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
  useEffect(() => { if (localGroupVideoRef.current) localGroupVideoRef.current.srcObject = localGroupStream; }, [localGroupStream]);
  useEffect(() => { localGroupStreamRef.current = localGroupStream; }, [localGroupStream]);
  useEffect(() => { if (remoteVideoRef.current) remoteVideoRef.current.srcObject = remoteStream; }, [remoteStream]);
  useEffect(() => {
    if (chatScrollRef.current) chatScrollRef.current.scrollTop = chatScrollRef.current.scrollHeight;
  }, [messages, selected]);
  useEffect(() => {
    if (!notice) return;
    const t = setTimeout(() => setNotice(''), 2500);
    return () => clearTimeout(t);
  }, [notice]);

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

  // Callee explicitly declines an unanswered incoming call (distinct from hanging up an active call)
  const declineCall = useCallback(() => {
    if (incomingCall) socketRef.current?.emit('call-decline', { callerId: incomingCall.from.id });
    setIncomingCall(null);
  }, [incomingCall]);

  const loadCallHistory = useCallback(async () => {
    try {
      const result = await api.get('/api/calls', authorization);
      setCallHistory(result.data);
    } catch (requestError) {
      console.error('Could not load call history', requestError);
    }
  }, [authorization]);

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
      loadCallHistory();
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
      if (contact) setConversations((previous) => [{ ...contact, lastMessage: previewFor(item), timeStamp: item.timeStamp }, ...previous.filter((entry) => entry.id !== contactId)]);
      if (selectedRef.current?.type === 'direct' && selectedRef.current.data.id === contactId) {
        setMessages((previous) => mergeMessages(previous, [item]));
        // We already have this chat open, so tell the server we've seen it immediately.
        if (item.senderId !== user.id) socketRef.current?.emit('mark-read', { contactId });
      }
      setTypingMap((previous) => ({ ...previous, [contactId]: false }));
    });
    socket.on('group-msg', (item) => {
      const group = groupsRef.current.find((entry) => entry.id === item.groupId);
      if (group) setGroups((previous) => [{ ...group, lastMessage: previewFor(item), timeStamp: item.timeStamp }, ...previous.filter((entry) => entry.id !== item.groupId)]);
      if (selectedRef.current?.type === 'group' && selectedRef.current.data.id === item.groupId) setMessages((previous) => mergeMessages(previous, [item]));
      setTypingMap((previous) => {
        const current = new Set(previous[item.groupId] || []);
        current.delete(item.username);
        return { ...previous, [item.groupId]: current };
      });
    });
    socket.on('msg-deleted', ({ messageId, everyone }) => {
      setMessages((previous) => {
        if (everyone) return previous.map((m) => (m.id === messageId ? { ...m, deletedForEveryone: true, msg: '', audioData: undefined, fileData: undefined } : m));
        return previous.filter((m) => m.id !== messageId);
      });
    });
    socket.on('messages-read', ({ by }) => {
      setMessages((previous) => previous.map((m) => (
        m.senderId === user.id && m.recipientId === by ? { ...m, read: true } : m
      )));
    });
    socket.on('call-history-updated', () => loadCallHistory());
    socket.on('group-updated', (updatedGroup) => {
      setGroups((previous) => {
        const exists = previous.some((g) => g.id === updatedGroup.id);
        if (!exists) return [{ ...updatedGroup, lastMessage: '', timeStamp: updatedGroup.createdAt }, ...previous];
        return previous.map((g) => (g.id === updatedGroup.id ? { ...g, ...updatedGroup } : g));
      });
      setSelected((previous) => (previous?.type === 'group' && previous.data.id === updatedGroup.id ? { ...previous, data: { ...previous.data, ...updatedGroup } } : previous));
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
      const contact = contactsRef.current.find((entry) => entry.id === call.from.id) || call.from;
      setIncomingCall({ ...call, contact });
    });

    socket.on('call-answered', async ({ answer }) => {
      try {
        if (!peerConnectionRef.current) return;
        await peerConnectionRef.current.setRemoteDescription(new RTCSessionDescription(answer));
        await addQueuedCandidates();
      } catch (err) {
        console.error('[webrtc] error handling call-answered', err);
      }
    });

    socket.on('ice-candidate', async ({ candidate }) => {
      try {
        if (peerConnectionRef.current?.remoteDescription) {
          await peerConnectionRef.current.addIceCandidate(new RTCIceCandidate(candidate));
        } else {
          queuedCandidatesRef.current.push(candidate);
        }
      } catch (err) {
        console.error('[webrtc] error adding remote candidate', err);
      }
    });

    socket.on('call-ended', () => { closeCall(false); loadCallHistory(); });

    // ---- Group call (mesh) ----
    socket.on('group-call-invite', (payload) => setGroupCallInvite(payload));
    socket.on('group-call-declined', () => { /* host-side notice only; no UI change needed for MVP */ });
    socket.on('group-call-error', ({ message: errMessage }) => setError(errMessage || 'Could not join the group call.'));

    // Sent to a joiner right after they join: the list of participants already in the room.
    socket.on('group-call-state', ({ callId, participants }) => {
      if (callId !== groupCallIdRef.current) return;
      setGroupCallParticipants(participants.map((p) => ({ ...p, stream: null })));
      const stream = localGroupStreamRef.current;
      if (stream) participants.forEach((p) => connectToGroupParticipant(p.userId, stream));
    });

    // Sent to existing participants whenever someone new joins the room.
    socket.on('group-call-participant-joined', ({ callId, userId: joinedId, username: joinedUsername }) => {
      if (callId !== groupCallIdRef.current || joinedId === user.id) return;
      setGroupCallParticipants((previous) => (
        previous.some((p) => p.userId === joinedId) ? previous : [...previous, { userId: joinedId, username: joinedUsername, stream: null }]
      ));
      const stream = localGroupStreamRef.current;
      if (stream) connectToGroupParticipant(joinedId, stream);
    });

    socket.on('group-call-participant-left', ({ callId, userId: leftId }) => {
      if (callId !== groupCallIdRef.current) return;
      groupPeersRef.current[leftId]?.close();
      delete groupPeersRef.current[leftId];
      setGroupCallParticipants((previous) => previous.filter((p) => p.userId !== leftId));
    });

    // Generic SDP offer/answer/candidate relay for the mesh.
    socket.on('group-call-signal', async ({ callId, fromUserId, data }) => {
      if (callId !== groupCallIdRef.current) return;
      const peer = ensureGroupPeerConnection(fromUserId);
      try {
        if (data.type === 'offer') {
          await peer.setRemoteDescription(new RTCSessionDescription(data.sdp));
          const stream = localGroupStreamRef.current;
          stream?.getTracks().forEach((track) => {
            if (!peer.getSenders().some((sender) => sender.track === track)) peer.addTrack(track, stream);
          });
          const answer = await peer.createAnswer();
          await peer.setLocalDescription(answer);
          socketRef.current?.emit('group-call-signal', { callId, targetUserId: fromUserId, data: { type: 'answer', sdp: answer } });
        } else if (data.type === 'answer') {
          await peer.setRemoteDescription(new RTCSessionDescription(data.sdp));
        } else if (data.type === 'candidate') {
          await peer.addIceCandidate(new RTCIceCandidate(data.candidate));
        }
      } catch (err) {
        console.error('[group-call] signaling error', err);
      }
    });

    return () => { closeCall(false); teardownGroupCall(); socket.disconnect(); };
  }, [authorization, closeCall, loadCallHistory, logout, token, user.id]);

  const createPeerConnection = (targetUserId, stream) => {
    if (peerConnectionRef.current) {
      try { peerConnectionRef.current.close(); } catch (e) { /* ignore */ }
      peerConnectionRef.current = null;
      queuedCandidatesRef.current = [];
    }

    const peer = new RTCPeerConnection(RTC_CONFIGURATION);
    callTargetRef.current = targetUserId;
    stream.getTracks().forEach((track) => peer.addTrack(track, stream));

    peer.onicecandidate = ({ candidate }) => {
      if (candidate) socketRef.current?.emit('ice-candidate', { targetUserId, candidate });
    };

    peer.ontrack = (event) => {
      const remote = event.streams && event.streams[0];
      if (remote) setRemoteStream(remote);
    };

    peerConnectionRef.current = peer;
    return peer;
  };

  const addQueuedCandidates = async () => {
    const peer = peerConnectionRef.current;
    if (!peer) return;
    for (const candidate of queuedCandidatesRef.current) {
      try { await peer.addIceCandidate(new RTCIceCandidate(candidate)); } catch (err) { console.error('[webrtc] error adding queued candidate', err); }
    }
    queuedCandidatesRef.current = [];
  };

  // ---- Group call (mesh): one RTCPeerConnection per remote participant ----
  const ensureGroupPeerConnection = (remoteUserId) => {
    if (groupPeersRef.current[remoteUserId]) return groupPeersRef.current[remoteUserId];

    const peer = new RTCPeerConnection(RTC_CONFIGURATION);

    peer.onicecandidate = ({ candidate }) => {
      if (candidate) {
        socketRef.current?.emit('group-call-signal', {
          callId: groupCallIdRef.current,
          targetUserId: remoteUserId,
          data: { type: 'candidate', candidate },
        });
      }
    };
    peer.ontrack = (event) => {
      const remoteStream = event.streams && event.streams[0];
      setGroupCallParticipants((previous) => previous.map((p) => (p.userId === remoteUserId ? { ...p, stream: remoteStream } : p)));
    };

    groupPeersRef.current[remoteUserId] = peer;
    return peer;
  };

  // Deterministic glare-avoidance: whoever has the lexicographically smaller userId always
  // sends the offer, so two peers never both try to initiate the same connection at once.
  const connectToGroupParticipant = async (remoteUserId, stream) => {
    const peer = ensureGroupPeerConnection(remoteUserId);
    stream.getTracks().forEach((track) => {
      if (!peer.getSenders().some((sender) => sender.track === track)) peer.addTrack(track, stream);
    });
    if (user.id < remoteUserId) {
      try {
        const offer = await peer.createOffer();
        await peer.setLocalDescription(offer);
        socketRef.current?.emit('group-call-signal', {
          callId: groupCallIdRef.current,
          targetUserId: remoteUserId,
          data: { type: 'offer', sdp: offer },
        });
      } catch (err) {
        console.error('[group-call] error creating offer', err);
      }
    }
  };

  const teardownGroupCall = () => {
    Object.values(groupPeersRef.current).forEach((peer) => { try { peer.close(); } catch (e) { /* ignore */ } });
    groupPeersRef.current = {};
    localGroupStream?.getTracks().forEach((track) => track.stop());
    setLocalGroupStream(null);
    groupCallIdRef.current = null;
    setGroupCall(null);
    setGroupCallParticipants([]);
  };

  const startGroupCall = async (targetUserIds, groupId = null) => {
    if (!targetUserIds.length || targetUserIds.length > MAX_GROUP_CALL_PARTICIPANTS - 1) return;
    try {
      const stream = await navigator.mediaDevices.getUserMedia({ video: true, audio: true });
      const callId = `${user.id}-${Date.now()}`;
      setLocalGroupStream(stream);
      groupCallIdRef.current = callId;
      setGroupCall({ callId, groupId });
      setGroupCallParticipants([]);
      socketRef.current?.emit('group-call-invite', { callId, targetUserIds, groupId, callType: 'video' });
    } catch {
      setError('Camera or microphone access is required to start a group call.');
    }
  };

  const acceptGroupCallInvite = async () => {
    if (!groupCallInvite) return;
    try {
      const stream = await navigator.mediaDevices.getUserMedia({ video: true, audio: true });
      const { callId, groupId } = groupCallInvite;
      setLocalGroupStream(stream);
      groupCallIdRef.current = callId;
      setGroupCall({ callId, groupId });
      setGroupCallParticipants([]);
      setGroupCallInvite(null);
      socketRef.current?.emit('group-call-join', { callId });
    } catch {
      setError('Camera or microphone access is required to join this call.');
      setGroupCallInvite(null);
    }
  };

  const declineGroupCallInvite = () => {
    if (groupCallInvite) socketRef.current?.emit('group-call-decline', { callId: groupCallInvite.callId });
    setGroupCallInvite(null);
  };

  const leaveGroupCall = () => {
    if (groupCallIdRef.current) socketRef.current?.emit('group-call-leave', { callId: groupCallIdRef.current });
    teardownGroupCall();
  };

  const openCallPicker = (candidateContacts, groupId = null) => {
    setCallPickerContacts(candidateContacts);
    setCallPickerGroupId(groupId);
    setCallPickerSelection(groupId && candidateContacts.length <= MAX_GROUP_CALL_PARTICIPANTS - 1 ? candidateContacts.map((c) => c.id) : []);
    setActivePopover('groupCallPicker');
  };

  const toggleCallPick = (id) => {
    setCallPickerSelection((previous) => {
      if (previous.includes(id)) return previous.filter((item) => item !== id);
      if (previous.length >= MAX_GROUP_CALL_PARTICIPANTS - 1) return previous;
      return [...previous, id];
    });
  };

  // Accepts an optional contact override so the call-history "call back" button can start a call
  // without first selecting that conversation.
  const startCall = async (contactOverride) => {
    const target = contactOverride || (selected?.type === 'direct' ? selected.data : null);
    if (!target || isBlocked) return;
    try {
      const stream = await navigator.mediaDevices.getUserMedia({ video: true, audio: true });
      setLocalStream(stream);
      setActiveCall(target);
      const peer = createPeerConnection(target.id, stream);
      const offer = await peer.createOffer();
      await peer.setLocalDescription(offer);
      socketRef.current?.emit('call-user', { targetUserId: target.id, offer, callType: 'video' });
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
    clearTimeout(typingTimeoutRef.current);
    emitTyping(false);
    setSelected({ type, data });
    setMessages([]);
    setError('');
    setActivePopover(null);
    setShowCallsPanel(false);
    setChatSearchOpen(false);
    setChatSearchQuery('');
    setShowEmojiPicker(false);
    if (infoPanel === 'self') setInfoPanel(null);
    try {
      const url = type === 'group' ? `/api/groups/${data.id}/messages` : `/api/messages/${data.id}`;
      const result = await api.get(url, authorization);
      setMessages((previous) => mergeMessages(result.data, previous));
      if (type === 'group') socketRef.current?.emit('join-group', { groupId: data.id });
      // Opening a direct chat means we've now "read" everything the other person sent us.
      if (type === 'direct') socketRef.current?.emit('mark-read', { contactId: data.id });
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
    if (!selected || !message.trim() || isBlocked) return;
    clearTimeout(typingTimeoutRef.current);
    emitTyping(false);
    if (selected.type === 'group') socketRef.current?.emit('group-msg', { groupId: selected.data.id, message });
    else socketRef.current?.emit('msg', { recipientId: selected.data.id, message });
    setMessage('');
  };

  // ---- Emoji picker ----
  const insertEmoji = (emoji) => {
    setMessage((previous) => previous + emoji);
    if (!selected) return;
    emitTyping(true);
    clearTimeout(typingTimeoutRef.current);
    typingTimeoutRef.current = setTimeout(() => emitTyping(false), 2000);
  };

  // ---- Voice messages ----
  const startRecording = async () => {
    if (!selected || isBlocked) return;
    try {
      const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
      const recorder = new MediaRecorder(stream);
      audioChunksRef.current = [];
      recorder.ondataavailable = (e) => { if (e.data.size > 0) audioChunksRef.current.push(e.data); };
      recorder.onstop = () => {
        stream.getTracks().forEach((track) => track.stop());
        const blob = new Blob(audioChunksRef.current, { type: 'audio/webm' });
        const reader = new FileReader();
        reader.onloadend = () => {
          const audioData = reader.result;
          if (selected.type === 'group') socketRef.current?.emit('group-msg', { groupId: selected.data.id, type: 'audio', audioData });
          else socketRef.current?.emit('msg', { recipientId: selected.data.id, type: 'audio', audioData });
        };
        reader.readAsDataURL(blob);
      };
      recorder.start();
      mediaRecorderRef.current = recorder;
      setIsRecording(true);
      setRecordSeconds(0);
      recordTimerRef.current = setInterval(() => setRecordSeconds((s) => s + 1), 1000);
    } catch {
      setError('Microphone access is required to record a voice message.');
    }
  };

  const stopRecording = () => {
    mediaRecorderRef.current?.stop();
    mediaRecorderRef.current = null;
    clearInterval(recordTimerRef.current);
    setIsRecording(false);
  };

  const handleMicClick = () => {
    if (isRecording) stopRecording();
    else startRecording();
  };

  // ---- Attach sheet: real file/location/contact sharing ----
  const sendAttachment = (payload) => {
    if (!selected) return;
    if (selected.type === 'group') socketRef.current?.emit('group-msg', { groupId: selected.data.id, ...payload });
    else socketRef.current?.emit('msg', { recipientId: selected.data.id, ...payload });
  };

  const sendFile = async (file, type) => {
    if (!file || !selected || isBlocked) return;
    if (file.size > MAX_ATTACHMENT_BYTES) {
      setError('That file is too large to send (max 5MB).');
      return;
    }
    try {
      const fileData = await readFileAsDataURL(file);
      sendAttachment({ type, fileData, fileName: file.name, fileMime: file.type });
    } catch {
      setError('Could not read that file.');
    }
  };

  const handleGallerySelect = (event) => {
    const file = event.target.files?.[0];
    event.target.value = '';
    setActivePopover(null);
    if (file) sendFile(file, 'image');
  };

  const handleDocumentSelect = (event) => {
    const file = event.target.files?.[0];
    event.target.value = '';
    setActivePopover(null);
    if (file) sendFile(file, 'file');
  };

  const handleAudioFileSelect = (event) => {
    const file = event.target.files?.[0];
    event.target.value = '';
    setActivePopover(null);
    if (file) sendFile(file, 'file');
  };

  const handleCameraCapture = (event) => {
    const file = event.target.files?.[0];
    event.target.value = '';
    setActivePopover(null);
    if (file) sendFile(file, 'image');
  };

  const shareLocation = () => {
    if (!selected || isBlocked) return;
    if (!navigator.geolocation) {
      setError('Location is not available in this browser.');
      return;
    }
    navigator.geolocation.getCurrentPosition(
      (position) => {
        sendAttachment({ type: 'location', location: { lat: position.coords.latitude, lng: position.coords.longitude } });
        setActivePopover(null);
      },
      () => { setError('Could not get your location.'); setActivePopover(null); },
    );
  };

  const shareContact = (contact) => {
    if (!selected || isBlocked) return;
    sendAttachment({ type: 'contact', contactShare: { id: contact.id, username: contact.username } });
    setActivePopover(null);
  };

  // ---- Delete message ----
  const deleteMessage = (item, everyone) => {
    socketRef.current?.emit('delete-message', { messageId: item.id, isGroup: selected?.type === 'group', everyone });
    setMessageMenuId(null);
    if (!everyone) setMessages((previous) => previous.filter((m) => m.id !== item.id));
  };

  // ---- Forward message ----
  const openForward = (item) => {
    setForwardingMessage(item);
    setMessageMenuId(null);
  };

  const forwardTo = (targetType, data) => {
    if (!forwardingMessage) return;
    const base = { message: forwardingMessage.msg, type: forwardingMessage.type };
    if (forwardingMessage.type === 'audio') base.audioData = forwardingMessage.audioData;
    if (forwardingMessage.type === 'image' || forwardingMessage.type === 'file') {
      base.fileData = forwardingMessage.fileData;
      base.fileName = forwardingMessage.fileName;
      base.fileMime = forwardingMessage.fileMime;
    }
    if (forwardingMessage.type === 'location') base.location = forwardingMessage.location;
    if (forwardingMessage.type === 'contact') base.contactShare = forwardingMessage.contactShare;

    if (targetType === 'group') socketRef.current?.emit('group-msg', { groupId: data.id, ...base });
    else socketRef.current?.emit('msg', { recipientId: data.id, ...base });
    setForwardingMessage(null);
    setNotice('Message forwarded');
  };

  // ---- Block / unblock ----
  const toggleBlock = async (contact) => {
    try {
      const endpoint = contact.blockedByMe ? 'unblock' : 'block';
      const result = await api.post(`/api/friends/${contact.id}/${endpoint}`, {}, authorization);
      setContacts((previous) => previous.map((c) => (c.id === contact.id ? { ...c, blockedByMe: result.data.blockedByMe } : c)));
      setNotice(result.data.blockedByMe ? `Blocked @${contact.username}` : `Unblocked @${contact.username}`);
    } catch (requestError) {
      setError(requestError.response?.data?.message || 'Could not update block status.');
    }
  };

  // ---- Per-chat settings helpers ----
  const chatKeyFor = (sel) => (sel ? `${sel.type}-${sel.data.id}` : null);
  const currentChatKey = chatKeyFor(selected);
  const currentSettings = (currentChatKey && chatSettings[currentChatKey]) || {};
  const isMuted = !!currentSettings.muted;
  const isMediaVisible = currentSettings.mediaVisibility ?? true;
  const isDisappearing = !!currentSettings.disappearing;
  const isChatLocked = !!currentSettings.locked;
  const isFavourite = !!currentSettings.favourite;

  const updateChatSetting = (chatKey, patch) => {
    if (!chatKey) return;
    setChatSettings((previous) => ({ ...previous, [chatKey]: { ...previous[chatKey], ...patch } }));
  };

  // ---- Group edit-in-place ----
  const applyGroupUpdate = (updatedGroup) => {
    setGroups((previous) => previous.map((g) => (g.id === updatedGroup.id ? { ...g, ...updatedGroup } : g)));
    setSelected((previous) => (previous?.type === 'group' && previous.data.id === updatedGroup.id ? { ...previous, data: { ...previous.data, ...updatedGroup } } : previous));
  };

  const saveGroupName = async (event) => {
    event.preventDefault();
    if (!selected || selected.type !== 'group' || !groupNameDraft.trim()) return;
    try {
      const result = await api.patch(`/api/groups/${selected.data.id}`, { name: groupNameDraft.trim() }, authorization);
      applyGroupUpdate(result.data);
      setEditingGroupField(null);
    } catch (requestError) {
      setError(requestError.response?.data?.message || 'Could not rename group.');
    }
  };

  const saveGroupDescription = async (event) => {
    event.preventDefault();
    if (!selected || selected.type !== 'group') return;
    try {
      const result = await api.patch(`/api/groups/${selected.data.id}`, { description: groupDescriptionDraft.trim() }, authorization);
      applyGroupUpdate(result.data);
      setEditingGroupField(null);
    } catch (requestError) {
      setError(requestError.response?.data?.message || 'Could not update description.');
    }
  };

  // ---- Add members to an existing group ----
  const toggleAddMember = (id) => {
    setAddMembersSelection((previous) => (previous.includes(id) ? previous.filter((item) => item !== id) : [...previous, id]));
  };

  const submitAddMembers = async () => {
    if (!selected || selected.type !== 'group' || !addMembersSelection.length) return;
    try {
      const result = await api.post(`/api/groups/${selected.data.id}/members`, { memberIds: addMembersSelection }, authorization);
      applyGroupUpdate(result.data);
      setAddMembersSelection([]);
      setActivePopover(null);
      setNotice('Members added');
    } catch (requestError) {
      setError(requestError.response?.data?.message || 'Could not add members.');
    }
  };

  const exitGroup = async () => {
    if (!selected || selected.type !== 'group') return;
    try {
      await api.post(`/api/groups/${selected.data.id}/leave`, {}, authorization);
      setGroups((previous) => previous.filter((g) => g.id !== selected.data.id));
      setSelected(null);
      setInfoPanel(null);
      setActivePopover(null);
      setNotice('You left the group');
    } catch (requestError) {
      setError(requestError.response?.data?.message || 'Could not leave the group.');
    }
  };

  // ---- Clear / export chat ----
  const clearChat = async () => {
    if (!selected) return;
    try {
      if (selected.type === 'group') await api.post(`/api/groups/${selected.data.id}/messages/clear`, {}, authorization);
      else await api.post('/api/messages/clear', { contactId: selected.data.id }, authorization);
      setMessages([]);
      setActivePopover(null);
      setNotice('Chat cleared');
    } catch (requestError) {
      setError(requestError.response?.data?.message || 'Could not clear this chat.');
    }
  };

  const exportChat = () => {
    if (!selected) return;
    const lines = messages.map((item) => {
      const who = item.senderId === user.id ? 'You' : (selected.type === 'group' ? `@${item.username}` : `@${selected.data.username}`);
      const when = new Date(item.timeStamp).toLocaleString();
      let content = item.msg;
      if (item.deletedForEveryone) content = '[deleted]';
      else if (item.type === 'audio') content = '[voice message]';
      else if (item.type === 'image') content = `[image${item.fileName ? `: ${item.fileName}` : ''}]`;
      else if (item.type === 'file') content = `[file: ${item.fileName || 'document'}]`;
      else if (item.type === 'location') content = '[location]';
      else if (item.type === 'contact') content = `[contact: @${item.contactShare?.username}]`;
      else if (item.type === 'call') content = '[call]';
      return `[${when}] ${who}: ${content}`;
    });
    const label = selected.type === 'group' ? selected.data.name : selected.data.username;
    const blob = new Blob([lines.join('\n')], { type: 'text/plain' });
    const url = URL.createObjectURL(blob);
    const link = document.createElement('a');
    link.href = url;
    link.download = `chat-${label}-${Date.now()}.txt`;
    link.click();
    URL.revokeObjectURL(url);
    setActivePopover(null);
  };

  // ---- Remaining menu actions ----
  // "Add shortcut" — browsers don't let a web app create arbitrary OS-level shortcuts per
  // chat, so this copies a link instead, which is the practical equivalent.
  const addShortcut = () => {
    if (navigator.clipboard) navigator.clipboard.writeText(window.location.href);
    setNotice('Link copied — pin or bookmark it for quick access');
    setActivePopover(null);
  };

  // "Add to list" has no backend concept yet (no custom-list feature exists) — decorative for now.
  const addToList = () => { setNotice('Added to list'); setActivePopover(null); };

  // "Report" isn't wired to a moderation backend yet — decorative for now.
  const reportChat = () => {
    setNotice(selected?.type === 'group' ? 'Group reported' : 'Contact reported');
    setActivePopover(null);
  };

  // "View member changes" has no history log yet — decorative for now.
  const viewMemberChanges = () => setNotice('Member change history coming soon');

  const toggleFavourite = () => updateChatSetting(currentChatKey, { favourite: !isFavourite });

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
    if (!groupName.trim()) { setError('Enter a group name.'); return; }
    if (!groupMembers.length) { setError('Select at least one friend to add to the group.'); return; }
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

  const shareChat = () => {
    const label = selected?.type === 'group' ? selected.data.name : `@${selected?.data?.username}`;
    const text = `Chat with ${label} on ChatApp`;
    if (navigator.share) {
      navigator.share({ title: 'ChatApp', text }).catch(() => {});
    } else if (navigator.clipboard) {
      navigator.clipboard.writeText(text);
      setNotice('Copied to clipboard');
    }
    setActivePopover(null);
  };

  const availableContacts = contacts.filter((contact) => !conversations.some((chat) => chat.id === contact.id));
  const query = searchQuery.trim().toLowerCase();
  const filteredConversations = conversations.filter((c) => c.username.toLowerCase().includes(query));
  const filteredGroups = groups.filter((g) => g.name.toLowerCase().includes(query));

  const visibleMessages = useMemo(() => {
    if (!chatSearchQuery.trim()) return messages;
    const q = chatSearchQuery.trim().toLowerCase();
    return messages.filter((item) => (item.msg || '').toLowerCase().includes(q));
  }, [messages, chatSearchQuery]);

  const groupedMessages = useMemo(() => {
    const result = [];
    let lastLabel = null;
    visibleMessages.forEach((item) => {
      const label = formatDateLabel(item.timeStamp);
      if (label !== lastLabel) { result.push({ label, items: [] }); lastLabel = label; }
      result[result.length - 1].items.push(item);
    });
    return result;
  }, [visibleMessages]);

  const scrollToBottom = () => {
    if (chatScrollRef.current) chatScrollRef.current.scrollTo({ top: chatScrollRef.current.scrollHeight, behavior: 'smooth' });
  };

  const isDirectOnline = selected?.type === 'direct' && onlineUserIds.has(selected.data.id);
  const isDirectTyping = selected?.type === 'direct' && Boolean(typingMap[selected.data.id]);
  const directLastSeen = selected?.type === 'direct' ? lastSeenMap[selected.data.id] : null;
  const groupTypingUsers = selected?.type === 'group' ? Array.from(typingMap[selected.data.id] || []) : [];
  const isGroupTyping = groupTypingUsers.length > 0;

  // Block status is looked up from the live `contacts` list (not `selected.data`) so it
  // stays correct even if `selected` was set from a stale conversations-list entry.
  const selectedContactMeta = selected?.type === 'direct' ? contacts.find((c) => c.id === selected.data.id) : null;
  const isBlocked = Boolean(selectedContactMeta?.blockedByMe);

  let statusText = '';
  if (selected?.type === 'direct') {
    if (isBlocked) statusText = 'blocked';
    else if (isDirectTyping) statusText = 'typing…';
    else if (isDirectOnline) statusText = 'online';
    else if (directLastSeen) statusText = `last seen ${new Date(directLastSeen).toLocaleString([], { day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' })}`;
  } else if (isGroupTyping) {
    statusText = `${groupTypingUsers.join(', ')} ${groupTypingUsers.length > 1 ? 'are' : 'is'} typing…`;
  }

  const renderCallRow = (call) => {
    const Icon = call.status === 'missed' ? PhoneMissed : call.direction === 'incoming' ? PhoneIncoming : PhoneOutgoing;
    return (
      <div className="ww-call-row" key={call.id}>
        <span className="ww-mini-avatar">{initialOf(call.contactUsername)}</span>
        <span className="ww-call-row-body">
          <strong>@{call.contactUsername}</strong>
          <span className={`ww-call-row-meta ${call.status === 'missed' ? 'missed' : ''}`}>
            <Icon size={13} />
            {call.status === 'missed' ? 'Missed' : call.status === 'declined' ? 'Declined' : `Answered · ${formatDuration(call.duration)}`}
            {' · '}{new Date(call.startTime).toLocaleString([], { day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' })}
          </span>
        </span>
        <button
          type="button"
          className="ww-call-row-action"
          title="Video call"
          onClick={() => {
            const contact = contacts.find((c) => c.id === call.contactId);
            if (contact) startCall(contact);
          }}
        >
          <Video size={18} />
        </button>
      </div>
    );
  };

  return (
    <div className={`ww-shell ${selected ? 'has-chat-open' : ''}`}>
      {/* Hidden file inputs driving the attach sheet + input-bar camera button */}
      <input type="file" accept="image/*" ref={galleryInputRef} style={{ display: 'none' }} onChange={handleGallerySelect} />
      <input type="file" ref={documentInputRef} style={{ display: 'none' }} onChange={handleDocumentSelect} />
      <input type="file" accept="audio/*" ref={audioFileInputRef} style={{ display: 'none' }} onChange={handleAudioFileSelect} />
      <input type="file" accept="image/*" capture="environment" ref={cameraInputRef} style={{ display: 'none' }} onChange={handleCameraCapture} />

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
          <button
            type="button"
            title="New group call"
            className={activePopover === 'groupCallPicker' && !callPickerGroupId ? 'active' : ''}
            onClick={() => openCallPicker(contacts.map((c) => ({ id: c.id, username: c.username })), null)}
          >
            <Video size={22} />
          </button>
          <button
            type="button"
            title="Calls"
            className={showCallsPanel ? 'active' : ''}
            onClick={() => { setShowCallsPanel((prev) => !prev); setActivePopover(null); if (!showCallsPanel) loadCallHistory(); }}
          >
            <Phone size={22} />
          </button>
        </div>
        <div className="ww-rail-bottom">
          <button type="button" title="Log out" onClick={() => setConfirmLogout(true)}>
            <LogOut size={22} />
          </button>
        </div>
      </aside>

      {/* -------- Chat list / Calls panel -------- */}
      <section className="ww-list-panel">
        {showCallsPanel ? (
          <>
            <header className="ww-list-header">
              <div className="ww-list-header-top">
                <h2>Calls</h2>
                <button type="button" onClick={() => setShowCallsPanel(false)}><X size={20} /></button>
              </div>
            </header>
            <div className="ww-conversation-list">
              {callHistory.map(renderCallRow)}
              {!callHistory.length && <p className="ww-empty-chats">No calls yet.</p>}
            </div>
          </>
        ) : (
        <>
        <header className="ww-list-header">
          <div className="ww-list-header-top">
            <h2>ChatApp</h2>
            <div className="ww-list-header-icons">
              <button type="button" title="Search" onClick={() => searchInputRef.current?.focus()}><Search size={20} /></button>
              <button type="button" title="Menu" onClick={() => setActivePopover(activePopover === 'menu' ? null : 'menu')}>
                <MoreVertical size={20} />
              </button>
            </div>
          </div>
          <div className="ww-mobile-tabs">
            <button type="button" className={activeTab === 'chats' ? 'active' : ''} onClick={() => setActiveTab('chats')}>CHATS</button>
            <button type="button" className={activeTab === 'status' ? 'active' : ''} onClick={() => setActiveTab('status')}>STATUS</button>
            <button type="button" className={activeTab === 'calls' ? 'active' : ''} onClick={() => { setActiveTab('calls'); loadCallHistory(); }}>CALLS</button>
          </div>
        </header>

        {activePopover === 'menu' && (
          <div className="ww-menu-dropdown">
            <button type="button" onClick={() => setActivePopover('newGroup')}>New group</button>
            <button type="button" onClick={() => { setInfoPanel('self'); setActivePopover(null); }}>Profile</button>
            <button type="button" onClick={() => { setActivePopover(null); setConfirmLogout(true); }}>Log out</button>
          </div>
        )}

        <div className="ww-search-bar">
          <Search size={16} />
          <input
            ref={searchInputRef}
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
              <button type="submit">Create group</button>
            </form>
          </div>
        )}

        {activeTab === 'status' ? (
          <div className="ww-tab-placeholder">Status updates will appear here.</div>
        ) : activeTab === 'calls' ? (
          <div className="ww-conversation-list">
            {callHistory.map(renderCallRow)}
            {!callHistory.length && <p className="ww-empty-chats">No calls yet.</p>}
          </div>
        ) : (
        <>
        <div className="ww-list-view-toggle">
          <button type="button" className={chatListView === 'direct' ? 'active' : ''} onClick={() => setChatListView('direct')}>
            <MessageCircle size={15} /> Chats
          </button>
          <button type="button" className={chatListView === 'groups' ? 'active' : ''} onClick={() => setChatListView('groups')}>
            <UsersRound size={15} /> Groups
          </button>
        </div>
        <div className="ww-conversation-list">
          {chatListView === 'direct' ? (
          <div className="ww-list-section direct">
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
          </div>
          ) : (
          <div className="ww-list-section groups">
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
        </div>
        </>
        )}

        {activeTab === 'chats' && (
          <button type="button" className="ww-fab" title="New chat" onClick={() => setActivePopover('newChat')}>
            <MessageSquarePlus size={22} />
          </button>
        )}
        </>
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
                    {statusText && <span className={`ww-status-line ${isDirectTyping || isGroupTyping ? 'typing' : ''} ${isBlocked ? 'blocked' : ''}`}>{statusText}</span>}
                  </span>
                </button>
              </div>
              <div className="ww-header-icons">
                {selected.type === 'direct' && (
                  <button type="button" title="Video call" disabled={isBlocked} onClick={() => startCall()}><Video size={20} /></button>
                )}
                {selected.type === 'group' && (
                  <button
                    type="button"
                    title="Group video call"
                    onClick={() => openCallPicker(
                      selected.data.members.filter((m) => m.userId !== user.id).map((m) => ({ id: m.userId, username: m.username })),
                      selected.data.id,
                    )}
                  >
                    <Video size={20} />
                  </button>
                )}
                <button
                  type="button"
                  title="Search in chat"
                  className={chatSearchOpen ? 'active' : ''}
                  onClick={() => { setChatSearchOpen((prev) => !prev); setChatSearchQuery(''); }}
                >
                  <Search size={20} />
                </button>
                <button type="button" title="More options" onClick={() => setActivePopover(activePopover === 'chatMenu' ? null : 'chatMenu')}>
                  <MoreVertical size={20} />
                </button>
              </div>

              {activePopover === 'chatMenu' && (
                <div className="ww-chat-menu-dropdown">
                  <button type="button" onClick={() => { setActivePopover('newGroup'); }}><Users size={16} /> New group</button>
                  <button type="button" onClick={() => { setInfoPanel('contact'); setActivePopover(null); }}><Info size={16} /> {selected.type === 'group' ? 'Group info' : 'Contact info'}</button>
                  <button type="button" onClick={() => { setInfoPanel('contact'); setActivePopover(null); }}><Link2 size={16} /> Media, links & docs</button>
                  <button type="button" onClick={() => { updateChatSetting(currentChatKey, { disappearing: !isDisappearing }); setActivePopover(null); }}>
                    <Clock size={16} /> Disappearing messages · {isDisappearing ? 'On' : 'Off'}
                  </button>
                  <button type="button" onClick={() => setActivePopover('chatTheme')}><Palette size={16} /> Chat theme</button>
                  <button type="button" onClick={shareChat}><Share2 size={16} /> Share</button>
                  <div className="ww-menu-divider" />
                  <button type="button" onClick={clearChat}><Trash2 size={16} /> Clear chat</button>
                  <button type="button" onClick={exportChat}><Download size={16} /> Export chat</button>
                  <button type="button" onClick={addShortcut}><Link2 size={16} /> Add shortcut</button>
                  <button type="button" onClick={addToList}><Star size={16} /> Add to list</button>
                  <div className="ww-menu-divider" />
                  <button type="button" onClick={reportChat}><Flag size={16} /> Report {selected.type === 'group' ? 'group' : 'contact'}</button>
                  {selected.type === 'direct' ? (
                    <button type="button" onClick={() => { toggleBlock(selectedContactMeta || selected.data); setActivePopover(null); }}>
                      {isBlocked ? <ShieldCheck size={16} /> : <Ban size={16} />} {isBlocked ? 'Unblock' : 'Block'}
                    </button>
                  ) : (
                    <button type="button" onClick={() => { exitGroup(); setActivePopover(null); }}><LogOut size={16} /> Exit group</button>
                  )}
                </div>
              )}

              {activePopover === 'chatTheme' && (
                <div className="ww-attach-sheet-overlay" onClick={() => setActivePopover(null)}>
                  <div className="ww-theme-sheet" onClick={(event) => event.stopPropagation()}>
                    <div className="ww-popover-header">
                      <h3>Chat theme</h3>
                      <button type="button" onClick={() => setActivePopover(null)}><X size={18} /></button>
                    </div>
                    <div className="ww-theme-grid">
                      {THEME_COLORS.map((color) => (
                        <button
                          type="button"
                          key={color}
                          className={currentSettings.theme === color ? 'active' : ''}
                          style={{ background: color }}
                          onClick={() => { updateChatSetting(currentChatKey, { theme: color }); setActivePopover(null); }}
                        />
                      ))}
                    </div>
                    <button type="button" className="ww-theme-reset" onClick={() => { updateChatSetting(currentChatKey, { theme: null }); setActivePopover(null); }}>
                      Reset to default
                    </button>
                  </div>
                </div>
              )}
            </header>

            {chatSearchOpen && (
              <div className="ww-chat-search-bar">
                <Search size={16} />
                <input
                  autoFocus
                  value={chatSearchQuery}
                  onChange={(event) => setChatSearchQuery(event.target.value)}
                  placeholder="Search in this conversation"
                />
                <button type="button" onClick={() => { setChatSearchOpen(false); setChatSearchQuery(''); }}><X size={16} /></button>
              </div>
            )}

            {isBlocked && (
              <div className="ww-blocked-banner">
                <Ban size={14} /> You blocked @{selected.data.username}. Unblock them to send or receive messages.
              </div>
            )}

            {isDisappearing && !isBlocked && (
              <div className="ww-disappearing-banner">
                <Clock size={13} /> Disappearing messages are on for this chat.
              </div>
            )}

            <div className="ww-chat" ref={chatScrollRef} style={currentSettings.theme ? { '--chat-accent': currentSettings.theme } : undefined}>
              {groupedMessages.map((group) => (
                <React.Fragment key={group.label}>
                  <div className="ww-date-chip"><span>{group.label}</span></div>
                  {group.items.map((item) => {
                    const mine = item.senderId === user.id;
                    return (
                    <div
                      key={item.id}
                      className={`ww-message ${mine ? 'me' : ''} ${item.type === 'call' ? 'call-log' : ''}`}
                      onMouseLeave={() => setMessageMenuId((prev) => (prev === item.id ? null : prev))}
                    >
                      {selected.type === 'group' && !mine && item.type !== 'call' && <div className="ww-sender">@{item.username}</div>}

                      {item.deletedForEveryone ? (
                        <div className="ww-bubble-text deleted">🚫 This message was deleted</div>
                      ) : item.type === 'call' ? (
                        <div className="ww-call-log-body">
                          {item.callInfo?.status === 'missed' ? <PhoneMissed size={16} /> : <Video size={16} />}
                          <span>
                            {item.callInfo?.status === 'missed' ? 'Missed video call' : item.callInfo?.status === 'declined' ? 'Declined video call' : `Video call · ${formatDuration(item.callInfo?.duration)}`}
                          </span>
                        </div>
                      ) : item.type === 'audio' ? (
                        <div className="ww-audio-bubble">
                          <audio controls src={item.audioData} />
                        </div>
                      ) : item.type === 'image' ? (
                        <a className="ww-image-bubble" href={item.fileData} target="_blank" rel="noreferrer">
                          <img src={item.fileData} alt={item.fileName || 'Shared image'} />
                        </a>
                      ) : item.type === 'file' ? (
                        <a className="ww-file-bubble" href={item.fileData} download={item.fileName}>
                          <FileText size={22} />
                          <span>{item.fileName || 'Document'}</span>
                        </a>
                      ) : item.type === 'location' ? (
                        <a
                          className="ww-location-bubble"
                          href={`https://www.google.com/maps?q=${item.location?.lat},${item.location?.lng}`}
                          target="_blank" rel="noreferrer"
                        >
                          <MapPin size={18} />
                          <span>Shared location</span>
                        </a>
                      ) : item.type === 'contact' ? (
                        <div className="ww-contact-bubble">
                          <span className="ww-mini-avatar">{initialOf(item.contactShare?.username)}</span>
                          <span>@{item.contactShare?.username}</span>
                        </div>
                      ) : (
                        <div className="ww-bubble-text">{item.msg}</div>
                      )}

                      {item.type !== 'call' && !item.deletedForEveryone && (
                        <button
                          type="button"
                          className="ww-msg-menu-btn"
                          onClick={() => setMessageMenuId((prev) => (prev === item.id ? null : item.id))}
                        >
                          <MoreVertical size={14} />
                        </button>
                      )}

                      {messageMenuId === item.id && (
                        <div className="ww-msg-menu">
                          <button type="button" onClick={() => openForward(item)}><Forward size={13} /> Forward</button>
                          <button type="button" onClick={() => deleteMessage(item, false)}><Trash2 size={13} /> Delete for me</button>
                          {mine && <button type="button" onClick={() => deleteMessage(item, true)}><Trash2 size={13} /> Delete for everyone</button>}
                        </div>
                      )}

                      {item.type !== 'call' && !item.deletedForEveryone && (
                        <div className="ww-meta">
                          <span className="ww-time">{new Date(item.timeStamp).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}</span>
                          {mine && selected.type === 'direct' && (
                            item.read
                              ? <CheckCheck size={14} className="ww-check read" />
                              : item.delivered
                                ? <CheckCheck size={14} className="ww-check" />
                                : <Check size={14} className="ww-check" />
                          )}
                          {mine && selected.type === 'group' && <CheckCheck size={14} className="ww-check" />}
                        </div>
                      )}
                    </div>
                  );})}
                </React.Fragment>
              ))}
              {!visibleMessages.length && <p className="ww-empty-chats">{chatSearchQuery ? 'No messages match your search.' : 'Say hello 👋 — no messages here yet.'}</p>}
              {(isDirectTyping || isGroupTyping) && (
                <div className="ww-typing-bubble">
                  <span className="ww-dot" /><span className="ww-dot" /><span className="ww-dot" />
                </div>
              )}
            </div>

            <button type="button" className="ww-scroll-fab" onClick={scrollToBottom} title="Scroll to latest">
              <ChevronDown size={18} />
            </button>

            {showEmojiPicker && (
              <div className="ww-emoji-picker">
                {EMOJIS.map((emoji) => (
                  <button type="button" key={emoji} onClick={() => insertEmoji(emoji)}>{emoji}</button>
                ))}
              </div>
            )}

            <form className="ww-inputbar" onSubmit={sendMessage}>
              <button type="button" className="ww-emoji" title="Emoji" disabled={isBlocked} onClick={() => setShowEmojiPicker((prev) => !prev)}>
                <Smile size={20} />
              </button>
              <button
                type="button"
                className="ww-attach"
                title="Attach"
                disabled={isBlocked}
                onClick={() => setActivePopover(activePopover === 'attach' ? null : 'attach')}
              >
                <Paperclip size={20} />
              </button>
              {isRecording ? (
                <div className="ww-recording-indicator">
                  <span className="ww-rec-dot" /> Recording… {formatDuration(recordSeconds)}
                </div>
              ) : (
                <input
                  value={message}
                  onChange={handleMessageChange}
                  placeholder={isBlocked ? 'You blocked this contact' : 'Type a message here ..'}
                  disabled={isBlocked}
                />
              )}
              <button type="button" className="ww-camera-btn" title="Camera" disabled={isBlocked} onClick={() => cameraInputRef.current?.click()}>
                <Camera size={20} />
              </button>
              {message.trim() ? (
                <button type="submit" className="ww-send" title="Send" disabled={isBlocked}><Send size={18} /></button>
              ) : (
                <button
                  type="button"
                  className={`ww-send ww-mic ${isRecording ? 'recording' : ''}`}
                  title={isRecording ? 'Stop and send' : 'Voice message'}
                  disabled={isBlocked}
                  onClick={handleMicClick}
                >
                  {isRecording ? <StopCircle size={18} /> : <Mic size={18} />}
                </button>
              )}
            </form>

            {activePopover === 'attach' && (
              <div className="ww-attach-sheet-overlay" onClick={() => setActivePopover(null)}>
                <div className="ww-attach-sheet" onClick={(event) => event.stopPropagation()}>
                  <div className="ww-attach-grid">
                    <button type="button" onClick={() => documentInputRef.current?.click()}>
                      <span className="ww-attach-icon doc"><FileText size={22} /></span>Document
                    </button>
                    <button type="button" onClick={() => cameraInputRef.current?.click()}>
                      <span className="ww-attach-icon cam"><Camera size={22} /></span>Camera
                    </button>
                    <button type="button" onClick={() => galleryInputRef.current?.click()}>
                      <span className="ww-attach-icon gal"><ImageIcon size={22} /></span>Gallery
                    </button>
                    <button type="button" onClick={() => audioFileInputRef.current?.click()}>
                      <span className="ww-attach-icon aud"><Headphones size={22} /></span>Audio
                    </button>
                    <button type="button" onClick={shareLocation}>
                      <span className="ww-attach-icon loc"><MapPin size={22} /></span>Location
                    </button>
                    <button type="button" onClick={() => setActivePopover('shareContact')}>
                      <span className="ww-attach-icon con"><UserIcon size={22} /></span>Contact
                    </button>
                  </div>
                </div>
              </div>
            )}

            {activePopover === 'shareContact' && (
              <div className="ww-attach-sheet-overlay" onClick={() => setActivePopover(null)}>
                <div className="ww-forward-sheet" onClick={(event) => event.stopPropagation()}>
                  <div className="ww-popover-header">
                    <h3>Share a contact</h3>
                    <button type="button" onClick={() => setActivePopover(null)}><X size={18} /></button>
                  </div>
                  <div className="ww-popover-list">
                    {contacts.map((contact) => (
                      <button type="button" key={contact.id} onClick={() => shareContact(contact)}>
                        <span className="ww-mini-avatar">{initialOf(contact.username)}</span>
                        @{contact.username}
                      </button>
                    ))}
                    {!contacts.length && <p className="ww-popover-empty">Add friends first to share a contact.</p>}
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
        {notice && <p className="ww-auth-notice">{notice}</p>}
      </main>

      {/* -------- Contact / profile info -------- */}
      {infoPanel && (infoPanel === 'self' || selected) && (
        <aside className="ww-info-panel">
          <header className="ww-info-header">
            <button type="button" onClick={() => setInfoPanel(null)}><X size={20} /></button>
            <h2>{infoPanel === 'self' ? 'Profile' : selected.type === 'group' ? 'Group Info' : 'Contact Info'}</h2>
            {infoPanel !== 'self' && selected.type === 'group' && (
              <button
                type="button"
                className="ww-info-menu-btn"
                onClick={() => setActivePopover(activePopover === 'groupInfoMenu' ? null : 'groupInfoMenu')}
              >
                <MoreVertical size={18} />
              </button>
            )}
          </header>

          {activePopover === 'groupInfoMenu' && (
            <div className="ww-chat-menu-dropdown group-info">
              <button type="button" onClick={() => { setEditingGroupField('name'); setGroupNameDraft(selected.data.name); setActivePopover(null); }}>
                <Pencil size={15} /> Edit name
              </button>
              <button type="button" onClick={() => { setEditingGroupField('description'); setGroupDescriptionDraft(selected.data.description || ''); setActivePopover(null); }}>
                <Pencil size={15} /> Edit description
              </button>
              <button type="button" onClick={exportChat}><Download size={15} /> Export chat</button>
            </div>
          )}

          <div className="ww-info-body">
            <div className="ww-info-avatar">
              {initialOf(infoPanel === 'self' ? user.name : selected.type === 'group' ? selected.data.name : selected.data.username)}
            </div>

            {infoPanel !== 'self' && selected.type === 'group' && editingGroupField === 'name' ? (
              <form className="ww-inline-edit" onSubmit={saveGroupName}>
                <input value={groupNameDraft} onChange={(event) => setGroupNameDraft(event.target.value)} autoFocus maxLength={80} />
                <button type="submit" title="Save"><Check size={14} /></button>
                <button type="button" title="Cancel" onClick={() => setEditingGroupField(null)}><X size={14} /></button>
              </form>
            ) : (
              <h3>{infoPanel === 'self' ? user.name : selected.type === 'group' ? selected.data.name : `@${selected.data.username}`}</h3>
            )}

            <p className="ww-info-sub">
              {infoPanel === 'self' ? `@${user.username}` : selected.type === 'group' ? `${selected.data.members.length} members` : 'Friend'}
            </p>

            {infoPanel !== 'self' && selected.type === 'direct' && (
              <button type="button" className={`ww-block-btn ${isBlocked ? 'blocked' : ''}`} onClick={() => toggleBlock(selectedContactMeta || selected.data)}>
                {isBlocked ? <ShieldCheck size={16} /> : <Ban size={16} />}
                {isBlocked ? `Unblock @${selected.data.username}` : `Block @${selected.data.username}`}
              </button>
            )}

            {infoPanel !== 'self' && selected.type === 'group' && (
              <div className="ww-info-section">
                <h4>Description</h4>
                {editingGroupField === 'description' ? (
                  <form className="ww-inline-edit-block" onSubmit={saveGroupDescription}>
                    <textarea value={groupDescriptionDraft} onChange={(event) => setGroupDescriptionDraft(event.target.value)} maxLength={500} autoFocus rows={3} />
                    <div className="ww-inline-edit-actions">
                      <button type="button" onClick={() => setEditingGroupField(null)}>Cancel</button>
                      <button type="submit">Save</button>
                    </div>
                  </form>
                ) : (
                  <button
                    type="button"
                    className="ww-description-block"
                    onClick={() => { setEditingGroupField('description'); setGroupDescriptionDraft(selected.data.description || ''); }}
                  >
                    {selected.data.description ? <p>{selected.data.description}</p> : <p className="placeholder">Add group description</p>}
                  </button>
                )}
              </div>
            )}

            {infoPanel !== 'self' && (
              <div className="ww-info-section">
                <h4>Media, Links and Documents</h4>
                <div className="ww-media-grid">
                  {messages.filter((m) => m.type === 'image').slice(-3).reverse().map((m) => (
                    <a key={m.id} href={m.fileData} target="_blank" rel="noreferrer" className="ww-media-thumb">
                      <img src={m.fileData} alt={m.fileName || 'Shared image'} />
                    </a>
                  ))}
                  {!messages.some((m) => m.type === 'image') && (
                    <>
                      <div className="ww-media-placeholder" />
                      <div className="ww-media-placeholder" />
                      <div className="ww-media-placeholder" />
                    </>
                  )}
                </div>
              </div>
            )}

            {infoPanel !== 'self' && (
              <div className="ww-info-toggles">
                <div className="ww-info-toggle-row">
                  <span>{isMuted ? <BellOff size={16} /> : <Bell size={16} />} Notifications</span>
                  <label className="ww-switch">
                    <input type="checkbox" checked={!isMuted} onChange={() => updateChatSetting(currentChatKey, { muted: !isMuted })} />
                    <span className="ww-switch-slider" />
                  </label>
                </div>
                <div className="ww-info-toggle-row">
                  <span><Eye size={16} /> Media visibility</span>
                  <label className="ww-switch">
                    <input type="checkbox" checked={isMediaVisible} onChange={() => updateChatSetting(currentChatKey, { mediaVisibility: !isMediaVisible })} />
                    <span className="ww-switch-slider" />
                  </label>
                </div>
                <div className="ww-info-toggle-row">
                  <span><Clock size={16} /> Disappearing messages</span>
                  <label className="ww-switch">
                    <input type="checkbox" checked={isDisappearing} onChange={() => updateChatSetting(currentChatKey, { disappearing: !isDisappearing })} />
                    <span className="ww-switch-slider" />
                  </label>
                </div>
                <div className="ww-info-toggle-row">
                  <span><Lock size={16} /> Chat lock</span>
                  <label className="ww-switch">
                    <input type="checkbox" checked={isChatLocked} onChange={() => updateChatSetting(currentChatKey, { locked: !isChatLocked })} />
                    <span className="ww-switch-slider" />
                  </label>
                </div>
              </div>
            )}

            {infoPanel !== 'self' && selected.type === 'group' && (
              <div className="ww-info-section">
                <div className="ww-section-header-row">
                  <h4>{selected.data.members.length} Members</h4>
                  <button type="button" className="ww-add-members-btn" onClick={() => { setAddMembersSelection([]); setActivePopover('addMembers'); }}>
                    <UserPlus size={15} /> Add
                  </button>
                </div>
                <ul className="ww-member-list">
                  {selected.data.members.map((member) => (
                    <li key={member.userId}>
                      <span className="ww-mini-avatar">{initialOf(member.username)}</span>
                      <span className="ww-member-name-col">
                        <span>@{member.username}{member.userId === user.id ? ' (You)' : ''}</span>
                        {member.userId === selected.data.createdBy && <span className="ww-admin-badge">Group admin</span>}
                      </span>
                    </li>
                  ))}
                </ul>
              </div>
            )}

            {infoPanel !== 'self' && (
              <div className="ww-info-actions">
                {selected.type === 'group' && <button type="button" onClick={viewMemberChanges}><Users size={16} /> View member changes</button>}
                <button type="button" onClick={toggleFavourite}><Star size={16} className={isFavourite ? 'ww-favourite-filled' : ''} /> {isFavourite ? 'Remove from favourites' : 'Add to favourites'}</button>
                <button type="button" onClick={addToList}><Star size={16} /> Add to list</button>
              </div>
            )}

            {infoPanel !== 'self' && (
              <div className="ww-info-actions danger">
                <button type="button" onClick={clearChat}><Trash2 size={16} /> Clear chat</button>
                {selected.type === 'group' ? (
                  <button type="button" onClick={exitGroup}><LogOut size={16} /> Exit group</button>
                ) : null}
                <button type="button" onClick={reportChat}><Flag size={16} /> Report {selected.type === 'group' ? 'group' : 'contact'}</button>
              </div>
            )}

            {infoPanel !== 'self' && selected.type === 'group' && selected.data.createdAt && (
              <p className="ww-group-created">
                Group created on {new Date(selected.data.createdAt).toLocaleDateString([], { day: 'numeric', month: 'long', year: 'numeric' })}
              </p>
            )}
          </div>
        </aside>
      )}

      {/* -------- Add members to an existing group -------- */}
      {activePopover === 'addMembers' && selected?.type === 'group' && (
        <div className="ww-attach-sheet-overlay" onClick={() => setActivePopover(null)}>
          <div className="ww-forward-sheet" onClick={(event) => event.stopPropagation()}>
            <div className="ww-popover-header">
              <h3>Add members</h3>
              <button type="button" onClick={() => setActivePopover(null)}><X size={18} /></button>
            </div>
            <div className="ww-checkbox-list ww-add-members-list">
              {contacts.filter((c) => !selected.data.members.some((m) => m.userId === c.id)).map((contact) => (
                <label key={contact.id}>
                  <input type="checkbox" checked={addMembersSelection.includes(contact.id)} onChange={() => toggleAddMember(contact.id)} />
                  @{contact.username}
                </label>
              ))}
              {!contacts.filter((c) => !selected.data.members.some((m) => m.userId === c.id)).length && (
                <p className="ww-popover-empty">All your friends are already in this group.</p>
              )}
            </div>
            <button type="button" className="ww-start-call-btn" disabled={!addMembersSelection.length} onClick={submitAddMembers}>
              <UserPlus size={16} /> Add {addMembersSelection.length || ''} member{addMembersSelection.length === 1 ? '' : 's'}
            </button>
          </div>
        </div>
      )}

      {/* -------- Forward message picker -------- */}
      {forwardingMessage && (
        <div className="ww-attach-sheet-overlay" onClick={() => setForwardingMessage(null)}>
          <div className="ww-forward-sheet" onClick={(event) => event.stopPropagation()}>
            <div className="ww-popover-header">
              <h3>Forward message</h3>
              <button type="button" onClick={() => setForwardingMessage(null)}><X size={18} /></button>
            </div>
            <div className="ww-popover-list">
              {contacts.map((contact) => (
                <button type="button" key={contact.id} onClick={() => forwardTo('direct', contact)}>
                  <span className="ww-mini-avatar">{initialOf(contact.username)}</span>
                  @{contact.username}
                </button>
              ))}
              {groups.map((group) => (
                <button type="button" key={group.id} onClick={() => forwardTo('group', group)}>
                  <span className="ww-mini-avatar">{initialOf(group.name)}</span>
                  {group.name}
                </button>
              ))}
              {!contacts.length && !groups.length && <p className="ww-popover-empty">Add friends or a group first.</p>}
            </div>
          </div>
        </div>
      )}

      {/* -------- Group call picker (from rail or a group's header) -------- */}
      {activePopover === 'groupCallPicker' && (
        <div className="ww-attach-sheet-overlay" onClick={() => setActivePopover(null)}>
          <div className="ww-forward-sheet" onClick={(event) => event.stopPropagation()}>
            <div className="ww-popover-header">
              <h3>{callPickerGroupId ? 'Start group call' : 'New group call'}</h3>
              <button type="button" onClick={() => setActivePopover(null)}><X size={18} /></button>
            </div>
            <p className="ww-call-picker-hint">Pick up to {MAX_GROUP_CALL_PARTICIPANTS - 1} people ({callPickerSelection.length}/{MAX_GROUP_CALL_PARTICIPANTS - 1} selected)</p>
            <div className="ww-popover-list">
              {callPickerContacts.map((contact) => (
                <label key={contact.id} className="ww-call-pick-row">
                  <input
                    type="checkbox"
                    checked={callPickerSelection.includes(contact.id)}
                    disabled={!callPickerSelection.includes(contact.id) && callPickerSelection.length >= MAX_GROUP_CALL_PARTICIPANTS - 1}
                    onChange={() => toggleCallPick(contact.id)}
                  />
                  <span className="ww-mini-avatar">{initialOf(contact.username)}</span>
                  @{contact.username}
                </label>
              ))}
              {!callPickerContacts.length && <p className="ww-popover-empty">No one available to call here yet.</p>}
            </div>
            <button
              type="button"
              className="ww-start-call-btn"
              disabled={!callPickerSelection.length}
              onClick={() => { startGroupCall(callPickerSelection, callPickerGroupId); setActivePopover(null); }}
            >
              <Video size={16} /> Start call ({callPickerSelection.length + 1})
            </button>
          </div>
        </div>
      )}

      {/* -------- Group call modals -------- */}
      {groupCallInvite && (
        <div className="ww-call-modal">
          <span className="ww-info-avatar small">{initialOf(groupCallInvite.from.username)}</span>
          <p>
            @{groupCallInvite.from.username} started a group call
            {groupCallInvite.groupId ? ` in ${groups.find((g) => g.id === groupCallInvite.groupId)?.name || 'a group'}` : ''}
            {' '}({groupCallInvite.participantIds.length} people)
          </p>
          <div className="ww-call-actions">
            <button type="button" className="accept" onClick={acceptGroupCallInvite}><Video size={16} /> Join</button>
            <button type="button" className="decline" onClick={declineGroupCallInvite}><PhoneOff size={16} /> Decline</button>
          </div>
        </div>
      )}
      {groupCall && (
        <div className="ww-call-modal video group">
          <p>
            Group call
            {groupCall.groupId ? ` · ${groups.find((g) => g.id === groupCall.groupId)?.name || ''}` : ''}
            {' '}({groupCallParticipants.length + 1}/{MAX_GROUP_CALL_PARTICIPANTS})
          </p>
          <div className="ww-group-video-grid">
            <div className="ww-group-video-tile">
              <video ref={localGroupVideoRef} autoPlay muted playsInline />
              <span className="ww-group-video-label">You</span>
            </div>
            {groupCallParticipants.map((participant) => (
              <div key={participant.userId} className="ww-group-video-tile">
                <video
                  autoPlay
                  playsInline
                  ref={(element) => { if (element && element.srcObject !== participant.stream) element.srcObject = participant.stream; }}
                />
                <span className="ww-group-video-label">@{participant.username}</span>
              </div>
            ))}
          </div>
          <button type="button" className="decline" onClick={leaveGroupCall}><PhoneOff size={16} /> Leave call</button>
        </div>
      )}

      {/* -------- Call modals -------- */}
      {incomingCall && (
        <div className="ww-call-modal">
          <span className="ww-info-avatar small">{initialOf(incomingCall.contact.username)}</span>
          <p>@{incomingCall.contact.username} is calling…</p>
          <div className="ww-call-actions">
            <button type="button" className="accept" onClick={acceptCall}><Video size={16} /> Accept</button>
            <button type="button" className="decline" onClick={declineCall}><PhoneOff size={16} /> Decline</button>
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

      {/* -------- Logout confirm -------- */}
      {confirmLogout && (
        <div className="ww-call-modal">
          <p>Log out of ChatApp?</p>
          <div className="ww-call-actions">
            <button type="button" className="decline" onClick={logout}><LogOut size={16} /> Log out</button>
            <button type="button" className="accept" onClick={() => setConfirmLogout(false)}>Cancel</button>
          </div>
        </div>
      )}
    </div>
  );
};

export default ChatApp;