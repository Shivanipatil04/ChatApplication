import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { io } from 'socket.io-client'
import { useNavigate } from 'react-router-dom'
import { API_URL, api } from '../config/api'
import { useDirectCall } from '../hooks/useDirectCall'
import { useGroupCall } from '../hooks/useGroupCall'
import ThreeDotMenu from '../components/ThreeDotMenu'
// E2EE integration point
import { encryptMessage, decryptMessage, DECRYPT_FALLBACK, isEncryptedPayload } from '../services/encryptionService'
import EncryptionBanner from '../components/EncryptionBanner'
import {
  Video, Search, MoreVertical, Paperclip, Send, X, MessageSquarePlus,
  UsersRound, LogOut, Check, CheckCheck, ChevronDown, PhoneOff, ArrowLeft,
  Smile, Camera, Mic, FileText, Image as ImageIcon, Headphones, MapPin,
  User as UserIcon, Phone, PhoneIncoming, PhoneOutgoing, PhoneMissed,
  Trash2, Users, Link2, Share2, Info, StopCircle, Forward, Ban, ShieldCheck,
  MessageCircle, Clock, Palette, Download, Flag, Star, Bell, BellOff, Lock,
  UserPlus, Pencil, Eye, MicOff, VideoOff, CircleDot, Settings2,
} from 'lucide-react'
import './ChatApp.css'

const MAX_GROUP_CALL_PARTICIPANTS = 4;
const THEME_COLORS = ['#e0e7ff', '#fde68a', '#bbf7d0', '#fecaca', '#fbcfe8', '#bae6fd', '#ddd6fe', '#fed7aa'];
const CHAT_SETTINGS_KEY = 'ww-chat-settings';
const EMOJIS = [
  '😀','😂','😍','😊','👍','🙏','🎉','❤️','😢','😮',
  '🔥','👏','😅','🤔','😎','🥳','😴','🙌','💯','✨',
  '😇','🤗','😜','😭','🙃','😬','🤝','👀','🚀','🎂',
];
const MAX_ATTACHMENT_BYTES = 5 * 1024 * 1024;

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

const previewFor = (item) => {
  switch (item.type) {
    case 'audio': return '🎤 Voice message';
    case 'image': return '📷 Photo';
    case 'file': return `📄 ${item.fileName || 'Document'}`;
    case 'location': return '📍 Location';
    case 'contact': return '👤 Contact';
    case 'poll': return `📊 Poll: ${item.poll?.question || 'Poll'}`;
    case 'call': {
      const isAudio = item.callInfo?.callType === 'audio';
      const type = isAudio ? 'voice' : 'video';
      if (item.callInfo?.status === 'missed') return `📞 Missed ${type} call`;
      if (item.callInfo?.status === 'declined') return `📞 Declined ${type} call`;
      return `📞 ${type.charAt(0).toUpperCase() + type.slice(1)} call`;
    }
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
const chatKeyFor = (type, id) => (type && id ? `${type}-${id}` : null);

// ---- Self profile edit panel ----
const SelfProfilePanel = ({ authorization }) => {
  const [profile, setProfile] = useState({ name: '', username: '', email: '', phone: '', bio: '', avatar: '' });
  const [avatarPreview, setAvatarPreview] = useState('');
  const [loading, setLoading] = useState(false);
  const [msg, setMsg] = useState('');
  const [err, setErr] = useState('');
  const fileRef = useRef(null);

  useEffect(() => {
    api.get('/api/profile', authorization)
      .then(({ data }) => { setProfile(data); setAvatarPreview(data.avatar || ''); })
      .catch(() => {});
  }, [authorization]);

  const handleAvatarChange = (e) => {
    const file = e.target.files?.[0];
    if (!file) return;
    if (file.size > 2 * 1024 * 1024) { setErr('Image must be under 2 MB.'); return; }
    const reader = new FileReader();
    reader.onload = () => { setAvatarPreview(reader.result); setProfile((p) => ({ ...p, avatar: reader.result })); };
    reader.readAsDataURL(file);
  };

  const saveProfile = async (e) => {
    e.preventDefault();
    setErr(''); setMsg(''); setLoading(true);
    try {
      const { data } = await api.patch('/api/profile', { name: profile.name, bio: profile.bio, phone: profile.phone, avatar: profile.avatar }, authorization);
      setProfile(data);
      setAvatarPreview(data.avatar || '');
      const cached = JSON.parse(localStorage.getItem('chatUser') || '{}');
      localStorage.setItem('chatUser', JSON.stringify({ ...cached, name: data.name, avatar: data.avatar }));
      setMsg('Profile saved!');
    } catch (error) {
      setErr(error.response?.data?.message || 'Could not save profile.');
    } finally { setLoading(false); }
  };

  return (
    <form className="ww-profile-form" onSubmit={saveProfile}>
      <div className="ww-profile-avatar-wrap" onClick={() => fileRef.current?.click()} title="Change photo">
        {avatarPreview
          ? <img className="ww-profile-avatar-img" src={avatarPreview} alt="avatar" />
          : <div className="ww-info-avatar">{profile.name?.charAt(0)?.toUpperCase() || '?'}</div>}
        <div className="ww-profile-avatar-overlay">📷</div>
        <input ref={fileRef} type="file" accept="image/*" style={{ display: 'none' }} onChange={handleAvatarChange} />
      </div>
      <p className="ww-info-sub">@{profile.username}</p>
      <p className="ww-info-sub" style={{ fontSize: '12px', opacity: 0.6 }}>{profile.email}</p>
      <div className="ww-profile-field">
        <label>Display Name</label>
        <input type="text" value={profile.name} maxLength={60} onChange={(e) => setProfile((p) => ({ ...p, name: e.target.value }))} required />
      </div>
      <div className="ww-profile-field">
        <label>Phone</label>
        <input type="tel" placeholder="+1 555 000 0000" value={profile.phone} maxLength={20} onChange={(e) => setProfile((p) => ({ ...p, phone: e.target.value }))} />
      </div>
      <div className="ww-profile-field">
        <label>Bio</label>
        <textarea rows={3} maxLength={500} placeholder="Hey there! I'm using ChatApp." value={profile.bio} onChange={(e) => setProfile((p) => ({ ...p, bio: e.target.value }))} />
        <span className="ww-profile-hint">{profile.bio?.length || 0}/500</span>
      </div>
      {msg && <p className="ww-auth-notice" style={{ position: 'static', marginTop: 4 }}>{msg}</p>}
      {err && <p className="ww-auth-error" style={{ position: 'static', marginTop: 4 }}>{err}</p>}
      <button type="submit" className="ww-profile-save-btn" disabled={loading}>{loading ? 'Saving…' : 'Save Profile'}</button>
    </form>
  );
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
  const [notice, setNotice] = useState('');
  // Unread message counts — { [contactId|groupId]: number }
  // Incremented only for incoming messages while that chat is NOT currently open.
  const [unreadCounts, setUnreadCounts] = useState({});
  const [incomingCall, setIncomingCall] = useState(null);
  const [activeCall, setActiveCall] = useState(null);
  const [localStream, setLocalStream] = useState(null);

  // ---- Call UI state ----
  const [callDuration, setCallDuration] = useState(0);       // seconds elapsed
  const [callMinimized, setCallMinimized] = useState(false); // floating PiP mode
  const [speakerOn, setSpeakerOn] = useState(true);          // speaker vs earpiece (visual toggle)
  const [switchedToVideo, setSwitchedToVideo] = useState(false); // escalated voice→video
  const callTimerRef = useRef(null);

  // ---- Ringtone (Web Audio API — no external file needed) ----
  const ringtoneRef = useRef(null); // AudioContext

  const startRingtone = () => {
    stopRingtone();
    try {
      const ctx = new (window.AudioContext || window.webkitAudioContext)();
      ringtoneRef.current = ctx;
      let playing = true;

      const playRing = () => {
        if (!playing || ctx.state === 'closed') return;
        // Two-tone WhatsApp-style ring: 440 Hz then 480 Hz, 0.4s each, pause 2s
        const schedule = [
          { freq: 440, start: 0,   dur: 0.4 },
          { freq: 480, start: 0.4, dur: 0.4 },
        ];
        const totalCycle = 2.2; // ring + silence
        schedule.forEach(({ freq, start, dur }) => {
          const osc = ctx.createOscillator();
          const gain = ctx.createGain();
          osc.type = 'sine';
          osc.frequency.value = freq;
          gain.gain.setValueAtTime(0, ctx.currentTime + start);
          gain.gain.linearRampToValueAtTime(0.35, ctx.currentTime + start + 0.02);
          gain.gain.setValueAtTime(0.35, ctx.currentTime + start + dur - 0.02);
          gain.gain.linearRampToValueAtTime(0, ctx.currentTime + start + dur);
          osc.connect(gain);
          gain.connect(ctx.destination);
          osc.start(ctx.currentTime + start);
          osc.stop(ctx.currentTime + start + dur);
        });
        setTimeout(() => { if (playing && ctx.state !== 'closed') playRing(); }, totalCycle * 1000);
      };

      playRing();
      // Store stop fn on the context so stopRingtone can close it
      ctx._stop = () => { playing = false; };
    } catch { /* audio not supported — silent fail */ }
  };

  const stopRingtone = () => {
    if (ringtoneRef.current) {
      try {
        ringtoneRef.current._stop?.();
        ringtoneRef.current.close();
      } catch { /* ignore */ }
      ringtoneRef.current = null;
    }
  };

  // Start ringtone when incoming call arrives, stop when it's gone
  useEffect(() => {
    if (incomingCall) startRingtone();
    else stopRingtone();
    return stopRingtone; // eslint-disable-line react-hooks/exhaustive-deps
  }, [!!incomingCall]); // eslint-disable-line react-hooks/exhaustive-deps

  // Also stop ringtone when call becomes active (answered)
  useEffect(() => { if (activeCall) stopRingtone(); }, [activeCall]); // eslint-disable-line
  const [isMicMuted, setIsMicMuted] = useState(false);
  const [isCameraOff, setIsCameraOff] = useState(false);
  const [remoteStream, setRemoteStream] = useState(null);
  const [socketInstance, setSocketInstance] = useState(null);

  // ---- UI state ----
  const [searchQuery, setSearchQuery] = useState('');
  const [globalSearchResults, setGlobalSearchResults] = useState(null);
  const [activePopover, setActivePopover] = useState(null);
  const [infoPanel, setInfoPanel] = useState(null);
  const [activeTab, setActiveTab] = useState('chats');
  const [showCallsPanel, setShowCallsPanel] = useState(false);

  // ---- Status ----
  const [statusList, setStatusList] = useState([]);        // contacts' statuses
  const [myStatus, setMyStatus] = useState(null);          // current user's own status
  const [viewingStatus, setViewingStatus] = useState(null); // { userId, items[], index }
  const [newStatusText, setNewStatusText] = useState('');
  const [showAddStatus, setShowAddStatus] = useState(false);
  const [statusLoaded, setStatusLoaded] = useState(false);
  const [onlineUserIds, setOnlineUserIds] = useState(() => new Set());
  const [lastSeenMap, setLastSeenMap] = useState({});
  const [typingMap, setTypingMap] = useState({});
  const [callHistory, setCallHistory] = useState([]);
  const [confirmLogout, setConfirmLogout] = useState(false);
  const [showEmojiPicker, setShowEmojiPicker] = useState(false);
  const [forwardingMessage, setForwardingMessage] = useState(null);

  // ---- Group calls ----
  const [groupCallInvite, setGroupCallInvite] = useState(null);
  const [groupCall, setGroupCall] = useState(null);
  const [groupCallParticipants, setGroupCallParticipants] = useState([]);
  const [localGroupStream, setLocalGroupStream] = useState(null);
  const [isGroupMicMuted, setIsGroupMicMuted] = useState(false);
  const [isGroupCameraOff, setIsGroupCameraOff] = useState(false);
  const [callPickerContacts, setCallPickerContacts] = useState([]);
  const [callPickerGroupId, setCallPickerGroupId] = useState(null);
  const [callPickerSelection, setCallPickerSelection] = useState([]);

  // ---- Chat list view ----
  const [chatListView, setChatListView] = useState('direct');

  // ---- Per-chat settings ----
  const [chatSettings, setChatSettings] = useState(() => {
    try { return JSON.parse(localStorage.getItem(CHAT_SETTINGS_KEY) || '{}'); } catch { return {}; }
  });
  useEffect(() => {
    try { localStorage.setItem(CHAT_SETTINGS_KEY, JSON.stringify(chatSettings)); } catch { /* noop */ }
  }, [chatSettings]);

  const [archivedChats, setArchivedChats] = useState(() => {
    try { return JSON.parse(localStorage.getItem('ww-archived-chats') || '{}'); } catch { return {}; }
  });
  useEffect(() => {
    try { localStorage.setItem('ww-archived-chats', JSON.stringify(archivedChats)); } catch { /* noop */ }
  }, [archivedChats]);
  const [showArchivedPanel, setShowArchivedPanel] = useState(false);

  // ---- Pinned chats (server-persisted) ----
  const [pinnedChatKeys, setPinnedChatKeys] = useState([]);

  const [starredMessages, setStarredMessages] = useState([]);
  const [showStarredPanel, setShowStarredPanel] = useState(false);
  const [bulkSelectMode, setBulkSelectMode] = useState(false);
  const [selectedChatKeys, setSelectedChatKeys] = useState(new Set());

  const [isDarkMode, setIsDarkMode] = useState(() => localStorage.getItem('ww-theme') === 'dark');
  useEffect(() => {
    document.documentElement.classList.toggle('ww-dark', isDarkMode);
    localStorage.setItem('ww-theme', isDarkMode ? 'dark' : 'light');
  }, [isDarkMode]);

  const [appLockEnabled, setAppLockEnabled] = useState(() => !!localStorage.getItem('ww-app-lock-hash'));
  const [isLocked, setIsLocked] = useState(() => !!localStorage.getItem('ww-app-lock-hash'));
  const [appLockModal, setAppLockModal] = useState(null);
  const [pinInput, setPinInput] = useState('');
  const [pinError, setPinError] = useState('');

  // ---- Group editing ----
  const [editingGroupField, setEditingGroupField] = useState(null);
  const [groupNameDraft, setGroupNameDraft] = useState('');
  const [groupDescriptionDraft, setGroupDescriptionDraft] = useState('');
  const [addMembersSelection, setAddMembersSelection] = useState([]);

  // ---- In-chat search ----
  const [chatSearchOpen, setChatSearchOpen] = useState(false);
  const [chatSearchQuery, setChatSearchQuery] = useState('');

  // ---- Voice recording ----
  const [isRecording, setIsRecording] = useState(false);
  const [recordSeconds, setRecordSeconds] = useState(0);

  // ---- Message actions ----
  const [messageMenuId, setMessageMenuId] = useState(null);
  const [reactionPickerMessageId, setReactionPickerMessageId] = useState(null);
  const [editingMessageId, setEditingMessageId] = useState(null);
  const [editingMessageText, setEditingMessageText] = useState('');

  // ---- Poll creation ----
  const [showPollModal, setShowPollModal] = useState(false);
  const [pollQuestion, setPollQuestion] = useState('');
  const [pollOptions, setPollOptions] = useState(['', '']);
  const [pollAllowMultiple, setPollAllowMultiple] = useState(false);

  // ---- Contact bubble menu ----
  const [contactMenuMsgId, setContactMenuMsgId] = useState(null);

  // ---- Calls panel menu ----
  const [showCallsMenu, setShowCallsMenu] = useState(false);
  const [showCallSettings, setShowCallSettings] = useState(false);
  const [scheduledCalls, setScheduledCalls] = useState([]);

  // ---- Refs ----
  const socketRef = useRef(null);
  const selectedRef = useRef(null);
  const contactsRef = useRef([]);
  const groupsRef = useRef([]);
  const localVideoRef = useRef(null);
  const remoteVideoRef = useRef(null);
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
  const localGroupVideoRef = useRef(null);
  const editInputRef = useRef(null);
  const searchDebounceRef = useRef(null);
  const navigate = useNavigate();

  const logout = useCallback(() => {
    localStorage.removeItem('chatToken');
    localStorage.removeItem('chatUser');
    navigate('/login');
  }, [navigate]);

  const loadCallHistory = useCallback(async () => {
    try {
      const result = await api.get('/api/calls', authorization);
      setCallHistory(result.data);
    } catch (e) { console.error('Could not load call history', e); }
  }, [authorization]);

  // ---- WebRTC hooks ----
  const directCall = useDirectCall(socketInstance, user, { onCallFinished: loadCallHistory });
  const groupCallHook = useGroupCall(socketInstance, user, {
    onCallFinished: loadCallHistory,
    onError: (msg) => setError(msg),
  });

  useEffect(() => { setIncomingCall(directCall.incomingCall); }, [directCall.incomingCall]);
  useEffect(() => {
    setActiveCall(directCall.activeCall);
    if (directCall.activeCall) {
      // start duration timer
      setCallDuration(0);
      setSwitchedToVideo(false);
      setCallMinimized(false);
      callTimerRef.current = setInterval(() => setCallDuration((s) => s + 1), 1000);
    } else {
      clearInterval(callTimerRef.current);
      callTimerRef.current = null;
      setCallDuration(0);
      setCallMinimized(false);
      setSwitchedToVideo(false);
    }
    return () => clearInterval(callTimerRef.current);
  }, [directCall.activeCall]);
  useEffect(() => { setLocalStream(directCall.localStream); }, [directCall.localStream]);
  useEffect(() => { setIsMicMuted(directCall.isMicMuted); }, [directCall.isMicMuted]);
  useEffect(() => { setIsCameraOff(directCall.isCameraOff); }, [directCall.isCameraOff]);
  useEffect(() => { setRemoteStream(directCall.remoteStream); }, [directCall.remoteStream]);

  useEffect(() => { setGroupCallInvite(groupCallHook.groupCallInvite); }, [groupCallHook.groupCallInvite]);
  useEffect(() => { setGroupCall(groupCallHook.groupCall); }, [groupCallHook.groupCall]);
  useEffect(() => { setGroupCallParticipants(groupCallHook.groupCallParticipants); }, [groupCallHook.groupCallParticipants]);
  useEffect(() => { setLocalGroupStream(groupCallHook.localGroupStream); }, [groupCallHook.localGroupStream]);
  useEffect(() => { setIsGroupMicMuted(groupCallHook.isGroupMicMuted); }, [groupCallHook.isGroupMicMuted]);
  useEffect(() => { setIsGroupCameraOff(groupCallHook.isGroupCameraOff); }, [groupCallHook.isGroupCameraOff]);

  useEffect(() => { selectedRef.current = selected; }, [selected]);
  useEffect(() => { contactsRef.current = contacts; }, [contacts]);
  useEffect(() => { groupsRef.current = groups; }, [groups]);
  useEffect(() => { if (localVideoRef.current) localVideoRef.current.srcObject = localStream; }, [localStream]);
  useEffect(() => { if (localGroupVideoRef.current) localGroupVideoRef.current.srcObject = localGroupStream; }, [localGroupStream]);
  useEffect(() => { if (remoteVideoRef.current) remoteVideoRef.current.srcObject = remoteStream; }, [remoteStream]);
  useEffect(() => {
    if (chatScrollRef.current) chatScrollRef.current.scrollTop = chatScrollRef.current.scrollHeight;
  }, [messages, selected]);
  useEffect(() => {
    if (!notice) return;
    const t = setTimeout(() => setNotice(''), 2500);
    return () => clearTimeout(t);
  }, [notice]);

  const closeCall = useCallback((notify = true) => { directCall.closeCall(notify); }, [directCall]);
  const toggleMic = () => directCall.toggleMic();
  const toggleCamera = () => directCall.toggleCamera();

  // ---- Global click-outside handler ----
  // Closes any open popover/dropdown/panel when the user clicks
  // anywhere outside the relevant UI element.
  useEffect(() => {
    const handleGlobalClick = (e) => {
      const t = e.target;
      // These are containers — clicks inside them should NOT close anything
      if (
        t.closest('.ww-popover') ||
        t.closest('.ww-chat-menu-dropdown') ||
        t.closest('.ww-attach-sheet') ||
        t.closest('.ww-forward-sheet') ||
        t.closest('.ww-theme-sheet') ||
        t.closest('.ww-emoji-picker') ||
        t.closest('.ww-global-search-results') ||
        t.closest('.ww-msg-menu') ||
        t.closest('.ww-reaction-picker') ||
        t.closest('.ww-three-dot-popup') ||
        t.closest('.ww-list-panel') ||
        t.closest('.ww-info-panel') ||
        t.closest('.ww-call-modal') ||
        t.closest('[data-popover-trigger]')
      ) return;

      // Clicking in the conversation area → close sidebar popovers + calls panel
      setActivePopover(null);
      setShowEmojiPicker(false);
      setMessageMenuId(null);
      setReactionPickerMessageId(null);
      setContactMenuMsgId(null);
      setShowCallsMenu(false);
      setShowCallsPanel(false);
    };

    document.addEventListener('mousedown', handleGlobalClick, true);
    return () => document.removeEventListener('mousedown', handleGlobalClick, true);
  }, []);
  const toggleGroupMic = () => groupCallHook.toggleGroupMic();
  const toggleGroupCamera = () => groupCallHook.toggleGroupCamera();
  const declineCall = useCallback(() => { directCall.declineCall(); }, [directCall]);
  const handleAppLockClick = () => { setAppLockModal(appLockEnabled ? 'disable' : 'setup'); };
  const toggleTheme = () => setIsDarkMode((prev) => !prev);

  // ---- Main data load + socket setup ----
  useEffect(() => {
    const loadData = async () => {
      try {
        const [friendRes, convRes, groupRes, pinnedRes] = await Promise.all([
          api.get('/api/friends', authorization),
          api.get('/api/conversations', authorization),
          api.get('/api/groups', authorization),
          api.get('/api/pinned-chats', authorization),
        ]);
        setContacts(friendRes.data);
        
        // E2EE integration point — decrypt lastMessage previews for conversations
        const decryptedConvs = await Promise.all(
          convRes.data.map(async (conv) => {
            if (conv.lastMessage) {
              try {
                const decrypted = await decryptMessage(
                  { type: 'direct', myUserId: user.id, theirUserId: conv.id, token },
                  conv.lastMessage,
                );
                return { ...conv, lastMessage: decrypted };
              } catch { return conv; }
            }
            return conv;
          }),
        );
        setConversations(decryptedConvs);
        
        // E2EE integration point — decrypt lastMessage previews for groups
        const decryptedGroups = await Promise.all(
          groupRes.data.map(async (grp) => {
            if (grp.lastMessage) {
              try {
                const decrypted = await decryptMessage(
                  { type: 'group', myUserId: user.id, groupId: grp.id, token },
                  grp.lastMessage,
                );
                return { ...grp, lastMessage: decrypted };
              } catch { return grp; }
            }
            return grp;
          }),
        );
        setGroups(decryptedGroups);

        // Seed initial unread counts from server — covers messages already in DB before app opened
        const initialUnread = {};
        convRes.data.forEach((conv) => { if (conv.unreadCount > 0) initialUnread[conv.id] = conv.unreadCount; });
        groupRes.data.forEach((grp)  => { if (grp.unreadCount  > 0) initialUnread[grp.id]  = grp.unreadCount;  });
        setUnreadCounts(initialUnread);
        
        setPinnedChatKeys(pinnedRes.data.pinnedChats || []);
        setLastSeenMap(Object.fromEntries(friendRes.data.filter((f) => f.lastSeen).map((f) => [f.id, f.lastSeen])));
      } catch (e) { setError(e.response?.data?.message || 'Could not load chats.'); }
      loadCallHistory();
    };
    loadData();

    const socket = io(API_URL, { auth: { token }, transports: ['websocket', 'polling'], reconnection: true });
    socketRef.current = socket;
    setSocketInstance(socket);

    socket.on('connect_error', (err) => { console.error('[socket] connect_error', err); logout(); });

    socket.on('msg', async (item) => {
      const contactId = item.senderId === user.id ? item.recipientId : item.senderId;
      // E2EE integration point — decrypt text payload before rendering
      if (item.type === 'text' && item.msg) {
        try {
          item = { ...item, msg: await decryptMessage({ type: 'direct', myUserId: user.id, theirUserId: contactId, token }, item.msg) };
        } catch { /* leave msg as-is — decryptMessage already returns DECRYPT_FALLBACK internally */ }
      }
      const contact = contactsRef.current.find((e) => e.id === contactId);
      if (contact) setConversations((prev) => [{ ...contact, lastMessage: previewFor(item), timeStamp: item.timeStamp }, ...prev.filter((e) => e.id !== contactId)]);
      if (selectedRef.current?.type === 'direct' && selectedRef.current.data.id === contactId) {
        setMessages((prev) => mergeMessages(prev, [item]));
        if (item.senderId !== user.id) socketRef.current?.emit('mark-read', { contactId });
      } else if (item.senderId !== user.id) {
        // Chat is not open — increment unread badge for this contact
        setUnreadCounts((prev) => ({ ...prev, [contactId]: (prev[contactId] || 0) + 1 }));
      }
      setTypingMap((prev) => ({ ...prev, [contactId]: false }));    });

    socket.on('group-msg', async (item) => {
      // E2EE integration point — decrypt text payload before rendering
      if (item.type === 'text' && item.msg) {
        try {
          item = { ...item, msg: await decryptMessage({ type: 'group', myUserId: user.id, groupId: item.groupId, token }, item.msg) };
        } catch { /* leave msg as-is */ }
      }
      const group = groupsRef.current.find((e) => e.id === item.groupId);
      if (group) setGroups((prev) => [{ ...group, lastMessage: previewFor(item), timeStamp: item.timeStamp }, ...prev.filter((e) => e.id !== item.groupId)]);
      if (selectedRef.current?.type === 'group' && selectedRef.current.data.id === item.groupId) setMessages((prev) => mergeMessages(prev, [item]));
      else if (item.senderId !== user.id) {
        // Group chat is not open — increment unread badge for this group
        setUnreadCounts((prev) => ({ ...prev, [item.groupId]: (prev[item.groupId] || 0) + 1 }));
      }
      setTypingMap((prev) => {
        const cur = new Set(prev[item.groupId] || []);
        cur.delete(item.username);
        return { ...prev, [item.groupId]: cur };
      });
    });

    socket.on('msg-deleted', ({ messageId, everyone }) => {
      setMessages((prev) => {
        if (everyone) return prev.map((m) => m.id === messageId ? { ...m, deletedForEveryone: true, msg: '', audioData: undefined, fileData: undefined } : m);
        return prev.filter((m) => m.id !== messageId);
      });
    });

    socket.on('messages-read', ({ by }) => {
      setMessages((prev) => prev.map((m) => m.senderId === user.id && m.recipientId === by ? { ...m, read: true } : m));
    });

    socket.on('call-history-updated', () => loadCallHistory());

    socket.on('group-updated', (updatedGroup) => {
      setGroups((prev) => {
        const exists = prev.some((g) => g.id === updatedGroup.id);
        if (!exists) return [{ ...updatedGroup, lastMessage: '', timeStamp: updatedGroup.createdAt }, ...prev];
        return prev.map((g) => g.id === updatedGroup.id ? { ...g, ...updatedGroup } : g);
      });
      setSelected((prev) => prev?.type === 'group' && prev.data.id === updatedGroup.id ? { ...prev, data: { ...prev.data, ...updatedGroup } } : prev);
    });

    socket.on('presence-bulk', ({ onlineUserIds: ids }) => setOnlineUserIds(new Set(ids)));
    socket.on('presence', ({ userId: id, online, lastSeen }) => {
      setOnlineUserIds((prev) => { const n = new Set(prev); online ? n.add(id) : n.delete(id); return n; });
      if (!online) setLastSeenMap((prev) => ({ ...prev, [id]: lastSeen }));
    });

    socket.on('typing', ({ userId: fromId, username: fromUsername, groupId, isTyping }) => {
      if (groupId) {
        setTypingMap((prev) => {
          const cur = new Set(prev[groupId] || []);
          isTyping ? cur.add(fromUsername) : cur.delete(fromUsername);
          return { ...prev, [groupId]: cur };
        });
      } else {
        setTypingMap((prev) => ({ ...prev, [fromId]: isTyping }));
      }
    });

    // ---- New feature socket listeners ----
    socket.on('message-reaction', ({ messageId, reactions }) => {
      setMessages((prev) => prev.map((m) => m.id === messageId ? { ...m, reactions } : m));
    });
    socket.on('message-edited', ({ messageId, newText, editedAt }) => {
      setMessages((prev) => prev.map((m) => m.id === messageId ? { ...m, msg: newText, editedAt } : m));
    });
    socket.on('message-pinned', ({ messageId, isPinned }) => {
      setMessages((prev) => prev.map((m) => m.id === messageId ? { ...m, isPinned } : m));
    });
    socket.on('message-starred', ({ messageId, starredBy }) => {
      setMessages((prev) => prev.map((m) => m.id === messageId ? { ...m, starredBy } : m));
    });

    // Poll vote/close updates
    socket.on('poll-updated', ({ messageId, poll }) => {
      setMessages((prev) => prev.map((m) => m.id === messageId ? { ...m, poll } : m));
    });

    return () => { socket.disconnect(); };
  }, [authorization, loadCallHistory, logout, token, user.id]);

  // ---- Call helpers ----
  const startGroupCall = (targetUserIds, groupId = null) => { groupCallHook.startGroupCall(targetUserIds, groupId); setActivePopover(null); };
  const acceptGroupCallInvite = () => groupCallHook.acceptGroupCallInvite();
  const declineGroupCallInvite = () => groupCallHook.declineGroupCallInvite();
  const leaveGroupCall = () => groupCallHook.leaveGroupCall();

  const openCallPicker = (candidateContacts, groupId = null) => {
    setCallPickerContacts(candidateContacts);
    setCallPickerGroupId(groupId);
    setCallPickerSelection(groupId && candidateContacts.length <= MAX_GROUP_CALL_PARTICIPANTS - 1 ? candidateContacts.map((c) => c.id) : []);
    setActivePopover('groupCallPicker');
  };

  const toggleCallPick = (id) => {
    setCallPickerSelection((prev) => {
      if (prev.includes(id)) return prev.filter((i) => i !== id);
      if (prev.length >= MAX_GROUP_CALL_PARTICIPANTS - 1) return prev;
      return [...prev, id];
    });
  };

  const startCall = async (contactOverride, audioOnly = false) => {
    const target = contactOverride || (selected?.type === 'direct' ? selected.data : null);
    if (!target || isBlocked) return;
    try { await directCall.startCall(target, audioOnly); }
    catch (e) { setError(e?.message || 'Microphone/camera access is required.'); directCall.closeCall(false); }
  };

  const startAudioCall = (contactOverride) => startCall(contactOverride, true);

  // Escalate a voice call to video mid-call
  const escalateToVideo = async () => {
    if (switchedToVideo) return;
    try {
      const videoStream = await navigator.mediaDevices.getUserMedia({ video: true, audio: false });
      const videoTrack = videoStream.getVideoTracks()[0];
      const peer = directCall.peerConnectionRef?.current;
      if (peer) {
        const sender = peer.getSenders().find((s) => s.track?.kind === 'video');
        if (sender) await sender.replaceTrack(videoTrack);
        else peer.addTrack(videoTrack, localStream);
      }
      // Merge video track into local stream display
      if (localVideoRef.current) {
        const merged = new MediaStream([...localStream.getTracks(), videoTrack]);
        localVideoRef.current.srcObject = merged;
      }
      setSwitchedToVideo(true);
    } catch { setError('Could not access camera to switch to video.'); }
  };

  const acceptCall = async () => {
    try { await directCall.acceptCall(); }
    catch (e) { setError(e?.message || 'Camera or microphone access is required.'); directCall.closeCall(true); }
  };

  // ---- Chat selection ----
  const selectChat = async (type, data) => {
    clearTimeout(typingTimeoutRef.current);
    emitTyping(false);
    setSelected({ type, data });
    setMessages([]);
    // Clear unread badge for the chat being opened
    setUnreadCounts((prev) => {
      if (!prev[data.id]) return prev;
      const next = { ...prev };
      delete next[data.id];
      return next;
    });
    setError('');
    setActivePopover(null);
    setShowCallsPanel(false);
    setChatSearchOpen(false);
    setChatSearchQuery('');
    setShowEmojiPicker(false);
    setReactionPickerMessageId(null);
    setEditingMessageId(null);
    if (infoPanel === 'self') setInfoPanel(null);
    try {
      const url = type === 'group' ? `/api/groups/${data.id}/messages` : `/api/messages/${data.id}`;
      const result = await api.get(url, authorization);
      // E2EE integration point — decrypt all text messages loaded from the server
      const decrypted = await Promise.all(
        result.data.map(async (item) => {
          if (item.type !== 'text' || !item.msg) return item;
          try {
            const ctx = type === 'group'
              ? { type: 'group',  myUserId: user.id, groupId: data.id, token }
              : { type: 'direct', myUserId: user.id, theirUserId: data.id, token };
            return { ...item, msg: await decryptMessage(ctx, item.msg) };
          } catch { return item; }
        }),
      );
      setMessages((prev) => mergeMessages(decrypted, prev));
      if (type === 'group') {
        socketRef.current?.emit('join-group', { groupId: data.id });
        // Mark group as read so the unread count resets on next load
        api.post(`/api/groups/${data.id}/read`, {}, authorization).catch(() => {});
      }
      if (type === 'direct') socketRef.current?.emit('mark-read', { contactId: data.id });
    } catch (e) { setError(e.response?.data?.message || 'Could not load this conversation.'); }
  };

  const emitTyping = (isTyping) => {
    if (!selected) return;
    const payload = selected.type === 'group' ? { groupId: selected.data.id, isTyping } : { recipientId: selected.data.id, isTyping };
    socketRef.current?.emit('typing', payload);
  };

  const handleMessageChange = (event) => {
    setMessage(event.target.value);
    if (!selected) return;
    emitTyping(true);
    clearTimeout(typingTimeoutRef.current);
    typingTimeoutRef.current = setTimeout(() => emitTyping(false), 2000);
  };

  const sendMessage = async (event) => {
    event.preventDefault();
    if (!selected || !message.trim() || isBlocked) return;
    clearTimeout(typingTimeoutRef.current);
    emitTyping(false);
    // E2EE integration point — encrypt plaintext before it leaves the browser
    const encCtx = {
      type:        selected.type,
      myUserId:    user.id,
      theirUserId: selected.type === 'direct' ? selected.data.id : undefined,
      groupId:     selected.type === 'group'  ? selected.data.id : undefined,
      token,
    };
    let encryptedContent;
    try {
      encryptedContent = await encryptMessage(encCtx, message);
    } catch (encErr) {
      // If it's a group and the key is missing, getOrFetchGroupKey will have
      // attempted self-healing (generateAndDistributeGroupKey). Retry once.
      if (encCtx.type === 'group') {
        try {
          encryptedContent = await encryptMessage(encCtx, message);
        } catch {
          setError('Could not encrypt message — group keys are being set up. Please try again in a moment.');
          return;
        }
      } else {
        setError('Could not encrypt message — your keys may not be ready. Please refresh and try again.');
        return; // block send — never emit plaintext
      }
    }
    if (selected.type === 'group') socketRef.current?.emit('group-msg', { groupId: selected.data.id, message: encryptedContent });
    else socketRef.current?.emit('msg', { recipientId: selected.data.id, message: encryptedContent });
    setMessage('');
  };

  const insertEmoji = (emoji) => {
    setMessage((prev) => prev + emoji);
    if (!selected) return;
    emitTyping(true);
    clearTimeout(typingTimeoutRef.current);
    typingTimeoutRef.current = setTimeout(() => emitTyping(false), 2000);
  };

  // ---- Voice recording ----
  const startRecording = async () => {
    if (!selected || isBlocked) return;
    try {
      const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
      const recorder = new MediaRecorder(stream);
      audioChunksRef.current = [];
      recorder.ondataavailable = (e) => { if (e.data.size > 0) audioChunksRef.current.push(e.data); };
      recorder.onstop = async () => {
        stream.getTracks().forEach((t) => t.stop());
        const blob = new Blob(audioChunksRef.current, { type: 'audio/webm' });
        try {
          const file = new File([blob], `voice_${Date.now()}.webm`, { type: 'audio/webm' });
          const { url } = await uploadToCloudinary(file);
          if (selected.type === 'group') socketRef.current?.emit('group-msg', { groupId: selected.data.id, type: 'audio', audioData: url });
          else socketRef.current?.emit('msg', { recipientId: selected.data.id, type: 'audio', audioData: url });
        } catch (e) {
          setError(e?.response?.data?.message || 'Could not upload voice message.');
        }
      };
      recorder.start();
      mediaRecorderRef.current = recorder;
      setIsRecording(true);
      setRecordSeconds(0);
      recordTimerRef.current = setInterval(() => setRecordSeconds((s) => s + 1), 1000);
    } catch { setError('Microphone access is required to record a voice message.'); }
  };

  const stopRecording = () => {
    mediaRecorderRef.current?.stop();
    mediaRecorderRef.current = null;
    clearInterval(recordTimerRef.current);
    setIsRecording(false);
  };

  // ---- Camera capture (live camera → canvas snapshot) ----
  const [showCameraModal, setShowCameraModal] = useState(false);
  const cameraStreamRef = useRef(null);
  const cameraVideoRef = useRef(null);

  const openCamera = async () => {
    if (!selected || isBlocked) return;
    try {
      const stream = await navigator.mediaDevices.getUserMedia({ video: { facingMode: 'environment' }, audio: false });
      cameraStreamRef.current = stream;
      setShowCameraModal(true);
      // Attach stream to video element after modal renders
      setTimeout(() => {
        if (cameraVideoRef.current) cameraVideoRef.current.srcObject = stream;
      }, 50);
    } catch { setError('Could not access camera. Please allow camera permission.'); }
  };

  const capturePhoto = async () => {
    const video = cameraVideoRef.current;
    if (!video) return;
    const canvas = document.createElement('canvas');
    canvas.width = video.videoWidth;
    canvas.height = video.videoHeight;
    canvas.getContext('2d').drawImage(video, 0, 0);
    canvas.toBlob(async (blob) => {
      try {
        const file = new File([blob], `photo_${Date.now()}.jpg`, { type: 'image/jpeg' });
        const { url } = await uploadToCloudinary(file);
        sendAttachment({ type: 'image', fileData: url, fileName: file.name, fileMime: 'image/jpeg' });
        closeCamera();
      } catch (e) {
        setError(e?.response?.data?.message || 'Could not upload photo.');
      }
    }, 'image/jpeg', 0.85);
  };

  const closeCamera = () => {
    cameraStreamRef.current?.getTracks().forEach((t) => t.stop());
    cameraStreamRef.current = null;
    setShowCameraModal(false);
  };

  const handleMicClick = () => { isRecording ? stopRecording() : startRecording(); };

  // ---- Attachments ----
  // Uploads a File object to Cloudinary via the server, then sends the
  // resulting URL (never raw base64) over the socket.
  const uploadToCloudinary = async (file) => {
    const form = new FormData();
    form.append('file', file);
    const res = await api.post('/api/upload', form, {
      ...authorization,
      headers: { ...authorization?.headers, 'Content-Type': 'multipart/form-data' },
    });
    return res.data; // { url, resourceType, originalName, mimeType }
  };

  const sendAttachment = (payload) => {
    if (!selected) return;
    if (selected.type === 'group') socketRef.current?.emit('group-msg', { groupId: selected.data.id, ...payload });
    else socketRef.current?.emit('msg', { recipientId: selected.data.id, ...payload });
  };

  const sendFile = async (file, type) => {
    if (!file || !selected || isBlocked) return;
    if (file.size > MAX_ATTACHMENT_BYTES) { setError('File too large (max 20MB).'); return; }
    try {
      const { url, mimeType } = await uploadToCloudinary(file);
      sendAttachment({ type, fileData: url, fileName: file.name, fileMime: mimeType || file.type });
    } catch (e) {
      setError(e?.response?.data?.message || 'Upload failed. Check Cloudinary credentials.');
    }
  };

  const handleGallerySelect = (e) => { const f = e.target.files?.[0]; e.target.value = ''; setActivePopover(null); if (f) sendFile(f, 'image'); };
  const handleDocumentSelect = (e) => { const f = e.target.files?.[0]; e.target.value = ''; setActivePopover(null); if (f) sendFile(f, 'file'); };
  const handleAudioFileSelect = (e) => { const f = e.target.files?.[0]; e.target.value = ''; setActivePopover(null); if (f) sendFile(f, 'file'); };
  const handleCameraCapture = (e) => { const f = e.target.files?.[0]; e.target.value = ''; setActivePopover(null); if (f) sendFile(f, 'image'); };

  const shareLocation = () => {
    if (!selected || isBlocked) return;
    if (!navigator.geolocation) { setError('Location not available.'); return; }
    navigator.geolocation.getCurrentPosition(
      (pos) => { sendAttachment({ type: 'location', location: { lat: pos.coords.latitude, lng: pos.coords.longitude } }); setActivePopover(null); },
      () => { setError('Could not get your location.'); setActivePopover(null); },
    );
  };

  const shareContact = (contact) => {
    if (!selected || isBlocked) return;
    sendAttachment({ type: 'contact', contactShare: { id: contact.id, username: contact.username } });
    setActivePopover(null);
  };

  // ---- Contact bubble actions ----
  const addSharedContact = async (contactShare) => {
    if (!contactShare?.id) return;
    try {
      const res = await api.post('/api/friends', { query: contactShare.username || contactShare.id }, authorization);
      setContacts((prev) => [...prev, res.data.friend]);
      setNotice(`${contactShare.name || contactShare.username} added to contacts`);
    } catch (e) { setError(e.response?.data?.message || 'Could not add contact.'); }
    setContactMenuMsgId(null);
  };

  const callSharedContact = (contactShare) => {
    const target = contacts.find((c) => c.id === contactShare?.id);
    if (target) { startAudioCall(target); }
    else setError('Add this contact first before calling.');
    setContactMenuMsgId(null);
  };

  // ---- Message actions ----
  const deleteMessage = (item, everyone) => {
    socketRef.current?.emit('delete-message', { messageId: item.id, isGroup: selected?.type === 'group', everyone });
    setMessageMenuId(null);
    if (!everyone) setMessages((prev) => prev.filter((m) => m.id !== item.id));
  };

  const openForward = (item) => { setForwardingMessage(item); setMessageMenuId(null); };

  const forwardTo = (targetType, data) => {
    if (!forwardingMessage) return;
    const base = { message: forwardingMessage.msg, type: forwardingMessage.type };
    if (forwardingMessage.type === 'audio') base.audioData = forwardingMessage.audioData;
    if (forwardingMessage.type === 'image' || forwardingMessage.type === 'file') { base.fileData = forwardingMessage.fileData; base.fileName = forwardingMessage.fileName; base.fileMime = forwardingMessage.fileMime; }
    if (forwardingMessage.type === 'location') base.location = forwardingMessage.location;
    if (forwardingMessage.type === 'contact') base.contactShare = forwardingMessage.contactShare;
    if (targetType === 'group') socketRef.current?.emit('group-msg', { groupId: data.id, ...base });
    else socketRef.current?.emit('msg', { recipientId: data.id, ...base });
    setForwardingMessage(null);
    setNotice('Message forwarded');
  };

  // ---- Reactions ----
  const reactToMessage = async (item, emoji) => {
    setReactionPickerMessageId(null);
    try {
      const isGroup = selected?.type === 'group';
      const url = isGroup ? `/api/groups/${selected.data.id}/messages/${item.id}/react` : `/api/messages/${item.id}/react`;
      await api.post(url, { emoji }, authorization);
    } catch (e) { setError(e.response?.data?.message || 'Could not add reaction.'); }
  };

  // ---- Edit message ----
  const startEditMessage = (item) => {
    setEditingMessageId(item.id); setEditingMessageText(item.msg); setMessageMenuId(null);
    setTimeout(() => editInputRef.current?.focus(), 50);
  };

  const submitEditMessage = async (item) => {
    if (!editingMessageText.trim()) return;
    try {
      const isGroup = selected?.type === 'group';
      const url = isGroup ? `/api/groups/${selected.data.id}/messages/${item.id}` : `/api/messages/${item.id}`;
      await api.patch(url, { newText: editingMessageText.trim() }, authorization);
      setEditingMessageId(null); setEditingMessageText('');
    } catch (e) { setError(e.response?.data?.message || 'Could not edit message.'); setEditingMessageId(null); }
  };

  // ---- Pin message ----
  const pinMessage = async (item, pin) => {
    setMessageMenuId(null);
    try {
      const isGroup = selected?.type === 'group';
      const url = isGroup ? `/api/groups/${selected.data.id}/messages/${item.id}/pin` : `/api/messages/${item.id}/pin`;
      await api.patch(url, { pin }, authorization);
    } catch (e) { setError(e.response?.data?.message || 'Could not pin message.'); }
  };

  // ---- Star message ----
  const toggleStar = async (item) => {
    setMessageMenuId(null);
    try {
      const isGroup = selected?.type === 'group';
      const alreadyStarred = (item.starredBy || []).includes(user.id);
      const url = isGroup ? `/api/groups/${selected.data.id}/messages/${item.id}/star` : `/api/messages/${item.id}/star`;
      await api.post(url, { star: !alreadyStarred }, authorization);
    } catch (e) { setError(e.response?.data?.message || 'Could not star message.'); }
  };

  // ---- Poll helpers ----
  const openPollModal = () => {
    setPollQuestion('');
    setPollOptions(['', '']);
    setPollAllowMultiple(false);
    setShowPollModal(true);
    setActivePopover(null);
  };

  const addPollOption = () => {
    if (pollOptions.length >= 10) return;
    setPollOptions((prev) => [...prev, '']);
  };

  const removePollOption = (idx) => {
    if (pollOptions.length <= 2) return;
    setPollOptions((prev) => prev.filter((_, i) => i !== idx));
  };

  const updatePollOption = (idx, val) => {
    setPollOptions((prev) => prev.map((o, i) => i === idx ? val : o));
  };

  const sendPoll = () => {
    if (!selected || !pollQuestion.trim()) return;
    const validOptions = pollOptions.map((o) => o.trim()).filter(Boolean);
    if (validOptions.length < 2) { setError('Add at least 2 options.'); return; }
    const event = selected.type === 'group' ? 'send-group-poll' : 'send-poll';
    const payload = selected.type === 'group'
      ? { groupId: selected.data.id, question: pollQuestion.trim(), options: validOptions, allowMultiple: pollAllowMultiple }
      : { recipientId: selected.data.id, question: pollQuestion.trim(), options: validOptions, allowMultiple: pollAllowMultiple };
    socketRef.current?.emit(event, payload);
    setShowPollModal(false);
  };

  const votePoll = (messageId, optionId) => {
    const isGroup = selected?.type === 'group';
    socketRef.current?.emit('poll-vote', { messageId, optionId, isGroup });
  };

  const closePoll = (messageId) => {
    const isGroup = selected?.type === 'group';
    socketRef.current?.emit('poll-close', { messageId, isGroup });
  };

  // ---- Pin chat to sidebar ----
  const togglePinChat = async (type, id) => {
    const key = chatKeyFor(type, id);
    try {
      if (pinnedChatKeys.includes(key)) {
        const res = await api.delete('/api/pinned-chats', { ...authorization, data: { key } });
        setPinnedChatKeys(res.data.pinnedChats || []);
      } else {
        const res = await api.post('/api/pinned-chats', { key }, authorization);
        setPinnedChatKeys(res.data.pinnedChats || []);
      }
    } catch (e) { setError(e.response?.data?.message || 'Could not update pinned chats.'); }
  };

  // ---- Global search ----
  const runGlobalSearch = useCallback(async (q) => {
    if (!q || q.trim().length < 2) { setGlobalSearchResults(null); return; }
    try {
      const res = await api.get(`/api/search?q=${encodeURIComponent(q.trim())}`, authorization);
      setGlobalSearchResults(res.data);
    } catch { setGlobalSearchResults(null); }
  }, [authorization]);

  const handleSearchChange = (event) => {
    const val = event.target.value;
    setSearchQuery(val);
    clearTimeout(searchDebounceRef.current);
    if (!val.trim()) { setGlobalSearchResults(null); return; }
    searchDebounceRef.current = setTimeout(() => runGlobalSearch(val), 400);
  };

  // ---- Block / unblock ----
  const toggleBlock = async (contact) => {
    try {
      const endpoint = contact.blockedByMe ? 'unblock' : 'block';
      const res = await api.post(`/api/friends/${contact.id}/${endpoint}`, {}, authorization);
      setContacts((prev) => prev.map((c) => c.id === contact.id ? { ...c, blockedByMe: res.data.blockedByMe } : c));
      setNotice(res.data.blockedByMe ? `Blocked @${contact.username}` : `Unblocked @${contact.username}`);
    } catch (e) { setError(e.response?.data?.message || 'Could not update block status.'); }
  };

  // ---- Per-chat settings ----
  const currentChatKey = selected ? chatKeyFor(selected.type, selected.data.id) : null;
  const currentSettings = (currentChatKey && chatSettings[currentChatKey]) || {};
  const isMuted = !!currentSettings.muted;
  const isMediaVisible = currentSettings.mediaVisibility ?? true;
  const isDisappearing = !!currentSettings.disappearing;
  const isChatLocked = !!currentSettings.locked;
  const isFavourite = !!currentSettings.favourite;

  const updateChatSetting = (chatKey, patch) => {
    if (!chatKey) return;
    setChatSettings((prev) => ({ ...prev, [chatKey]: { ...prev[chatKey], ...patch } }));
  };

  // ---- Group edit ----
  const applyGroupUpdate = (updatedGroup) => {
    setGroups((prev) => prev.map((g) => g.id === updatedGroup.id ? { ...g, ...updatedGroup } : g));
    setSelected((prev) => prev?.type === 'group' && prev.data.id === updatedGroup.id ? { ...prev, data: { ...prev.data, ...updatedGroup } } : prev);
  };

  const saveGroupName = async (event) => {
    event.preventDefault();
    if (!selected || selected.type !== 'group' || !groupNameDraft.trim()) return;
    try { const res = await api.patch(`/api/groups/${selected.data.id}`, { name: groupNameDraft.trim() }, authorization); applyGroupUpdate(res.data); setEditingGroupField(null); }
    catch (e) { setError(e.response?.data?.message || 'Could not rename group.'); }
  };

  const saveGroupDescription = async (event) => {
    event.preventDefault();
    if (!selected || selected.type !== 'group') return;
    try { const res = await api.patch(`/api/groups/${selected.data.id}`, { description: groupDescriptionDraft.trim() }, authorization); applyGroupUpdate(res.data); setEditingGroupField(null); }
    catch (e) { setError(e.response?.data?.message || 'Could not update description.'); }
  };

  const toggleAddMember = (id) => setAddMembersSelection((prev) => prev.includes(id) ? prev.filter((i) => i !== id) : [...prev, id]);

  const submitAddMembers = async () => {
    if (!selected || selected.type !== 'group' || !addMembersSelection.length) return;
    try { const res = await api.post(`/api/groups/${selected.data.id}/members`, { memberIds: addMembersSelection }, authorization); applyGroupUpdate(res.data); setAddMembersSelection([]); setActivePopover(null); setNotice('Members added'); }
    catch (e) { setError(e.response?.data?.message || 'Could not add members.'); }
  };

  const exitGroup = async () => {
    if (!selected || selected.type !== 'group') return;
    try { await api.post(`/api/groups/${selected.data.id}/leave`, {}, authorization); setGroups((prev) => prev.filter((g) => g.id !== selected.data.id)); setSelected(null); setInfoPanel(null); setActivePopover(null); setNotice('You left the group'); }
    catch (e) { setError(e.response?.data?.message || 'Could not leave the group.'); }
  };

  // ---- App lock ----
  const hashPin = async (pin) => {
    const buffer = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(pin));
    return Array.from(new Uint8Array(buffer)).map((b) => b.toString(16).padStart(2, '0')).join('');
  };

  const setupAppLock = async (pin) => { const hash = await hashPin(pin); localStorage.setItem('ww-app-lock-hash', hash); setAppLockEnabled(true); setAppLockModal(null); setPinInput(''); };
  const disableAppLock = async (pin) => { const hash = await hashPin(pin); if (hash !== localStorage.getItem('ww-app-lock-hash')) { setPinError('Wrong PIN'); return; } localStorage.removeItem('ww-app-lock-hash'); setAppLockEnabled(false); setIsLocked(false); setAppLockModal(null); setPinInput(''); };
  const unlockApp = async (pin) => { const hash = await hashPin(pin); if (hash !== localStorage.getItem('ww-app-lock-hash')) { setPinError('Wrong PIN'); return; } setIsLocked(false); setPinInput(''); setPinError(''); };

  // ---- Status handlers ----
  const loadStatuses = async () => {
    if (statusLoaded) return;
    try {
      const res = await api.get('/api/status', authorization);
      const mine = res.data.find((s) => s.isMe);
      const others = res.data.filter((s) => !s.isMe);
      setMyStatus(mine || null);
      setStatusList(others);
      setStatusLoaded(true);
    } catch { /* silent */ }
  };

  const postStatus = async () => {
    if (!newStatusText.trim()) return;
    try {
      const res = await api.post('/api/status', { text: newStatusText.trim(), bgColor: statusBgColor }, authorization);
      setMyStatus((prev) => prev
        ? { ...prev, items: [res.data, ...prev.items] }
        : { userId: user.id, name: user.name, isMe: true, items: [res.data] }
      );
      setNewStatusText('');
      setShowAddStatus(false);
    } catch (e) { setError(e.response?.data?.message || 'Could not post status.'); }
  };

  const deleteStatus = async (statusId) => {
    try {
      await api.delete(`/api/status/${statusId}`, authorization);
      setMyStatus((prev) => {
        if (!prev) return null;
        const items = prev.items.filter((s) => s.id !== statusId);
        return items.length ? { ...prev, items } : null;
      });
    } catch (e) { setError('Could not delete status.'); }
  };

  const viewStatus = async (userEntry, index = 0) => {
    setViewingStatus({ ...userEntry, index });
    const item = userEntry.items[index];
    if (item && !item.viewed) {
      try { await api.post(`/api/status/${item.id}/view`, {}, authorization); } catch { /* silent */ }
      setStatusList((prev) => prev.map((s) => s.userId === userEntry.userId
        ? { ...s, items: s.items.map((it) => it.id === item.id ? { ...it, viewed: true } : it) }
        : s
      ));
    }
  };

  const STATUS_BG_COLORS = ['#128C7E', '#075E54', '#25D366', '#34B7F1', '#ECE5DD', '#9C27B0', '#E91E63', '#FF5722'];
  const [statusBgColor, setStatusBgColor] = useState('#128C7E');

  // Reload status when tab becomes active
  useEffect(() => { if (activeTab === 'status') loadStatuses(); }, [activeTab]); // eslint-disable-line

  // ---- Archive ----
  const toggleArchive = (type, id) => {
    const key = chatKeyFor(type, id);
    setArchivedChats((prev) => { const n = { ...prev }; if (n[key]) delete n[key]; else n[key] = true; return n; });
  };

  // ---- Calls panel helpers ----
  const clearCallHistory = async () => {
    try {
      await api.delete('/api/calls', authorization);
      setCallHistory([]);
      setShowCallsMenu(false);
      setNotice('Call history cleared');
    } catch (e) { setError(e.response?.data?.message || 'Could not clear call history.'); }
  };
  const loadStarredMessages = async () => {
    try { const res = await api.get('/api/starred', authorization); setStarredMessages(res.data); }
    catch (e) { setError(e.response?.data?.message || 'Could not load starred messages.'); }
  };
  const openStarredMessages = () => { setShowStarredPanel(true); loadStarredMessages(); };

  // ---- Bulk select ----
  const toggleChatSelected = (key) => setSelectedChatKeys((prev) => { const n = new Set(prev); n.has(key) ? n.delete(key) : n.add(key); return n; });

  const bulkArchiveSelected = () => {
    setArchivedChats((prev) => { const n = { ...prev }; selectedChatKeys.forEach((k) => { n[k] = true; }); return n; });
    setSelectedChatKeys(new Set()); setBulkSelectMode(false);
  };

  const bulkMarkReadSelected = () => {
    selectedChatKeys.forEach((key) => { const [type, id] = key.split(/-(.+)/); if (type === 'direct') socketRef.current?.emit('mark-read', { contactId: id }); });
    setSelectedChatKeys(new Set()); setBulkSelectMode(false); setNotice('Selected chats marked as read');
  };

  // ---- Clear / export ----
  const clearChat = async () => {
    if (!selected) return;
    try {
      if (selected.type === 'group') await api.post(`/api/groups/${selected.data.id}/messages/clear`, {}, authorization);
      else await api.post('/api/messages/clear', { contactId: selected.data.id }, authorization);
      setMessages([]); setActivePopover(null); setNotice('Chat cleared');
    } catch (e) { setError(e.response?.data?.message || 'Could not clear this chat.'); }
  };

  const exportChat = () => {
    if (!selected) return;
    const lines = messages.map((item) => {
      const who = item.senderId === user.id ? 'You' : (selected.type === 'group' ? (item.username || item.name || 'Unknown') : (selected.data.name || selected.data.username));
      const when = new Date(item.timeStamp).toLocaleString();
      let content = item.msg;
      if (item.deletedForEveryone) content = '[deleted]';
      else if (item.type === 'audio') content = '[voice message]';
      else if (item.type === 'image') content = `[image]`;
      else if (item.type === 'file') content = `[file: ${item.fileName || 'document'}]`;
      else if (item.type === 'location') content = '[location]';
      else if (item.type === 'contact') content = `[contact: @${item.contactShare?.username}]`;
      else if (item.type === 'call') content = '[call]';
      return `[${when}] ${who}: ${content}`;
    });
    const label = selected.type === 'group' ? selected.data.name : (selected.data.name || selected.data.username);
    const blob = new Blob([lines.join('\n')], { type: 'text/plain' });
    const url = URL.createObjectURL(blob);
    const link = document.createElement('a');
    link.href = url; link.download = `chat-${label}-${Date.now()}.txt`; link.click();
    URL.revokeObjectURL(url); setActivePopover(null);
  };

  // ---- Misc menu actions ----
  const addShortcut = () => { if (navigator.clipboard) navigator.clipboard.writeText(window.location.href); setNotice('Link copied'); setActivePopover(null); };
  const addToList = () => { setNotice('Added to list'); setActivePopover(null); };
  const reportChat = () => { setNotice(selected?.type === 'group' ? 'Group reported' : 'Contact reported'); setActivePopover(null); };
  const viewMemberChanges = () => setNotice('Member change history coming soon');
  const toggleFavourite = () => updateChatSetting(currentChatKey, { favourite: !isFavourite });

  const shareChat = () => {
    const label = selected?.type === 'group' ? selected.data.name : `@${selected?.data?.username}`;
    const text = `Chat with ${label} on ChatApp`;
    if (navigator.share) navigator.share({ title: 'ChatApp', text }).catch(() => {});
    else if (navigator.clipboard) { navigator.clipboard.writeText(text); setNotice('Copied to clipboard'); }
    setActivePopover(null);
  };

  // ---- Add friend / create group ----
  const addFriend = async (event) => {
    event.preventDefault();
    try {
      const query = friendUsername.trim().replace(/^@/, '');
      const res = await api.post('/api/friends', { query }, authorization);
      setContacts((prev) => [...prev, res.data.friend]); setFriendUsername('');
    } catch (e) { setError(e.response?.data?.message || 'Could not add friend.'); }
  };

  const toggleGroupMember = (id) => setGroupMembers((prev) => prev.includes(id) ? prev.filter((i) => i !== id) : [...prev, id]);

  const createGroup = async (event) => {
    event.preventDefault();
    if (!groupName.trim()) { setError('Enter a group name.'); return; }
    if (!groupMembers.length) { setError('Select at least one friend.'); return; }
    try {
      const res = await api.post('/api/groups', { name: groupName, memberIds: groupMembers }, authorization);
      setGroups((prev) => [res.data, ...prev]); setGroupName(''); setGroupMembers([]); setActivePopover(null);
      socketRef.current?.emit('join-group', { groupId: res.data.id });
      // E2EE integration point — distribute group key to all members immediately after creation
      const allMemberIds = (res.data.members || []).map((m) => m.userId);
      import('../crypto/groupCrypto').then(({ generateAndDistributeGroupKey }) => {
        generateAndDistributeGroupKey(res.data.id, allMemberIds, user.id, token).catch(() => {});
      });
      selectChat('group', res.data);
    } catch (e) { setError(e.response?.data?.message || 'Could not create group.'); }
  };

  // ---- Derived state ----
  const availableContacts = contacts.filter((c) => !conversations.some((conv) => conv.id === c.id));

  // Chat list filtering (local for no-query, server results for query)
  const query = searchQuery.trim().toLowerCase();
  const filteredConversations = globalSearchResults
    ? globalSearchResults.users.map((u) => conversations.find((c) => c.id === u.id) || { id: u.id, username: u.username, lastMessage: '', timeStamp: null })
    : conversations.filter((c) => c.username.toLowerCase().includes(query));
  const filteredGroups = globalSearchResults
    ? globalSearchResults.groups.map((g) => groups.find((gr) => gr.id === g.id) || { id: g.id, name: g.name, members: [], lastMessage: '', timeStamp: null })
    : groups.filter((g) => g.name.toLowerCase().includes(query));

  // Pinned chats float to top
  const sortedConversations = [...filteredConversations].sort((a, b) => {
    const ap = pinnedChatKeys.includes(chatKeyFor('direct', a.id)) ? 1 : 0;
    const bp = pinnedChatKeys.includes(chatKeyFor('direct', b.id)) ? 1 : 0;
    return bp - ap;
  });
  const sortedGroups = [...filteredGroups].sort((a, b) => {
    const ap = pinnedChatKeys.includes(chatKeyFor('group', a.id)) ? 1 : 0;
    const bp = pinnedChatKeys.includes(chatKeyFor('group', b.id)) ? 1 : 0;
    return bp - ap;
  });

  // Total unread counts for the tab badges (like WhatsApp bottom tabs)
  const totalUnreadDirect = conversations.reduce((sum, c) => sum + (unreadCounts[c.id] || 0), 0);
  const totalUnreadGroups = groups.reduce((sum, g) => sum + (unreadCounts[g.id] || 0), 0);

  // Favourite chats section
  const favouriteConversations = conversations.filter((c) => chatSettings[chatKeyFor('direct', c.id)]?.favourite);
  const favouriteGroups = groups.filter((g) => chatSettings[chatKeyFor('group', g.id)]?.favourite);

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

  // Latest pinned message for the strip
  const latestPinnedMessage = useMemo(() => {
    const pinned = messages.filter((m) => m.isPinned && !m.deletedForEveryone);
    return pinned.length ? pinned[pinned.length - 1] : null;
  }, [messages]);

  const scrollToBottom = () => {
    if (chatScrollRef.current) chatScrollRef.current.scrollTo({ top: chatScrollRef.current.scrollHeight, behavior: 'smooth' });
  };

  const isDirectOnline = selected?.type === 'direct' && onlineUserIds.has(selected.data.id);
  const isDirectTyping = selected?.type === 'direct' && Boolean(typingMap[selected.data.id]);
  const directLastSeen = selected?.type === 'direct' ? lastSeenMap[selected.data.id] : null;
  const groupTypingUsers = selected?.type === 'group' ? Array.from(typingMap[selected.data.id] || []) : [];
  const isGroupTyping = groupTypingUsers.length > 0;

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
    const isGroupCall = call.kind === 'group';
    const grp = isGroupCall ? groups.find((g) => g.id === call.groupId) : null;
    const displayName = isGroupCall ? (grp?.name || call.hostUsername || 'Group call') : call.contactUsername;
    const StatusIcon = call.status === 'missed' ? PhoneMissed : call.direction === 'incoming' ? PhoneIncoming : PhoneOutgoing;
    const isVoiceCall = call.callType === 'audio';
    const CallbackIcon = isVoiceCall ? Phone : Video;
    return (
      <div className="ww-call-row" key={call.id}>
        <span className={`ww-mini-avatar ${isGroupCall ? 'group' : ''}`}>{initialOf(displayName)}</span>
        <span className="ww-call-row-body">
          <strong>{isGroupCall ? displayName : displayName}</strong>
          <span className={`ww-call-row-meta ${call.status === 'missed' ? 'missed' : ''}`}>
            <StatusIcon size={13} />
            {' '}
            {isVoiceCall ? 'Voice' : 'Video'}
            {' · '}
            {call.status === 'missed' ? 'Missed' : call.status === 'declined' ? 'Declined' : `Answered · ${formatDuration(call.duration)}`}
            {' · '}{new Date(call.startTime).toLocaleString([], { day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' })}
          </span>
        </span>
        <button type="button" className="ww-call-row-action"
          title={isVoiceCall ? 'Call back (voice)' : 'Call back (video)'}
          onClick={() => {
            if (isGroupCall) {
              grp ? openCallPicker(grp.members.filter((m) => m.userId !== user.id).map((m) => ({ id: m.userId, username: m.username })), grp.id) : setNotice('That group is no longer available');
            } else {
              const contact = contacts.find((c) => c.id === call.contactId);
              if (contact) isVoiceCall ? startAudioCall(contact) : startCall(contact);
            }
          }}
        ><CallbackIcon size={18} /></button>
      </div>
    );
  };

  return (
    <div className={`ww-shell ${selected ? 'has-chat-open' : ''}`}>
      <input type="file" accept="image/*" ref={galleryInputRef} style={{ display: 'none' }} onChange={handleGallerySelect} />
      <input type="file" ref={documentInputRef} style={{ display: 'none' }} onChange={handleDocumentSelect} />
      <input type="file" accept="audio/*" ref={audioFileInputRef} style={{ display: 'none' }} onChange={handleAudioFileSelect} />
      <input type="file" accept="image/*" capture="environment" ref={cameraInputRef} style={{ display: 'none' }} onChange={handleCameraCapture} />
      {/* Rail */}
      <aside className="ww-rail">
        <button type="button" data-popover-trigger className="ww-rail-avatar" title="Your profile" onClick={() => setInfoPanel(infoPanel === 'self' ? null : 'self')}>{initialOf(user.name)}</button>
        <div className="ww-rail-icons">
          <button type="button" data-popover-trigger title="New chat" className={activePopover === 'newChat' ? 'active' : ''} onClick={() => setActivePopover(activePopover === 'newChat' ? null : 'newChat')}><MessageSquarePlus size={22} /></button>
          <button type="button" data-popover-trigger title="New group" className={activePopover === 'newGroup' ? 'active' : ''} onClick={() => setActivePopover(activePopover === 'newGroup' ? null : 'newGroup')}><UsersRound size={22} /></button>
          <button type="button" title="Status" className={activeTab === 'status' ? 'active' : ''} onClick={() => { setActiveTab(activeTab === 'status' ? 'chats' : 'status'); if (activeTab !== 'status') loadStatuses(); setShowCallsPanel(false); }}><CircleDot size={22} /></button>
          <button type="button" data-popover-trigger title="Calls" className={showCallsPanel ? 'active' : ''} onClick={() => { setShowCallsPanel((p) => !p); setActivePopover(null); if (!showCallsPanel) loadCallHistory(); }}><Phone size={22} /></button>
        </div>
        <div className="ww-rail-bottom">
          <button type="button" title="Log out" onClick={() => setConfirmLogout(true)}><LogOut size={22} /></button>
        </div>
      </aside>

      {/* Chat list */}
      <section className="ww-list-panel">
        {showCallsPanel ? (
          <>
            <header className="ww-list-header">
              <div className="ww-list-header-top">
                <h2>Calls</h2>
                <div style={{ display: 'flex', alignItems: 'center', gap: '4px' }}>
                  <div style={{ position: 'relative' }}>
                    <button
                      type="button"
                      title="More options"
                      data-popover-trigger
                      style={{ background: 'none', border: 'none', cursor: 'pointer', display: 'flex', padding: '6px', borderRadius: '50%', color: '#54656f' }}
                      onClick={() => setShowCallsMenu((p) => !p)}
                    ><MoreVertical size={20} /></button>
                    {showCallsMenu && (
                      <div className="ww-calls-menu-dropdown" onMouseDown={(e) => e.stopPropagation()}>
                        <button type="button" onClick={clearCallHistory}>
                          <Trash2 size={15} /> Clear call log
                        </button>
                        <button type="button" onClick={() => { setShowCallsMenu(false); setNotice('No scheduled calls yet.'); }}>
                          <Clock size={15} /> Scheduled calls
                        </button>
                        <button type="button" onClick={() => { setShowCallsMenu(false); setShowCallSettings(true); }}>
                          <Settings2 size={15} /> Settings
                        </button>
                      </div>
                    )}
                  </div>
                  <button type="button" onClick={() => { setShowCallsPanel(false); setShowCallsMenu(false); }}><X size={20} /></button>
                </div>
              </div>
            </header>
            <div className="ww-conversation-list">{callHistory.map(renderCallRow)}{!callHistory.length && <p className="ww-empty-chats">No calls yet.</p>}</div>
          </>
        ) : (
          <>
          <header className="ww-list-header">
            <div className="ww-list-header-top">
              <h2>ChatApp</h2>
              <div className="ww-list-header-icons">
                <button type="button" title="Search" onClick={() => searchInputRef.current?.focus()}><Search size={20} /></button>
                <ThreeDotMenu
                  onNewGroup={() => setActivePopover('newGroup')}
                  onArchivedChats={() => setShowArchivedPanel(true)}
                  onStarredMessages={openStarredMessages}
                  onSelectChats={() => setBulkSelectMode(true)}
                  onMarkAllRead={() => setNotice('All chats marked as read (UI)')}
                  onAppLock={handleAppLockClick}
                  onToggleTheme={toggleTheme}
                  onSettings={() => navigate('/settings')}
                  onLogout={() => setConfirmLogout(true)}
                  isDarkMode={isDarkMode}
                  isAppLockEnabled={appLockEnabled}
                />
              </div>
            </div>
            <div className="ww-mobile-tabs">
              <button type="button" className={activeTab === 'chats' ? 'active' : ''} onClick={() => setActiveTab('chats')}>CHATS</button>
              <button type="button" className={activeTab === 'status' ? 'active' : ''} onClick={() => { setActiveTab('status'); loadStatuses(); }}>STATUS</button>
              <button type="button" className={activeTab === 'calls' ? 'active' : ''} onClick={() => { setActiveTab('calls'); loadCallHistory(); }}>CALLS</button>
            </div>          </header>

          <div className="ww-search-bar" style={{ position: 'relative' }}>
            <Search size={16} />
            <input
              ref={searchInputRef}
              value={searchQuery}
              onChange={handleSearchChange}
              placeholder="Search or start a new chat"
              onBlur={(e) => {
                // Close search results when focus leaves both the input AND the results panel
                setTimeout(() => {
                  if (!document.activeElement?.closest('.ww-global-search-results')) {
                    setGlobalSearchResults(null);
                    if (!searchQuery) setSearchQuery('');
                  }
                }, 150);
              }}
            />
            {searchQuery && (
              <button
                type="button"
                style={{ background: 'none', border: 'none', cursor: 'pointer', color: '#54656f', display: 'flex', padding: '2px' }}
                onClick={() => { setSearchQuery(''); setGlobalSearchResults(null); }}
              >
                <X size={15} />
              </button>
            )}
          </div>

          {/* Global search results dropdown */}
          {globalSearchResults && (
            <div className="ww-global-search-results">
              <div className="ww-search-section-label">People</div>
              {globalSearchResults.users.length ? globalSearchResults.users.map((u) => (
                <button type="button" key={u.id} className="ww-search-result-row" onClick={() => { const c = contacts.find((c) => c.id === u.id); if (c) selectChat('direct', c); setSearchQuery(''); setGlobalSearchResults(null); }}>
                  <span className="ww-mini-avatar">{initialOf(u.username)}</span><span>@{u.username}{u.name ? ` · ${u.name}` : ''}</span>
                </button>
              )) : <p className="ww-search-empty">No people found</p>}
              <div className="ww-search-section-label">Groups</div>
              {globalSearchResults.groups.length ? globalSearchResults.groups.map((g) => (
                <button type="button" key={g.id} className="ww-search-result-row" onClick={() => { const gr = groups.find((gr) => gr.id === g.id); if (gr) selectChat('group', gr); setSearchQuery(''); setGlobalSearchResults(null); }}>
                  <span className="ww-mini-avatar">{initialOf(g.name)}</span><span>{g.name}</span>
                </button>
              )) : <p className="ww-search-empty">No groups found</p>}
              <div className="ww-search-section-label">Messages</div>
              {globalSearchResults.messages.length ? globalSearchResults.messages.map((m) => (
                <button type="button" key={m.id} className="ww-search-result-row" onClick={() => { const cId = m.senderId === user.id ? m.recipientId : m.senderId; const c = contacts.find((c) => c.id === cId); if (c) selectChat('direct', c); setSearchQuery(''); setGlobalSearchResults(null); }}>
                  <span className="ww-mini-avatar">💬</span>
                  <span className="ww-search-msg-preview">{m.msg}</span>
                  <span className="ww-search-msg-time">{new Date(m.timeStamp).toLocaleDateString()}</span>
                </button>
              )) : <p className="ww-search-empty">No messages found</p>}
            </div>
          )}

          {activePopover === 'newChat' && (
            <div className="ww-popover">
              <div className="ww-popover-header"><h3>New chat</h3><button type="button" onClick={() => setActivePopover(null)}><X size={18} /></button></div>
              <form className="ww-popover-form" onSubmit={addFriend}>
                <input
                  value={friendUsername}
                  onChange={(e) => setFriendUsername(e.target.value)}
                  placeholder="Search by name or email…"
                />
                <button type="submit">Add</button>
              </form>
              <div className="ww-popover-list">
                {availableContacts.map((c) => (
                  <button type="button" key={c.id} onClick={() => selectChat('direct', c)}>
                    <span className="ww-mini-avatar">{initialOf(c.name || c.username)}</span>
                    <span style={{ display: 'flex', flexDirection: 'column', gap: '1px', textAlign: 'left' }}>
                      <span style={{ fontWeight: 600, fontSize: '14px' }}>{c.name || c.username}</span>
                      {c.email && <span style={{ fontSize: '11px', color: '#8696a0' }}>{c.email}</span>}
                    </span>
                  </button>
                ))}
                {!availableContacts.length && <p className="ww-popover-empty">All your friends already have an open chat.</p>}
              </div>
            </div>
          )}

          {activePopover === 'newGroup' && (
            <div className="ww-popover">
              <div className="ww-popover-header"><h3>New group</h3><button type="button" onClick={() => setActivePopover(null)}><X size={18} /></button></div>
              <form className="ww-popover-form" onSubmit={createGroup}>
                <input value={groupName} onChange={(e) => setGroupName(e.target.value)} placeholder="Group name" />
                <div className="ww-checkbox-list">
                  {contacts.map((c) => (<label key={c.id}><input type="checkbox" checked={groupMembers.includes(c.id)} onChange={() => toggleGroupMember(c.id)} />{c.name || c.username}</label>))}
                  {!contacts.length && <p className="ww-popover-empty">Add friends first to create a group.</p>}
                </div>
                <button type="submit">Create group</button>
              </form>
            </div>
          )}

          {activeTab === 'status' ? (
            <div className="ww-status-panel">
              {/* Header with back navigation */}
              <div className="ww-status-panel-header">
                <button type="button" className="ww-status-back-btn" onClick={() => setActiveTab('chats')}><ArrowLeft size={18} /></button>
                <h3>Status</h3>
              </div>
              {/* My status */}
              <div className="ww-status-section-label">My status</div>
              <div className="ww-my-status-row">
                <button
                  type="button"
                  className="ww-status-avatar-btn"
                  onClick={() => { if (myStatus?.items?.length) viewStatus(myStatus); else setShowAddStatus(true); }}
                >
                  <span className={`ww-avatar ${myStatus?.items?.length ? 'has-status' : ''}`}>{initialOf(user.name)}</span>
                  {!myStatus?.items?.length && <span className="ww-status-add-plus">+</span>}
                </button>
                <span className="ww-status-row-body">
                  <strong>My status</strong>
                  <span>{myStatus?.items?.length ? `${myStatus.items.length} update${myStatus.items.length > 1 ? 's' : ''}` : 'Tap to add status update'}</span>
                </span>
                <button type="button" className="ww-status-add-btn" title="Add status" onClick={() => setShowAddStatus(true)}><Pencil size={16} /></button>
              </div>

              {/* Add status form */}
              {showAddStatus && (
                <div className="ww-add-status-form">
                  <textarea
                    value={newStatusText}
                    onChange={(e) => setNewStatusText(e.target.value)}
                    placeholder="Type a status…"
                    maxLength={139}
                    rows={3}
                    autoFocus
                  />
                  <div className="ww-status-bg-row">
                    {STATUS_BG_COLORS.map((c) => (
                      <button key={c} type="button" className={`ww-status-bg-swatch ${statusBgColor === c ? 'selected' : ''}`} style={{ background: c }} onClick={() => setStatusBgColor(c)} />
                    ))}
                  </div>
                  <div className="ww-add-status-actions">
                    <button type="button" className="ww-status-cancel-btn" onClick={() => { setShowAddStatus(false); setNewStatusText(''); }}>Cancel</button>
                    <button type="button" className="ww-status-post-btn" disabled={!newStatusText.trim()} onClick={postStatus}>Post</button>
                  </div>
                </div>
              )}

              {/* My status items preview */}
              {myStatus?.items?.length > 0 && (
                <div className="ww-my-status-items">
                  {myStatus.items.map((item) => (
                    <div key={item.id} className="ww-my-status-item" style={{ background: item.bgColor }}>
                      <span>{item.text}</span>
                      <button type="button" className="ww-status-delete-btn" onClick={() => deleteStatus(item.id)}><X size={12} /></button>
                    </div>
                  ))}
                </div>
              )}

              {/* Friends' statuses */}
              {statusList.length > 0 && <>
                <div className="ww-status-section-label" style={{ marginTop: '12px' }}>Recent updates</div>
                {statusList.map((entry) => {
                  const allViewed = entry.items.every((i) => i.viewed);
                  return (
                    <button key={entry.userId} type="button" className="ww-status-entry-row" onClick={() => viewStatus(entry)}>
                      <span className={`ww-avatar ${allViewed ? 'status-viewed' : 'has-status'}`}>{initialOf(entry.name)}</span>
                      <span className="ww-status-row-body">
                        <strong>{entry.name}</strong>
                        <span>{new Date(entry.items[0].createdAt).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}</span>
                      </span>
                    </button>
                  );
                })}
              </>}
              {statusList.length === 0 && !myStatus && (
                <p className="ww-empty-chats" style={{ marginTop: '24px' }}>No status updates yet.<br />Add friends to see their statuses.</p>
              )}
            </div>
          ) : activeTab === 'calls' ? (
            <div className="ww-conversation-list">{callHistory.map(renderCallRow)}{!callHistory.length && <p className="ww-empty-chats">No calls yet.</p>}</div>
          ) : (
            <>
            <div className="ww-list-view-toggle">
              <button type="button" className={chatListView === 'direct' ? 'active' : ''} onClick={() => setChatListView('direct')}>
                <MessageCircle size={15} /> Chats
                {totalUnreadDirect > 0 && <span className="ww-tab-badge">{totalUnreadDirect > 99 ? '99+' : totalUnreadDirect}</span>}
              </button>
              <button type="button" className={chatListView === 'groups' ? 'active' : ''} onClick={() => setChatListView('groups')}>
                <UsersRound size={15} /> Groups
                {totalUnreadGroups > 0 && <span className="ww-tab-badge">{totalUnreadGroups > 99 ? '99+' : totalUnreadGroups}</span>}
              </button>
            </div>
            <div className="ww-conversation-list">
              {chatListView === 'direct' ? (
                <div className="ww-list-section direct">
                  {/* Favourites section */}
                  {favouriteConversations.length > 0 && !searchQuery.trim() && (
                    <div className="ww-favourites-section">
                      <div className="ww-section-divider-label">⭐ Favourites</div>
                      {favouriteConversations.map((chat) => (
                        <button type="button" key={`fav-${chat.id}`} className={`ww-conversation favourite ${selected?.type === 'direct' && selected.data.id === chat.id ? 'active' : ''}`} onClick={() => selectChat('direct', chat)}>
                          <span className={`ww-avatar ${onlineUserIds.has(chat.id) ? 'online' : ''}`}>{initialOf(chat.name || chat.username)}</span>
                          <span className="ww-conversation-body"><span className="ww-conversation-top"><strong>{chat.name || chat.username}</strong></span><span className="ww-conversation-preview">{chat.lastMessage}</span></span>
                        </button>
                      ))}
                      <div className="ww-section-divider-label">All Chats</div>
                    </div>
                  )}
                  {sortedConversations.map((chat) => {
                    const rowKey = chatKeyFor('direct', chat.id);
                    const isPinned = pinnedChatKeys.includes(rowKey);
                    const unread = unreadCounts[chat.id] || 0;
                    return (
                      <button type="button" key={chat.id} className={`ww-conversation ${selected?.type === 'direct' && selected.data.id === chat.id ? 'active' : ''} ${isPinned ? 'pinned' : ''}`} onClick={() => bulkSelectMode ? toggleChatSelected(rowKey) : selectChat('direct', chat)}>
                        {bulkSelectMode && <input type="checkbox" className="ww-bulk-checkbox" checked={selectedChatKeys.has(rowKey)} onChange={() => toggleChatSelected(rowKey)} onClick={(e) => e.stopPropagation()} />}
                        <span className={`ww-avatar ${onlineUserIds.has(chat.id) ? 'online' : ''}`}>{initialOf(chat.name || chat.username)}</span>
                        <span className="ww-conversation-body">
                          <span className="ww-conversation-top"><strong>{chat.name || chat.username}</strong>{chat.timeStamp && <span className="ww-conversation-time">{new Date(chat.timeStamp).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}</span>}</span>
                          <span className="ww-conversation-preview">{chat.lastMessage}</span>
                        </span>
                        {unread > 0 && <span className="ww-unread-badge">{unread > 99 ? '99+' : unread}</span>}
                        {isPinned && !unread && <span className="ww-pin-badge" title="Pinned">📌</span>}
                      </button>
                    );
                  })}
                  {!sortedConversations.length && <p className="ww-empty-chats">No private chats yet.</p>}
                </div>
              ) : (
                <div className="ww-list-section groups">
                  {/* Group favourites section */}
                  {favouriteGroups.length > 0 && !searchQuery.trim() && (
                    <div className="ww-favourites-section">
                      <div className="ww-section-divider-label">⭐ Favourites</div>
                      {favouriteGroups.map((group) => (
                        <button type="button" key={`fav-${group.id}`} className={`ww-conversation favourite ${selected?.type === 'group' && selected.data.id === group.id ? 'active' : ''}`} onClick={() => selectChat('group', group)}>
                          <span className="ww-avatar group">{initialOf(group.name)}</span>
                          <span className="ww-conversation-body"><span className="ww-conversation-top"><strong>{group.name}</strong></span><span className="ww-conversation-preview">{group.lastMessage || `${group.members.length} members`}</span></span>
                        </button>
                      ))}
                      <div className="ww-section-divider-label">All Groups</div>
                    </div>
                  )}
                  {sortedGroups.map((group) => {
                    const rowKey = chatKeyFor('group', group.id);
                    const isPinned = pinnedChatKeys.includes(rowKey);
                    const unread = unreadCounts[group.id] || 0;
                    return (
                      <button type="button" key={group.id} className={`ww-conversation ${selected?.type === 'group' && selected.data.id === group.id ? 'active' : ''} ${isPinned ? 'pinned' : ''}`} onClick={() => bulkSelectMode ? toggleChatSelected(rowKey) : selectChat('group', group)}>
                        {bulkSelectMode && <input type="checkbox" className="ww-bulk-checkbox" checked={selectedChatKeys.has(rowKey)} onChange={() => toggleChatSelected(rowKey)} onClick={(e) => e.stopPropagation()} />}
                        <span className="ww-avatar group">{initialOf(group.name)}</span>
                        <span className="ww-conversation-body">
                          <span className="ww-conversation-top"><strong>{group.name}</strong>{group.timeStamp && <span className="ww-conversation-time">{new Date(group.timeStamp).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}</span>}</span>
                          <span className="ww-conversation-preview">{group.lastMessage || `${group.members.length} members`}</span>
                        </span>
                        {unread > 0 && <span className="ww-unread-badge">{unread > 99 ? '99+' : unread}</span>}
                        {isPinned && !unread && <span className="ww-pin-badge" title="Pinned">📌</span>}
                      </button>
                    );
                  })}
                  {!sortedGroups.length && <p className="ww-empty-chats">No groups yet.</p>}
                </div>
              )}
            </div>
            </>
          )}

          {activeTab === 'chats' && <button type="button" className="ww-fab" title="New chat" onClick={() => setActivePopover('newChat')}><MessageSquarePlus size={22} /></button>}
          </>
        )}
      </section>

      {/* Conversation panel */}
      <main className="ww-conversation-panel">
        {selected ? (
          <>
            <header className="ww-conversation-header">
              <div className="ww-conversation-identity-wrap">
                <button type="button" className="ww-back-btn" onClick={() => setSelected(null)}><ArrowLeft size={22} /></button>
                <button type="button" className="ww-conversation-identity" onClick={() => setInfoPanel('contact')}>
                  <span className={`ww-avatar ${isDirectOnline ? 'online' : ''}`}>{initialOf(selected.type === 'group' ? selected.data.name : (selected.data.name || selected.data.username))}</span>
                  <span className="ww-identity-text">
                    <h1>{selected.type === 'group' ? selected.data.name : (selected.data.name || selected.data.username)}</h1>
                    {statusText && <span className={`ww-status-line ${isDirectTyping || isGroupTyping ? 'typing' : ''} ${isBlocked ? 'blocked' : ''}`}>{statusText}</span>}
                  </span>
                </button>
              </div>
              <div className="ww-header-icons">
                {selected.type === 'direct' && <>
                  <button type="button" title="Voice call" disabled={isBlocked} onClick={() => startAudioCall()}><Phone size={20} /></button>
                  <button type="button" title="Video call" disabled={isBlocked} onClick={() => startCall()}><Video size={20} /></button>
                </>}
                {selected.type === 'group' && (
                  <button type="button" title="Group video call" onClick={() => openCallPicker(selected.data.members.filter((m) => m.userId !== user.id).map((m) => ({ id: m.userId, username: m.username })), selected.data.id)}><Video size={20} /></button>
                )}
                <button type="button" title="Search in chat" className={chatSearchOpen ? 'active' : ''} onClick={() => { setChatSearchOpen((p) => !p); setChatSearchQuery(''); }}><Search size={20} /></button>
                <button type="button" data-popover-trigger title="More options" onClick={() => setActivePopover(activePopover === 'chatMenu' ? null : 'chatMenu')}><MoreVertical size={20} /></button>
              </div>

              {activePopover === 'chatMenu' && (
                <div className="ww-chat-menu-dropdown">
                  <button type="button" onClick={() => setActivePopover('newGroup')}><Users size={16} /> New group</button>
                  <button type="button" onClick={() => { setInfoPanel('contact'); setActivePopover(null); }}><Info size={16} /> {selected.type === 'group' ? 'Group info' : 'Contact info'}</button>
                  <button type="button" onClick={() => { setInfoPanel('contact'); setActivePopover(null); }}><Link2 size={16} /> Media, links & docs</button>
                  <button type="button" onClick={() => { togglePinChat(selected.type, selected.data.id); setActivePopover(null); }}>
                    <Flag size={16} /> {pinnedChatKeys.includes(currentChatKey) ? 'Unpin chat' : 'Pin chat'}
                  </button>
                  <button type="button" onClick={() => { updateChatSetting(currentChatKey, { disappearing: !isDisappearing }); setActivePopover(null); }}><Clock size={16} /> Disappearing · {isDisappearing ? 'On' : 'Off'}</button>
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
                  <div className="ww-theme-sheet" onClick={(e) => e.stopPropagation()}>
                    <div className="ww-popover-header"><h3>Chat theme</h3><button type="button" onClick={() => setActivePopover(null)}><X size={18} /></button></div>
                    <div className="ww-theme-grid">
                      {THEME_COLORS.map((color) => (<button type="button" key={color} className={currentSettings.theme === color ? 'active' : ''} style={{ background: color }} onClick={() => { updateChatSetting(currentChatKey, { theme: color }); setActivePopover(null); }} />))}
                    </div>
                    <button type="button" className="ww-theme-reset" onClick={() => { updateChatSetting(currentChatKey, { theme: null }); setActivePopover(null); }}>Reset to default</button>
                  </div>
                </div>
              )}
            </header>

            {/* Pinned message strip */}
            {latestPinnedMessage && (
              <div className="ww-pinned-message-strip">
                <span className="ww-pinned-label">📌 Pinned:</span>
                <span className="ww-pinned-preview">{previewFor(latestPinnedMessage)}</span>
                <button type="button" onClick={() => pinMessage(latestPinnedMessage, false)} title="Unpin"><X size={14} /></button>
              </div>
            )}

            {chatSearchOpen && (
              <div className="ww-chat-search-bar">
                <Search size={16} />
                <input autoFocus value={chatSearchQuery} onChange={(e) => setChatSearchQuery(e.target.value)} placeholder="Search in this conversation" />
                <button type="button" onClick={() => { setChatSearchOpen(false); setChatSearchQuery(''); }}><X size={16} /></button>
              </div>
            )}

            {isBlocked && <div className="ww-blocked-banner"><Ban size={14} /> You blocked {selected.data.name || selected.data.username}. Unblock them to send or receive messages.</div>}
            {isDisappearing && !isBlocked && <div className="ww-disappearing-banner"><Clock size={13} /> Disappearing messages are on for this chat.</div>}

            <div className="ww-chat" ref={chatScrollRef} style={currentSettings.theme ? { '--chat-accent': currentSettings.theme } : undefined}>
              {/* E2EE integration point — WhatsApp-style encryption notice */}
              <EncryptionBanner />
              {groupedMessages.map((group) => (
                <React.Fragment key={group.label}>
                  <div className="ww-date-chip"><span>{group.label}</span></div>
                  {group.items.map((item) => {
                    const mine = item.senderId === user.id;
                    return (
                      <div key={item.id} className={`ww-message ${mine ? 'me' : ''} ${item.type === 'call' ? 'call-log' : ''}`} onMouseLeave={() => setMessageMenuId((p) => p === item.id ? null : p)}>
                        {selected.type === 'group' && !mine && item.type !== 'call' && <div className="ww-sender">{item.name || item.username}</div>}

                        {item.deletedForEveryone ? (
                          <div className="ww-bubble-text deleted">🚫 This message was deleted</div>
                        ) : item.type === 'call' ? (
                          <div className="ww-call-log-body">
                            {item.callInfo?.status === 'missed'
                              ? <PhoneMissed size={16} />
                              : item.callInfo?.callType === 'audio' ? <Phone size={16} /> : <Video size={16} />}
                            <span>{
                              item.callInfo?.callType === 'audio'
                                ? (item.callInfo?.status === 'missed' ? 'Missed voice call' : item.callInfo?.status === 'declined' ? 'Declined voice call' : `Voice call · ${formatDuration(item.callInfo?.duration)}`)
                                : (item.callInfo?.status === 'missed' ? 'Missed video call' : item.callInfo?.status === 'declined' ? 'Declined video call' : `Video call · ${formatDuration(item.callInfo?.duration)}`)
                            }</span>
                          </div>
                        ) : item.type === 'audio' ? (
                          <div className="ww-audio-bubble"><audio controls src={item.audioData} /></div>
                        ) : item.type === 'image' ? (
                          <a className="ww-image-bubble" href={item.fileData} target="_blank" rel="noreferrer"><img src={item.fileData} alt={item.fileName || 'Shared image'} /></a>
                        ) : item.type === 'file' ? (
                          <a className="ww-file-bubble" href={item.fileData} download={item.fileName}><FileText size={22} /><span>{item.fileName || 'Document'}</span></a>
                        ) : item.type === 'location' ? (
                          <a className="ww-location-bubble" href={`https://www.google.com/maps?q=${item.location?.lat},${item.location?.lng}`} target="_blank" rel="noreferrer"><MapPin size={18} /><span>Shared location</span></a>
                        ) : item.type === 'contact' ? (
                          <div className="ww-contact-bubble">
                            <span className="ww-mini-avatar">{initialOf(item.contactShare?.name || item.contactShare?.username)}</span>
                            <span className="ww-contact-bubble-name">{item.contactShare?.name || item.contactShare?.username}</span>
                            <div className="ww-contact-bubble-menu-wrap">
                              <button
                                type="button"
                                className="ww-contact-bubble-dots"
                                onClick={(e) => { e.stopPropagation(); setContactMenuMsgId(contactMenuMsgId === item.id ? null : item.id); }}
                              ><MoreVertical size={15} /></button>
                              {contactMenuMsgId === item.id && (
                                <div className="ww-contact-bubble-dropdown">
                                  <button type="button" onClick={() => addSharedContact(item.contactShare)}>
                                    <UserPlus size={14} /> Add to Contacts
                                  </button>
                                  <button type="button" onClick={() => callSharedContact(item.contactShare)}>
                                    <Phone size={14} /> Call
                                  </button>
                                </div>
                              )}
                            </div>
                          </div>
                        ) : item.type === 'poll' ? (
                          <div className="ww-poll-bubble">
                            <div className="ww-poll-header">
                              <span className="ww-poll-icon">📊</span>
                              <span className="ww-poll-question">{item.poll?.question}</span>
                            </div>
                            {item.poll?.closed && <div className="ww-poll-closed-badge">Poll closed</div>}
                            <div className="ww-poll-options">
                              {(item.poll?.options || []).map((opt) => {
                                const totalVotes = (item.poll?.options || []).reduce((sum, o) => sum + (o.votes?.length || 0), 0);
                                const myVote = (opt.votes || []).includes(user.id);
                                const pct = totalVotes > 0 ? Math.round(((opt.votes?.length || 0) / totalVotes) * 100) : 0;
                                return (
                                  <button
                                    key={opt.id}
                                    type="button"
                                    className={`ww-poll-option ${myVote ? 'voted' : ''} ${item.poll?.closed ? 'closed' : ''}`}
                                    onClick={() => !item.poll?.closed && votePoll(item.id, opt.id)}
                                    disabled={item.poll?.closed}
                                  >
                                    <div className="ww-poll-option-bar" style={{ width: `${pct}%` }} />
                                    <span className="ww-poll-option-text">
                                      {myVote && <span className="ww-poll-check">✓</span>}
                                      {opt.text}
                                    </span>
                                    <span className="ww-poll-option-pct">{pct}%</span>
                                  </button>
                                );
                              })}
                            </div>
                            <div className="ww-poll-footer">
                              <span>{(item.poll?.options || []).reduce((s, o) => s + (o.votes?.length || 0), 0)} votes · {item.poll?.allowMultiple ? 'Multiple choice' : 'Single choice'}</span>
                              {mine && !item.poll?.closed && (
                                <button type="button" className="ww-poll-close-btn" onClick={() => closePoll(item.id)}>Close poll</button>
                              )}
                            </div>
                          </div>
                        ) : editingMessageId === item.id ? (
                          <form className="ww-edit-form" onSubmit={(e) => { e.preventDefault(); submitEditMessage(item); }}>
                            <input ref={editInputRef} value={editingMessageText} onChange={(e) => setEditingMessageText(e.target.value)} className="ww-edit-input" />
                            <div className="ww-edit-actions">
                              <button type="submit" title="Save"><Check size={14} /></button>
                              <button type="button" title="Cancel" onClick={() => { setEditingMessageId(null); setEditingMessageText(''); }}><X size={14} /></button>
                            </div>
                          </form>
                        ) : (
                          <div className="ww-bubble-text">{item.msg}</div>
                        )}

                        {/* Message menu button */}
                        {item.type !== 'call' && !item.deletedForEveryone && (
                          <button type="button" className="ww-msg-menu-btn" onClick={() => setMessageMenuId((p) => p === item.id ? null : item.id)}><MoreVertical size={14} /></button>
                        )}

                        {/* Message context menu */}
                        {messageMenuId === item.id && (
                          <div className="ww-msg-menu">
                            <button type="button" onClick={() => openForward(item)}><Forward size={13} /> Forward</button>
                            {item.type === 'text' && mine && <button type="button" onClick={() => startEditMessage(item)}><Pencil size={13} /> Edit</button>}
                            <button type="button" onClick={() => { setReactionPickerMessageId(item.id); setMessageMenuId(null); }}><Smile size={13} /> React</button>
                            <button type="button" onClick={() => toggleStar(item)}><Star size={13} /> {(item.starredBy || []).includes(user.id) ? 'Unstar' : 'Star'}</button>
                            <button type="button" onClick={() => pinMessage(item, !item.isPinned)}><Flag size={13} /> {item.isPinned ? 'Unpin' : 'Pin'}</button>
                            <button type="button" onClick={() => deleteMessage(item, false)}><Trash2 size={13} /> Delete for me</button>
                            {mine && <button type="button" onClick={() => deleteMessage(item, true)}><Trash2 size={13} /> Delete for everyone</button>}
                          </div>
                        )}

                        {/* Reaction picker */}
                        {reactionPickerMessageId === item.id && (
                          <div className="ww-reaction-picker">
                            {EMOJIS.slice(0, 18).map((emoji) => (<button type="button" key={emoji} onClick={() => reactToMessage(item, emoji)}>{emoji}</button>))}
                          </div>
                        )}

                        {/* Reactions display */}
                        {item.type !== 'call' && !item.deletedForEveryone && (item.reactions || []).length > 0 && (
                          <div className="ww-reactions">
                            {Object.entries((item.reactions || []).reduce((acc, r) => { acc[r.emoji] = (acc[r.emoji] || 0) + 1; return acc; }, {})).map(([emoji, count]) => (
                              <button type="button" key={emoji} className={`ww-reaction-chip ${(item.reactions || []).some((r) => r.emoji === emoji && r.userId === user.id) ? 'mine' : ''}`} onClick={() => reactToMessage(item, emoji)}>
                                {emoji}{count > 1 && <span>{count}</span>}
                              </button>
                            ))}
                          </div>
                        )}

                        {/* Message meta */}
                        {item.type !== 'call' && !item.deletedForEveryone && (
                          <div className="ww-meta">
                            <span className="ww-time">{new Date(item.timeStamp).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}</span>
                            {item.editedAt && <span className="ww-edited-label">edited</span>}
                            {(item.starredBy || []).includes(user.id) && <Star size={11} className="ww-star-indicator" />}
                            {mine && selected.type === 'direct' && (item.read ? <CheckCheck size={14} className="ww-check read" /> : item.delivered ? <CheckCheck size={14} className="ww-check" /> : <Check size={14} className="ww-check" />)}
                            {mine && selected.type === 'group' && <CheckCheck size={14} className="ww-check" />}
                          </div>
                        )}
                      </div>
                    );
                  })}
                </React.Fragment>
              ))}
              {!visibleMessages.length && <p className="ww-empty-chats">{chatSearchQuery ? 'No messages match your search.' : 'Say hello 👋 — no messages here yet.'}</p>}
              {(isDirectTyping || isGroupTyping) && <div className="ww-typing-bubble"><span className="ww-dot" /><span className="ww-dot" /><span className="ww-dot" /></div>}
            </div>

            <button type="button" className="ww-scroll-fab" onClick={scrollToBottom} title="Scroll to latest"><ChevronDown size={18} /></button>

            {showEmojiPicker && (
              <div className="ww-emoji-picker">
                {EMOJIS.map((emoji) => (<button type="button" key={emoji} onClick={() => insertEmoji(emoji)}>{emoji}</button>))}
              </div>
            )}

            <form className="ww-inputbar" onSubmit={sendMessage}>
              <button type="button" data-popover-trigger className="ww-emoji" disabled={isBlocked} onClick={() => setShowEmojiPicker((p) => !p)}><Smile size={20} /></button>
              <button type="button" data-popover-trigger className="ww-attach" disabled={isBlocked} onClick={() => setActivePopover(activePopover === 'attach' ? null : 'attach')}><Paperclip size={20} /></button>
              {isRecording ? (
                <div className="ww-recording-indicator"><span className="ww-rec-dot" /> Recording… {formatDuration(recordSeconds)}</div>
              ) : (
                <input value={message} onChange={handleMessageChange} placeholder={isBlocked ? 'You blocked this contact' : 'Type a message here ..'} disabled={isBlocked} />
              )}
              <button type="button" className="ww-camera-btn" disabled={isBlocked} onClick={openCamera}><Camera size={20} /></button>
              {message.trim() ? (
                <button type="submit" className="ww-send" disabled={isBlocked}><Send size={18} /></button>
              ) : (
                <button type="button" className={`ww-send ww-mic ${isRecording ? 'recording' : ''}`} disabled={isBlocked} onClick={handleMicClick}>{isRecording ? <StopCircle size={18} /> : <Mic size={18} />}</button>
              )}
            </form>

            {activePopover === 'attach' && (
              <div className="ww-attach-sheet-overlay" onClick={() => setActivePopover(null)}>
                <div className="ww-attach-sheet" onClick={(e) => e.stopPropagation()}>
                  <div className="ww-attach-grid">
                    <button type="button" onClick={() => documentInputRef.current?.click()}><span className="ww-attach-icon doc"><FileText size={22} /></span>Document</button>
                    <button type="button" onClick={() => { setActivePopover(null); openCamera(); }}><span className="ww-attach-icon cam"><Camera size={22} /></span>Camera</button>
                    <button type="button" onClick={() => galleryInputRef.current?.click()}><span className="ww-attach-icon gal"><ImageIcon size={22} /></span>Gallery</button>
                    <button type="button" onClick={() => audioFileInputRef.current?.click()}><span className="ww-attach-icon aud"><Headphones size={22} /></span>Audio</button>
                    <button type="button" onClick={shareLocation}><span className="ww-attach-icon loc"><MapPin size={22} /></span>Location</button>
                    <button type="button" onClick={() => setActivePopover('shareContact')}><span className="ww-attach-icon con"><UserIcon size={22} /></span>Contact</button>
                    <button type="button" onClick={openPollModal}><span className="ww-attach-icon poll">📊</span>Poll</button>
                  </div>
                </div>
              </div>
            )}

            {activePopover === 'shareContact' && (
              <div className="ww-attach-sheet-overlay" onClick={() => setActivePopover(null)}>
                <div className="ww-forward-sheet" onClick={(e) => e.stopPropagation()}>
                  <div className="ww-popover-header"><h3>Share a contact</h3><button type="button" onClick={() => setActivePopover(null)}><X size={18} /></button></div>
                  <div className="ww-popover-list">
                    {contacts.map((c) => (<button type="button" key={c.id} onClick={() => shareContact(c)}><span className="ww-mini-avatar">{initialOf(c.username)}</span>@{c.username}</button>))}
                    {!contacts.length && <p className="ww-popover-empty">Add friends first to share a contact.</p>}
                  </div>
                </div>
              </div>
            )}
          </>
        ) : (
          <div className="ww-empty-conversation"><p>Select a chat, create a group, or start a new conversation.</p></div>
        )}
        {error && <p className="ww-auth-error">{error}</p>}
        {notice && <p className="ww-auth-notice">{notice}</p>}
      </main>

      {/* Info panel */}
      {infoPanel && (infoPanel === 'self' || selected) && (
        <aside className="ww-info-panel">
          <header className="ww-info-header">
            <button type="button" onClick={() => setInfoPanel(null)}><X size={20} /></button>
            <h2>{infoPanel === 'self' ? 'Profile' : selected.type === 'group' ? 'Group Info' : 'Contact Info'}</h2>
            {infoPanel !== 'self' && selected.type === 'group' && (
              <button type="button" data-popover-trigger className="ww-info-menu-btn" onClick={() => setActivePopover(activePopover === 'groupInfoMenu' ? null : 'groupInfoMenu')}><MoreVertical size={18} /></button>
            )}
          </header>

          {activePopover === 'groupInfoMenu' && (
            <div className="ww-chat-menu-dropdown group-info">
              <button type="button" onClick={() => { setEditingGroupField('name'); setGroupNameDraft(selected.data.name); setActivePopover(null); }}><Pencil size={15} /> Edit name</button>
              <button type="button" onClick={() => { setEditingGroupField('description'); setGroupDescriptionDraft(selected.data.description || ''); setActivePopover(null); }}><Pencil size={15} /> Edit description</button>
              <button type="button" onClick={exportChat}><Download size={15} /> Export chat</button>
            </div>
          )}

          <div className="ww-info-body">
            {infoPanel === 'self' ? (
              <SelfProfilePanel authorization={authorization} />
            ) : (
              <>
                <div className="ww-info-avatar">{initialOf(selected.type === 'group' ? selected.data.name : selected.data.username)}</div>

                {selected.type === 'group' && editingGroupField === 'name' ? (
                  <form className="ww-inline-edit" onSubmit={saveGroupName}>
                    <input value={groupNameDraft} onChange={(e) => setGroupNameDraft(e.target.value)} autoFocus maxLength={80} />
                    <button type="submit" title="Save"><Check size={14} /></button>
                    <button type="button" title="Cancel" onClick={() => setEditingGroupField(null)}><X size={14} /></button>
                  </form>
                ) : (
                  <>
                    <h3>{selected.type === 'group' ? selected.data.name : (selected.data.name || selected.data.username)}</h3>
                    {selected.type === 'direct' && selected.data.email && (
                      <p style={{ fontSize: '12px', color: '#8696a0', margin: '-12px 0 8px' }}>{selected.data.email}</p>
                    )}
                  </>
                )}

                <p className="ww-info-sub">{selected.type === 'group' ? `${selected.data.members.length} members` : 'Friend'}</p>

                {selected.type === 'direct' && (
                  <button type="button" className={`ww-block-btn ${isBlocked ? 'blocked' : ''}`} onClick={() => toggleBlock(selectedContactMeta || selected.data)}>
                    {isBlocked ? <ShieldCheck size={16} /> : <Ban size={16} />} {isBlocked ? `Unblock ${selected.data.name || selected.data.username}` : `Block ${selected.data.name || selected.data.username}`}
                  </button>
                )}

                {selected.type === 'group' && (
                  <div className="ww-info-section">
                    <h4>Description</h4>
                    {editingGroupField === 'description' ? (
                      <form className="ww-inline-edit-block" onSubmit={saveGroupDescription}>
                        <textarea value={groupDescriptionDraft} onChange={(e) => setGroupDescriptionDraft(e.target.value)} maxLength={500} autoFocus rows={3} />
                        <div className="ww-inline-edit-actions"><button type="button" onClick={() => setEditingGroupField(null)}>Cancel</button><button type="submit">Save</button></div>
                      </form>
                    ) : (
                      <button type="button" className="ww-description-block" onClick={() => { setEditingGroupField('description'); setGroupDescriptionDraft(selected.data.description || ''); }}>
                        {selected.data.description ? <p>{selected.data.description}</p> : <p className="placeholder">Add group description</p>}
                      </button>
                    )}
                  </div>
                )}

                <div className="ww-info-section">
                  <h4>Media, Links and Documents</h4>
                  <div className="ww-media-grid">
                    {messages
                      .filter((m) => m.type === 'image' && !m.deletedForEveryone && m.fileData)
                      .slice(-3).reverse().map((m) => (
                      <a key={m.id} href={m.fileData} target="_blank" rel="noreferrer" className="ww-media-thumb"><img src={m.fileData} alt={m.fileName || 'Shared image'} /></a>
                    ))}
                    {!messages.some((m) => m.type === 'image' && !m.deletedForEveryone && m.fileData) && (
                      <><div className="ww-media-placeholder" /><div className="ww-media-placeholder" /><div className="ww-media-placeholder" /></>
                    )}
                  </div>
                </div>

                <div className="ww-info-toggles">
                  <div className="ww-info-toggle-row"><span>{isMuted ? <BellOff size={16} /> : <Bell size={16} />} Notifications</span><label className="ww-switch"><input type="checkbox" checked={!isMuted} onChange={() => updateChatSetting(currentChatKey, { muted: !isMuted })} /><span className="ww-switch-slider" /></label></div>
                  <div className="ww-info-toggle-row"><span><Eye size={16} /> Media visibility</span><label className="ww-switch"><input type="checkbox" checked={isMediaVisible} onChange={() => updateChatSetting(currentChatKey, { mediaVisibility: !isMediaVisible })} /><span className="ww-switch-slider" /></label></div>
                  <div className="ww-info-toggle-row"><span><Clock size={16} /> Disappearing messages</span><label className="ww-switch"><input type="checkbox" checked={isDisappearing} onChange={() => updateChatSetting(currentChatKey, { disappearing: !isDisappearing })} /><span className="ww-switch-slider" /></label></div>
                  <div className="ww-info-toggle-row"><span><Lock size={16} /> Chat lock</span><label className="ww-switch"><input type="checkbox" checked={isChatLocked} onChange={() => updateChatSetting(currentChatKey, { locked: !isChatLocked })} /><span className="ww-switch-slider" /></label></div>
                </div>

                {selected.type === 'group' && (
                  <div className="ww-info-section">
                    <div className="ww-section-header-row">
                      <h4>{selected.data.members.length} Members</h4>
                      <button type="button" className="ww-add-members-btn" onClick={() => { setAddMembersSelection([]); setActivePopover('addMembers'); }}><UserPlus size={15} /> Add</button>
                    </div>
                    <ul className="ww-member-list">
                      {selected.data.members.map((member) => (
                        <li key={member.userId}>
                          <span className="ww-mini-avatar">{initialOf(member.name || member.username)}</span>
                          <span className="ww-member-name-col">
                            <span>{member.name || member.username}{member.userId === user.id ? ' (You)' : ''}</span>
                            {member.userId === selected.data.createdBy && <span className="ww-admin-badge">Group admin</span>}
                          </span>
                        </li>
                      ))}
                    </ul>
                  </div>
                )}

                <div className="ww-info-actions">
                  {selected.type === 'group' && <button type="button" onClick={viewMemberChanges}><Users size={16} /> View member changes</button>}
                  <button type="button" onClick={toggleFavourite}><Star size={16} className={isFavourite ? 'ww-favourite-filled' : ''} /> {isFavourite ? 'Remove from favourites' : 'Add to favourites'}</button>
                  <button type="button" onClick={addToList}><Star size={16} /> Add to list</button>
                </div>

                <div className="ww-info-actions danger">
                  <button type="button" onClick={clearChat}><Trash2 size={16} /> Clear chat</button>
                  {selected.type === 'group' && <button type="button" onClick={exitGroup}><LogOut size={16} /> Exit group</button>}
                  <button type="button" onClick={reportChat}><Flag size={16} /> Report {selected.type === 'group' ? 'group' : 'contact'}</button>
                </div>

                {selected.type === 'group' && selected.data.createdAt && (
                  <p className="ww-group-created">Group created on {new Date(selected.data.createdAt).toLocaleDateString([], { day: 'numeric', month: 'long', year: 'numeric' })}</p>
                )}
              </>
            )}
          </div>
        </aside>
      )}

      {/* Add members */}
      {activePopover === 'addMembers' && selected?.type === 'group' && (
        <div className="ww-attach-sheet-overlay" onClick={() => setActivePopover(null)}>
          <div className="ww-forward-sheet" onClick={(e) => e.stopPropagation()}>
            <div className="ww-popover-header"><h3>Add members</h3><button type="button" onClick={() => setActivePopover(null)}><X size={18} /></button></div>
            <div className="ww-checkbox-list ww-add-members-list">
              {contacts.filter((c) => !selected.data.members.some((m) => m.userId === c.id)).map((c) => (<label key={c.id}><input type="checkbox" checked={addMembersSelection.includes(c.id)} onChange={() => toggleAddMember(c.id)} />@{c.username}</label>))}
              {!contacts.filter((c) => !selected.data.members.some((m) => m.userId === c.id)).length && <p className="ww-popover-empty">All your friends are already in this group.</p>}
            </div>
            <button type="button" className="ww-start-call-btn" disabled={!addMembersSelection.length} onClick={submitAddMembers}><UserPlus size={16} /> Add {addMembersSelection.length || ''} member{addMembersSelection.length === 1 ? '' : 's'}</button>
          </div>
        </div>
      )}

      {/* Forward picker */}
      {forwardingMessage && (
        <div className="ww-attach-sheet-overlay" onClick={() => setForwardingMessage(null)}>
          <div className="ww-forward-sheet" onClick={(e) => e.stopPropagation()}>
            <div className="ww-popover-header"><h3>Forward message</h3><button type="button" onClick={() => setForwardingMessage(null)}><X size={18} /></button></div>
            <div className="ww-popover-list">
              {contacts.map((c) => (<button type="button" key={c.id} onClick={() => forwardTo('direct', c)}><span className="ww-mini-avatar">{initialOf(c.username)}</span>@{c.username}</button>))}
              {groups.map((g) => (<button type="button" key={g.id} onClick={() => forwardTo('group', g)}><span className="ww-mini-avatar">{initialOf(g.name)}</span>{g.name}</button>))}
              {!contacts.length && !groups.length && <p className="ww-popover-empty">Add friends or a group first.</p>}
            </div>
          </div>
        </div>
      )}

      {/* Group call picker */}
      {activePopover === 'groupCallPicker' && (
        <div className="ww-attach-sheet-overlay" onClick={() => setActivePopover(null)}>
          <div className="ww-forward-sheet" onClick={(e) => e.stopPropagation()}>
            <div className="ww-popover-header"><h3>{callPickerGroupId ? 'Start group call' : 'New group call'}</h3><button type="button" onClick={() => setActivePopover(null)}><X size={18} /></button></div>
            <p className="ww-call-picker-hint">Pick up to {MAX_GROUP_CALL_PARTICIPANTS - 1} people ({callPickerSelection.length}/{MAX_GROUP_CALL_PARTICIPANTS - 1} selected)</p>
            <div className="ww-popover-list">
              {callPickerContacts.map((c) => (
                <label key={c.id} className="ww-call-pick-row">
                  <input type="checkbox" checked={callPickerSelection.includes(c.id)} disabled={!callPickerSelection.includes(c.id) && callPickerSelection.length >= MAX_GROUP_CALL_PARTICIPANTS - 1} onChange={() => toggleCallPick(c.id)} />
                  <span className="ww-mini-avatar">{initialOf(c.username)}</span>@{c.username}
                </label>
              ))}
              {!callPickerContacts.length && <p className="ww-popover-empty">No one available to call here yet.</p>}
            </div>
            <button type="button" className="ww-start-call-btn" disabled={!callPickerSelection.length} onClick={() => { startGroupCall(callPickerSelection, callPickerGroupId); setActivePopover(null); }}>
              <Video size={16} /> Start call ({callPickerSelection.length + 1})
            </button>
          </div>
        </div>
      )}

      {/* Group call invite */}
      {groupCallInvite && (
        <div className="ww-call-modal">
          <span className="ww-info-avatar small">{initialOf(groupCallInvite.from.username)}</span>
          <p>@{groupCallInvite.from.username} started a group call{groupCallInvite.groupId ? ` in ${groups.find((g) => g.id === groupCallInvite.groupId)?.name || 'a group'}` : ''} ({groupCallInvite.participantIds.length} people)</p>
          <div className="ww-call-actions">
            <button type="button" className="accept" onClick={acceptGroupCallInvite}><Video size={16} /> Join</button>
            <button type="button" className="decline" onClick={declineGroupCallInvite}><PhoneOff size={16} /> Decline</button>
          </div>
        </div>
      )}

      {/* Active group call */}
      {groupCall && (
        <div className="ww-call-modal video group">
          <p>Group call{groupCall.groupId ? ` · ${groups.find((g) => g.id === groupCall.groupId)?.name || ''}` : ''} ({groupCallParticipants.length + 1}/{MAX_GROUP_CALL_PARTICIPANTS})</p>
          <div className="ww-group-video-grid">
            <div className="ww-group-video-tile"><video ref={localGroupVideoRef} autoPlay muted playsInline /><span className="ww-group-video-label">You</span></div>
            {groupCallParticipants.map((p) => (
              <div key={p.userId} className="ww-group-video-tile">
                <video autoPlay playsInline ref={(el) => { if (el && el.srcObject !== p.stream) el.srcObject = p.stream; }} />
                <span className="ww-group-video-label">@{p.username}</span>
              </div>
            ))}
          </div>
          <div className="ww-call-controls">
            <button type="button" className={`ww-call-control-btn ${isGroupMicMuted ? 'off' : ''}`} onClick={toggleGroupMic}>{isGroupMicMuted ? <MicOff size={18} /> : <Mic size={18} />}</button>
            <button type="button" className={`ww-call-control-btn ${isGroupCameraOff ? 'off' : ''}`} onClick={toggleGroupCamera}>{isGroupCameraOff ? <VideoOff size={18} /> : <Video size={18} />}</button>
            <button type="button" className={`ww-call-control-btn ${groupCallHook.isGroupScreenSharing ? 'active' : ''}`} title={groupCallHook.isGroupScreenSharing ? 'Stop sharing' : 'Share screen'} onClick={() => groupCallHook.toggleGroupScreenShare()}><Share2 size={18} /></button>
            <button type="button" className="decline" onClick={leaveGroupCall}><PhoneOff size={16} /> Leave call</button>
          </div>
        </div>
      )}

      {/* Incoming 1:1 call */}
      {incomingCall && (
        <div className="ww-incoming-call-modal">
          <div className="ww-incoming-call-type">
            {incomingCall.callType === 'audio'
              ? <><Phone size={14} /> Voice call</>
              : <><Video size={14} /> Video call</>}
          </div>
          <span className="ww-call-avatar">{initialOf(incomingCall.from?.name || incomingCall.from?.username)}</span>
          <p className="ww-call-caller-name">{incomingCall.from?.name || incomingCall.from?.username}</p>
          <p className="ww-call-status-text">Incoming {incomingCall.callType === 'audio' ? 'voice' : 'video'} call…</p>
          <div className="ww-incoming-call-actions">
            <button type="button" className="ww-call-btn decline" onClick={() => { stopRingtone(); declineCall(); }}>
              <PhoneOff size={22} />
              <span>Decline</span>
            </button>
            <button type="button" className="ww-call-btn accept" onClick={() => { stopRingtone(); acceptCall(); }}>
              <Phone size={22} />
              <span>Accept</span>
            </button>
          </div>
        </div>
      )}

      {/* Active 1:1 call */}
      {activeCall && (() => {
        const isVoice = activeCall.audioOnly && !switchedToVideo;
        const callerName = activeCall.name || activeCall.username;
        const connState = directCall.connectionState;
        const statusLabel = connState === 'connected' || connState === 'completed'
          ? formatDuration(callDuration)
          : connState === 'checking' ? 'Connecting…'
          : 'Ringing…';

        return (
          <div className={`ww-active-call-modal ${isVoice ? 'voice' : 'video'} ${callMinimized ? 'minimized' : ''}`}>
            {callMinimized ? (
              /* ---- Floating PiP (minimized) ---- */
              <div className="ww-call-pip" onClick={() => setCallMinimized(false)}>
                <span className="ww-call-pip-avatar">{initialOf(callerName)}</span>
                <span className="ww-call-pip-info">
                  <strong>{callerName}</strong>
                  <span>{statusLabel}</span>
                </span>
                <button type="button" className="ww-call-pip-end" onClick={(e) => { e.stopPropagation(); closeCall(true); }}>
                  <PhoneOff size={16} />
                </button>
              </div>
            ) : isVoice ? (
              /* ---- Voice call screen ---- */
              <>
                <div className="ww-voice-call-topbar">
                  <button type="button" className="ww-call-topbar-btn" title="Minimize" onClick={() => setCallMinimized(true)}>
                    <ChevronDown size={22} />
                  </button>
                  <button type="button" className="ww-call-topbar-btn" title="Add participant" onClick={() => { const pid = directCall.addPersonToCall(); if (pid) openCallPicker(contacts.filter((c) => c.id !== pid).map((c) => ({ id: c.id, username: c.username })), null); }}>
                    <UserPlus size={20} />
                  </button>
                </div>

                <div className="ww-voice-call-body">
                  <div className="ww-voice-avatar-ring">
                    <span className="ww-voice-avatar">{initialOf(callerName)}</span>
                  </div>
                  <p className="ww-voice-caller-name">{callerName}</p>
                  <p className={`ww-voice-status ${connState === 'connected' || connState === 'completed' ? 'connected' : 'ringing'}`}>
                    {statusLabel}
                  </p>
                </div>

                <div className="ww-voice-call-controls">
                  <button type="button" className={`ww-vc-btn ${isMicMuted ? 'off' : ''}`} onClick={toggleMic}>
                    {isMicMuted ? <MicOff size={24} /> : <Mic size={24} />}
                    <span>{isMicMuted ? 'Unmute' : 'Mute'}</span>
                  </button>
                  <button type="button" className={`ww-vc-btn ${speakerOn ? 'on' : ''}`} onClick={() => setSpeakerOn((p) => !p)}>
                    <Headphones size={24} />
                    <span>Speaker</span>
                  </button>
                  <button type="button" className="ww-vc-btn" title="Switch to video" onClick={escalateToVideo}>
                    <Video size={24} />
                    <span>Video</span>
                  </button>
                  <button type="button" className="ww-vc-btn end-call" onClick={() => closeCall(true)}>
                    <PhoneOff size={24} />
                    <span>End</span>
                  </button>
                </div>
              </>
            ) : (
              /* ---- Video call screen ---- */
              <>
                <div className="ww-voice-call-topbar">
                  <button type="button" className="ww-call-topbar-btn" title="Minimize" onClick={() => setCallMinimized(true)}>
                    <ChevronDown size={22} />
                  </button>
                  <span className="ww-video-call-name">{callerName} · {statusLabel}</span>
                  <button type="button" className="ww-call-topbar-btn" title="Add participant" onClick={() => { const pid = directCall.addPersonToCall(); if (pid) openCallPicker(contacts.filter((c) => c.id !== pid).map((c) => ({ id: c.id, username: c.username })), null); }}>
                    <UserPlus size={20} />
                  </button>
                </div>
                <div className="ww-video-grid">
                  <video ref={localVideoRef} autoPlay muted playsInline />
                  <video ref={remoteVideoRef} autoPlay playsInline />
                </div>
                <div className="ww-call-controls">
                  <button type="button" className={`ww-call-control-btn ${isMicMuted ? 'off' : ''}`} onClick={toggleMic}>{isMicMuted ? <MicOff size={18} /> : <Mic size={18} />}</button>
                  <button type="button" className={`ww-call-control-btn ${isCameraOff ? 'off' : ''}`} onClick={toggleCamera}>{isCameraOff ? <VideoOff size={18} /> : <Video size={18} />}</button>
                  <button type="button" className={`ww-call-control-btn ${directCall.isScreenSharing ? 'active' : ''}`} title={directCall.isScreenSharing ? 'Stop sharing' : 'Share screen'} onClick={() => directCall.toggleScreenShare()}><Share2 size={18} /></button>
                  <button type="button" className="ww-call-control-btn" title="Add person to call" onClick={() => { const pid = directCall.addPersonToCall(); if (pid) openCallPicker(contacts.filter((c) => c.id !== pid).map((c) => ({ id: c.id, username: c.username })), null); }}><UserPlus size={18} /></button>
                  <button type="button" className="decline" onClick={() => closeCall(true)}><PhoneOff size={16} /> End call</button>
                </div>
              </>
            )}
          </div>
        );
      })()}

      {/* Logout confirm */}
      {confirmLogout && (
        <div className="ww-call-modal">
          <p>Log out of ChatApp?</p>
          <div className="ww-call-actions">
            <button type="button" className="decline" onClick={logout}><LogOut size={16} /> Log out</button>
            <button type="button" className="accept" onClick={() => setConfirmLogout(false)}>Cancel</button>
          </div>
        </div>
      )}

      {/* Bulk action bar */}
      {bulkSelectMode && (
        <div className="ww-bulk-action-bar">
          <span>{selectedChatKeys.size} selected</span>
          <button type="button" onClick={bulkArchiveSelected} disabled={!selectedChatKeys.size}>Archive</button>
          <button type="button" onClick={bulkMarkReadSelected} disabled={!selectedChatKeys.size}>Mark read</button>
          <button type="button" onClick={() => { setBulkSelectMode(false); setSelectedChatKeys(new Set()); }}>Cancel</button>
        </div>
      )}

      {/* Starred messages panel */}
      {showStarredPanel && (
        <div className="ww-attach-sheet-overlay" onClick={() => setShowStarredPanel(false)}>
          <div className="ww-forward-sheet" onClick={(e) => e.stopPropagation()}>
            <div className="ww-popover-header"><h3>Starred messages</h3><button type="button" onClick={() => setShowStarredPanel(false)}><X size={18} /></button></div>
            <div className="ww-popover-list">
              {starredMessages.map((item) => (
                <button type="button" key={item.id} onClick={() => {
                  selectChat(item.isGroup ? 'group' : 'direct', item.isGroup
                    ? groups.find((g) => g.id === item.groupId) || { id: item.groupId, name: 'Group' }
                    : contacts.find((c) => c.id === (item.senderId === user.id ? item.recipientId : item.senderId)) || { id: item.senderId === user.id ? item.recipientId : item.senderId, username: item.user || 'Unknown' });
                  setShowStarredPanel(false);
                }}>
                  <span className="ww-mini-avatar">{initialOf(item.isGroup ? groups.find((g) => g.id === item.groupId)?.name : item.user)}</span>
                  <span><strong>{item.isGroup ? (groups.find((g) => g.id === item.groupId)?.name || 'Group') : `@${item.user}`}</strong><br /><small>{previewFor(item)}</small></span>
                </button>
              ))}
              {!starredMessages.length && <p className="ww-popover-empty">No starred messages yet.</p>}
            </div>
          </div>
        </div>
      )}

      {/* Archived chats panel */}
      {showArchivedPanel && (
        <div className="ww-attach-sheet-overlay" onClick={() => setShowArchivedPanel(false)}>
          <div className="ww-forward-sheet" onClick={(e) => e.stopPropagation()}>
            <div className="ww-popover-header"><h3>Archived chats</h3><button type="button" onClick={() => setShowArchivedPanel(false)}><X size={18} /></button></div>
            <div className="ww-popover-list">
              {[...conversations.filter((c) => archivedChats[chatKeyFor('direct', c.id)]), ...groups.filter((g) => archivedChats[chatKeyFor('group', g.id)])].map((item) => {
                const isGroup = !!item.members;
                return (
                  <div key={item.id} className="ww-archived-row">
                    <button type="button" onClick={() => { selectChat(isGroup ? 'group' : 'direct', item); setShowArchivedPanel(false); }}><span className="ww-mini-avatar">{initialOf(isGroup ? item.name : item.username)}</span>{isGroup ? item.name : `@${item.username}`}</button>
                    <button type="button" onClick={() => toggleArchive(isGroup ? 'group' : 'direct', item.id)}>Unarchive</button>
                  </div>
                );
              })}
              {!Object.keys(archivedChats).length && <p className="ww-popover-empty">No archived chats.</p>}
            </div>
          </div>
        </div>
      )}

      {/* App lock modal */}
      {appLockModal && (
        <div className="ww-call-modal">
          <p>{appLockModal === 'setup' ? 'Set a 4-6 digit PIN' : 'Enter your PIN to turn off App Lock'}</p>
          <input type="password" inputMode="numeric" maxLength={6} value={pinInput} onChange={(e) => { setPinInput(e.target.value.replace(/\D/g, '')); setPinError(''); }} placeholder="PIN" />
          {pinError && <p className="ww-auth-error" style={{ position: 'static' }}>{pinError}</p>}
          <div className="ww-call-actions">
            <button type="button" className="accept" disabled={pinInput.length < 4} onClick={() => appLockModal === 'setup' ? setupAppLock(pinInput) : disableAppLock(pinInput)}>{appLockModal === 'setup' ? 'Set PIN' : 'Turn off'}</button>
            <button type="button" className="decline" onClick={() => { setAppLockModal(null); setPinInput(''); setPinError(''); }}>Cancel</button>
          </div>
        </div>
      )}

      {/* Lock screen */}
      {isLocked && (
        <div className="ww-lock-screen">
          <Lock size={40} />
          <p>Enter your PIN to unlock</p>
          <input type="password" inputMode="numeric" maxLength={6} value={pinInput} autoFocus onChange={(e) => { setPinInput(e.target.value.replace(/\D/g, '')); setPinError(''); }} onKeyDown={(e) => e.key === 'Enter' && unlockApp(pinInput)} />
          {pinError && <p className="ww-auth-error" style={{ position: 'static' }}>{pinError}</p>}
          <button type="button" className="accept" onClick={() => unlockApp(pinInput)}>Unlock</button>
        </div>
      )}

      {/* Status viewer modal */}
      {viewingStatus && (() => {
        const item = viewingStatus.items[viewingStatus.index];
        if (!item) { setViewingStatus(null); return null; }
        return (
          <div className="ww-status-viewer-overlay" onClick={() => setViewingStatus(null)}>
            <div className="ww-status-viewer" style={{ background: item.bgColor }} onClick={(e) => e.stopPropagation()}>
              <div className="ww-status-viewer-header">
                <span className="ww-avatar">{initialOf(viewingStatus.name)}</span>
                <span className="ww-status-viewer-name">
                  <strong>{viewingStatus.name}</strong>
                  <span>{new Date(item.createdAt).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}</span>
                </span>
                <button type="button" className="ww-status-viewer-close" onClick={() => setViewingStatus(null)}><X size={20} /></button>
              </div>
              {/* Progress bar dots */}
              <div className="ww-status-progress">
                {viewingStatus.items.map((_, i) => (
                  <div key={i} className={`ww-status-progress-seg ${i === viewingStatus.index ? 'active' : i < viewingStatus.index ? 'done' : ''}`} />
                ))}
              </div>
              <div className="ww-status-viewer-text">{item.text}</div>
              {/* Prev / Next */}
              <div className="ww-status-viewer-nav">
                <button type="button" disabled={viewingStatus.index === 0}
                  onClick={() => viewStatus(viewingStatus, viewingStatus.index - 1)}>‹</button>
                <button type="button" disabled={viewingStatus.index === viewingStatus.items.length - 1}
                  onClick={() => viewStatus(viewingStatus, viewingStatus.index + 1)}>›</button>
              </div>
              {viewingStatus.isMe && (
                <div className="ww-status-viewer-footer">
                  <Eye size={14} /> {item.viewCount} {item.viewCount === 1 ? 'view' : 'views'}
                </div>
              )}
            </div>
          </div>
        );
      })()}

      {/* Call settings modal */}
      {showCallSettings && (
        <div className="ww-attach-sheet-overlay" onClick={() => setShowCallSettings(false)}>
          <div className="ww-poll-modal" onClick={(e) => e.stopPropagation()}>
            <div className="ww-popover-header">
              <h3><Phone size={16} /> Call Settings</h3>
              <button type="button" onClick={() => setShowCallSettings(false)}><X size={18} /></button>
            </div>
            <div className="ww-poll-modal-body">
              <div className="ww-call-settings-row">
                <div>
                  <strong>Ringtone</strong>
                  <p>Two-tone ringtone (default)</p>
                </div>
                <span className="ww-call-settings-badge">Default</span>
              </div>
              <div className="ww-call-settings-row">
                <div>
                  <strong>Call notifications</strong>
                  <p>Show incoming call alerts</p>
                </div>
                <input type="checkbox" defaultChecked style={{ width: 16, height: 16, accentColor: '#25d366', cursor: 'pointer' }} />
              </div>
              <div className="ww-call-settings-row">
                <div>
                  <strong>Noise suppression</strong>
                  <p>Reduce background noise</p>
                </div>
                <input type="checkbox" defaultChecked style={{ width: 16, height: 16, accentColor: '#25d366', cursor: 'pointer' }} />
              </div>
              <div className="ww-call-settings-row">
                <div>
                  <strong>Default call type</strong>
                  <p>When calling from contact card</p>
                </div>
                <select className="ww-call-settings-select">
                  <option value="audio">Voice</option>
                  <option value="video">Video</option>
                </select>
              </div>
            </div>
            <div className="ww-poll-modal-footer">
              <button type="button" className="ww-poll-send-btn" onClick={() => setShowCallSettings(false)}>Done</button>
            </div>
          </div>
        </div>
      )}

      {/* Camera capture modal */}      {showCameraModal && (
        <div className="ww-camera-modal-overlay" onClick={closeCamera}>
          <div className="ww-camera-modal" onClick={(e) => e.stopPropagation()}>
            <div className="ww-camera-modal-header">
              <span>Take a photo</span>
              <button type="button" onClick={closeCamera}><X size={18} /></button>
            </div>
            <video ref={cameraVideoRef} autoPlay playsInline className="ww-camera-preview" />
            <div className="ww-camera-modal-actions">
              <button type="button" className="ww-camera-cancel-btn" onClick={closeCamera}>Cancel</button>
              <button type="button" className="ww-camera-capture-btn" onClick={capturePhoto}>
                <Camera size={20} /> Capture &amp; Send
              </button>
            </div>
          </div>
        </div>
      )}

      {/* Poll creation modal */}      {showPollModal && (
        <div className="ww-attach-sheet-overlay" onClick={() => setShowPollModal(false)}>
          <div className="ww-poll-modal" onClick={(e) => e.stopPropagation()}>
            <div className="ww-popover-header">
              <h3>📊 Create Poll</h3>
              <button type="button" onClick={() => setShowPollModal(false)}><X size={18} /></button>
            </div>
            <div className="ww-poll-modal-body">
              <div className="ww-poll-field">
                <label>Question</label>
                <input
                  type="text"
                  placeholder="Ask a question…"
                  value={pollQuestion}
                  maxLength={200}
                  onChange={(e) => setPollQuestion(e.target.value)}
                  autoFocus
                />
              </div>
              <div className="ww-poll-field">
                <label>Options</label>
                {pollOptions.map((opt, idx) => (
                  <div key={idx} className="ww-poll-option-row">
                    <input
                      type="text"
                      placeholder={`Option ${idx + 1}`}
                      value={opt}
                      maxLength={100}
                      onChange={(e) => updatePollOption(idx, e.target.value)}
                    />
                    {pollOptions.length > 2 && (
                      <button type="button" className="ww-poll-remove-btn" onClick={() => removePollOption(idx)}><X size={14} /></button>
                    )}
                  </div>
                ))}
                {pollOptions.length < 10 && (
                  <button type="button" className="ww-poll-add-option-btn" onClick={addPollOption}>
                    + Add option
                  </button>
                )}
              </div>
              <label className="ww-poll-multiple-row">
                <input
                  type="checkbox"
                  checked={pollAllowMultiple}
                  onChange={(e) => setPollAllowMultiple(e.target.checked)}
                />
                Allow multiple answers
              </label>
            </div>
            <div className="ww-poll-modal-footer">
              <button type="button" className="ww-poll-cancel-btn" onClick={() => setShowPollModal(false)}>Cancel</button>
              <button
                type="button"
                className="ww-poll-send-btn"
                disabled={!pollQuestion.trim() || pollOptions.filter((o) => o.trim()).length < 2}
                onClick={sendPoll}
              >
                Send Poll
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
};

export default ChatApp;
