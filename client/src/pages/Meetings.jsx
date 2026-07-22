import { useState, useEffect, useRef, useCallback } from 'react';
import {
  Video, VideoOff, Mic, MicOff, PhoneOff, ScreenShare, StopCircle,
  MessageSquare, Users, Hand, Smile, Lock, Unlock, Settings2, Copy,
  Plus, Calendar, ArrowLeft, Check, X, MoreVertical, UserMinus,
  VolumeX, Volume2, Share2, Shield, UserPlus,
} from 'lucide-react';
import { api } from '../config/api';
import { useSpeaking } from '../hooks/useSpeaking';
import './Meetings.css';

const REACTIONS = ['👍','👏','❤️','😂','😮','🎉'];

export default function Meetings({ socket, user, onClose }) {
  // ── Panel state ──────────────────────────────────────────────────────────
  const [view, setView] = useState('home'); // home | schedule | join | inMeeting
  const [meetings, setMeetings] = useState([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');

  // ── Schedule form ────────────────────────────────────────────────────────
  const [schedTitle, setSchedTitle] = useState('');
  const [schedDate, setSchedDate] = useState('');
  const [schedRecurring, setSchedRecurring] = useState('none');
  const [schedPasscode, setSchedPasscode] = useState('');
  const [schedWaiting, setSchedWaiting] = useState(true);
  const [schedHostOnlyInvite, setSchedHostOnlyInvite] = useState(false);

  // ── Join form ────────────────────────────────────────────────────────────
  const [joinId, setJoinId] = useState('');
  const [joinPasscode, setJoinPasscode] = useState('');
  const [joinName, setJoinName] = useState(user?.name || user?.username || '');

  // ── Active meeting ───────────────────────────────────────────────────────
  const [activeMeeting, setActiveMeeting] = useState(null);   // { meetingId, title, hostId, chatEnabled, locked, waitingRoom, myRole }
  const [participants, setParticipants] = useState([]);
  const [waitingList, setWaitingList] = useState([]);
  const [chatMessages, setChatMessages] = useState([]);
  const [chatInput, setChatInput] = useState('');
  const [showChat, setShowChat] = useState(false);
  const [showParticipants, setShowParticipants] = useState(false);
  const [handRaised, setHandRaised] = useState(false);
  const [reactionBurst, setReactionBurst] = useState(null);
  const [micMuted, setMicMuted] = useState(false);
  const [camOff, setCamOff] = useState(false);
  const [isSharing, setIsSharing] = useState(false);
  const [waitingMsg, setWaitingMsg] = useState('');

  // ── WebRTC ───────────────────────────────────────────────────────────────
  const [localStream, setLocalStream] = useState(null);
  const [remoteStreams, setRemoteStreams] = useState({}); // userId → MediaStream
  const peersRef = useRef({});
  const localStreamRef = useRef(null);
  const screenTrackRef = useRef(null);
  const localVideoRef = useRef(null);
  const chatScrollRef = useRef(null);

  const token = localStorage.getItem('chatToken');
  const authorization = token ? { headers: { Authorization: `Bearer ${token}` } } : {};

  const RTC_CONFIG = {
    iceServers: [
      { urls: 'stun:stun.l.google.com:19302' },
      { urls: ['turn:openrelay.metered.ca:80','turn:openrelay.metered.ca:443'],
        username: 'openrelayproject', credential: 'openrelayproject' },
    ],
  };

  // ── Helpers ──────────────────────────────────────────────────────────────
  const showError  = (msg) => { setError(msg);  setTimeout(() => setError(''),  4000); };
  const showNotice = (msg) => { setNotice(msg); setTimeout(() => setNotice(''), 3000); };

  const isHost = activeMeeting?.hostId === user?.id;

  // ── Active speaker detection ─────────────────────────────────────────────
  const speakingStreams = { [user?.id]: localStream, ...remoteStreams };
  const speakingIds = useSpeaking(speakingStreams);

  // ── Host-only invite toggle ──────────────────────────────────────────────
  const toggleHostOnlyInvite = () => {
    const next = !activeMeeting?.hostOnlyInvite;
    socket?.emit('meeting-set-host-only-invite', { meetingId: activeMeeting?.meetingId, hostOnlyInvite: next });
  };

  const canInvite = isHost || !activeMeeting?.hostOnlyInvite;

  // ── Load meeting list ────────────────────────────────────────────────────
  const loadMeetings = useCallback(async () => {
    setLoading(true);
    try {
      const res = await api.get('/api/meetings', authorization);
      setMeetings(res.data);
    } catch { /* silent */ }
    finally { setLoading(false); }
  }, []); // eslint-disable-line

  useEffect(() => { loadMeetings(); }, [loadMeetings]);

  // ── Attach local video ───────────────────────────────────────────────────
  // IMPORTANT: Can't rely on a useEffect here because the video element doesn't
  // exist in the DOM until view === 'inMeeting', which is set *after* the stream
  // is captured. Instead we use a callback ref that fires the instant the element
  // mounts — at which point localStreamRef.current is already populated.
  const localVideoCallbackRef = useCallback((el) => {
    localVideoRef.current = el;
    if (el && localStreamRef.current) {
      el.srcObject = localStreamRef.current;
      el.play().catch(() => {}); // autoplay policy guard
    }
  }, []); // eslint-disable-line react-hooks/exhaustive-deps

  // Also keep the effect as a fallback for when stream arrives after mount
  useEffect(() => {
    if (localVideoRef.current && localStreamRef.current) {
      localVideoRef.current.srcObject = localStreamRef.current;
    }
  }, [localStream]); // localStream state change triggers this

  // ── Auto-scroll chat ─────────────────────────────────────────────────────
  useEffect(() => {
    if (chatScrollRef.current) chatScrollRef.current.scrollTop = chatScrollRef.current.scrollHeight;
  }, [chatMessages]);

  // ── WebRTC: create peer for a remote user ────────────────────────────────
  const createPeer = useCallback((remoteId, stream) => {
    if (peersRef.current[remoteId]) return peersRef.current[remoteId];
    const peer = new RTCPeerConnection(RTC_CONFIG);
    stream.getTracks().forEach((t) => peer.addTrack(t, stream));

    peer.onicecandidate = ({ candidate }) => {
      if (candidate) socket?.emit('meeting-signal', {
        meetingId: activeMeeting?.meetingId,
        targetUserId: remoteId,
        data: { type: 'candidate', candidate },
      });
    };

    peer.ontrack = (e) => {
      const rs = e.streams?.[0];
      if (rs) setRemoteStreams((prev) => ({ ...prev, [remoteId]: rs }));
    };

    peersRef.current[remoteId] = peer;
    return peer;
  }, [socket, activeMeeting]); // eslint-disable-line

  const connectToPeer = useCallback(async (remoteId, stream) => {
    const peer = createPeer(remoteId, stream);
    if (user.id < remoteId) {
      const offer = await peer.createOffer();
      await peer.setLocalDescription(offer);
      socket?.emit('meeting-signal', {
        meetingId: activeMeeting?.meetingId,
        targetUserId: remoteId,
        data: { type: 'offer', sdp: offer },
      });
    }
  }, [createPeer, socket, activeMeeting, user.id]);

  const teardown = useCallback(() => {
    Object.values(peersRef.current).forEach((p) => { try { p.close(); } catch {} });
    peersRef.current = {};
    localStreamRef.current?.getTracks().forEach((t) => t.stop());
    screenTrackRef.current?.stop();
    localStreamRef.current = null;
    screenTrackRef.current = null;
    setLocalStream(null);
    setRemoteStreams({});
    setParticipants([]);
    setWaitingList([]);
    setChatMessages([]);
    setActiveMeeting(null);
    setHandRaised(false);
    setMicMuted(false);
    setCamOff(false);
    setIsSharing(false);
    setWaitingMsg('');
    setView('home');
  }, []);

  // ── Socket event listeners ───────────────────────────────────────────────
  useEffect(() => {
    if (!socket) return;

    const onJoined = async ({ meetingId, title, hostId, locked, chatEnabled, waitingRoom, hostOnlyInvite, participants: others, myRole }) => {
      setActiveMeeting({ meetingId, title, hostId, locked, chatEnabled, waitingRoom, hostOnlyInvite: hostOnlyInvite || false, myRole });
      setParticipants(others);
      setWaitingMsg('');
      setView('inMeeting');
      // Connect to all existing participants
      const stream = localStreamRef.current;
      if (stream) others.forEach((p) => connectToPeer(p.userId, stream));
    };

    const onWaiting = ({ message }) => setWaitingMsg(message);
    const onAdmitted = ({ meetingId }) => socket.emit('meeting-join-admitted', { meetingId });
    const onDenied = ({ message }) => { showError(message || 'You were not admitted.'); setWaitingMsg(''); setView('join'); };
    const onEnded = () => { showError('The host ended this meeting.'); teardown(); };
    const onRemoved = () => { showError('You were removed from the meeting.'); teardown(); };

    const onParticipantJoined = async ({ participant }) => {
      setParticipants((prev) => prev.some((p) => p.userId === participant.userId) ? prev : [...prev, participant]);
      const stream = localStreamRef.current;
      if (stream) connectToPeer(participant.userId, stream);
    };

    const onParticipantLeft = ({ userId: uid }) => {
      setParticipants((prev) => prev.filter((p) => p.userId !== uid));
      peersRef.current[uid]?.close();
      delete peersRef.current[uid];
      setRemoteStreams((prev) => { const n = { ...prev }; delete n[uid]; return n; });
    };

    const onUpdated = (data) => setActiveMeeting((prev) => prev ? { ...prev, ...data } : prev);
    const onParticipantUpdated = ({ userId: uid, micMuted: mm }) =>
      setParticipants((prev) => prev.map((p) => p.userId === uid ? { ...p, micMuted: mm } : p));

    const onMutedByHost = ({ mute }) => {
      setMicMuted(mute);
      localStreamRef.current?.getAudioTracks().forEach((t) => { t.enabled = !mute; });
      if (mute) showNotice('The host muted your microphone.');
    };

    const onWaitingUpdate = ({ waiting }) => setWaitingList(waiting);

    const onChat = (msg) => setChatMessages((prev) => [...prev, msg]);

    const onHandRaised = ({ userId: uid, raised, name }) => {
      if (uid !== user.id) showNotice(`${name || uid} ${raised ? '✋ raised hand' : 'lowered hand'}`);
    };

    const onReaction = ({ userId: uid, emoji }) => {
      setReactionBurst({ uid, emoji, key: Date.now() });
      setTimeout(() => setReactionBurst(null), 2000);
    };

    const onSignal = async ({ fromUserId, data }) => {
      const stream = localStreamRef.current;
      if (!stream) return;
      const peer = createPeer(fromUserId, stream);
      if (data.type === 'offer') {
        await peer.setRemoteDescription(new RTCSessionDescription(data.sdp));
        stream.getTracks().forEach((t) => { if (!peer.getSenders().some((s) => s.track === t)) peer.addTrack(t, stream); });
        const answer = await peer.createAnswer();
        await peer.setLocalDescription(answer);
        socket.emit('meeting-signal', { meetingId: activeMeeting?.meetingId, targetUserId: fromUserId, data: { type: 'answer', sdp: answer } });
      } else if (data.type === 'answer') {
        await peer.setRemoteDescription(new RTCSessionDescription(data.sdp));
      } else if (data.type === 'candidate') {
        await peer.addIceCandidate(new RTCIceCandidate(data.candidate));
      }
    };

    socket.on('meeting-joined',              onJoined);
    socket.on('meeting-waiting',             onWaiting);
    socket.on('meeting-admitted',            onAdmitted);
    socket.on('meeting-denied',              onDenied);
    socket.on('meeting-ended',               onEnded);
    socket.on('meeting-removed',             onRemoved);
    socket.on('meeting-participant-joined',  onParticipantJoined);
    socket.on('meeting-participant-left',    onParticipantLeft);
    socket.on('meeting-updated',             onUpdated);
    socket.on('meeting-participant-updated', onParticipantUpdated);
    socket.on('meeting-muted-by-host',       onMutedByHost);
    socket.on('meeting-waiting-update',      onWaitingUpdate);
    socket.on('meeting-chat',                onChat);
    socket.on('meeting-hand-raised',         onHandRaised);
    socket.on('meeting-reaction',            onReaction);
    socket.on('meeting-signal',              onSignal);
    socket.on('meeting-error',               ({ message }) => showError(message));

    return () => {
      socket.off('meeting-joined',              onJoined);
      socket.off('meeting-waiting',             onWaiting);
      socket.off('meeting-admitted',            onAdmitted);
      socket.off('meeting-denied',              onDenied);
      socket.off('meeting-ended',               onEnded);
      socket.off('meeting-removed',             onRemoved);
      socket.off('meeting-participant-joined',  onParticipantJoined);
      socket.off('meeting-participant-left',    onParticipantLeft);
      socket.off('meeting-updated',             onUpdated);
      socket.off('meeting-participant-updated', onParticipantUpdated);
      socket.off('meeting-muted-by-host',       onMutedByHost);
      socket.off('meeting-waiting-update',      onWaitingUpdate);
      socket.off('meeting-chat',                onChat);
      socket.off('meeting-hand-raised',         onHandRaised);
      socket.off('meeting-reaction',            onReaction);
      socket.off('meeting-signal',              onSignal);
      socket.off('meeting-error',               ({ message }) => showError(message));
    };
  }, [socket, user.id, connectToPeer, createPeer, teardown, activeMeeting?.meetingId]); // eslint-disable-line

  // ── Actions ──────────────────────────────────────────────────────────────
  const startMedia = async () => {
    try {
      const stream = await navigator.mediaDevices.getUserMedia({ video: true, audio: true });
      localStreamRef.current = stream;
      setLocalStream(stream);
      return stream;
    } catch (err) {
      const msg = err?.name === 'NotAllowedError' || err?.name === 'PermissionDeniedError'
        ? 'Camera/microphone permission was denied. Please allow access in your browser settings and try again.'
        : err?.name === 'NotFoundError'
        ? 'No camera or microphone found on this device.'
        : `Could not access camera: ${err?.message || err?.name || 'Unknown error'}`;
      showError(msg);
      throw err;
    }
  };

  const startInstant = async () => {
    try {
      const stream = await startMedia();
      const res = await api.post('/api/meetings', { title: `${user.name || user.username}'s Meeting`, waitingRoom: false }, authorization);
      const { meetingId } = res.data;
      await loadMeetings();
      socket?.emit('meeting-join', { meetingId, passcode: '', name: user.name || user.username });
    } catch (e) { showError(e?.response?.data?.message || 'Could not start meeting.'); }
  };

  const scheduleMeeting = async (e) => {
    e.preventDefault();
    try {
      await api.post('/api/meetings', {
        title: schedTitle || 'My Meeting',
        scheduledAt: schedDate || null,
        recurring: schedRecurring,
        passcode: schedPasscode,
        waitingRoom: schedWaiting,
        hostOnlyInvite: schedHostOnlyInvite,
      }, authorization);
      setSchedTitle(''); setSchedDate(''); setSchedPasscode('');
      setSchedRecurring('none'); setSchedWaiting(true); setSchedHostOnlyInvite(false);
      showNotice('Meeting scheduled!');
      await loadMeetings();
      setView('home');
    } catch (e) { showError(e?.response?.data?.message || 'Could not schedule.'); }
  };

  const joinMeeting = async (e) => {
    e?.preventDefault();
    const id = joinId.trim();
    if (!id) { showError('Enter a Meeting ID.'); return; }
    try {
      await startMedia();
      socket?.emit('meeting-join', { meetingId: id, passcode: joinPasscode.trim(), name: joinName.trim() || user.name });
    } catch { showError('Camera / microphone access is required to join a meeting.'); }
  };

  const joinFromList = async (meetingId) => {
    try {
      await startMedia();
      socket?.emit('meeting-join', { meetingId, passcode: '', name: user.name || user.username });
    } catch { showError('Camera / microphone access is required.'); }
  };

  const leaveMeeting = () => {
    socket?.emit('meeting-leave', { meetingId: activeMeeting?.meetingId });
    teardown();
  };

  const endMeeting = async () => {
    try { await api.delete(`/api/meetings/${activeMeeting?.meetingId}`, authorization); } catch {}
    teardown();
  };

  const toggleMic = () => {
    localStreamRef.current?.getAudioTracks().forEach((t) => { t.enabled = micMuted; });
    setMicMuted((p) => !p);
  };

  const toggleCam = () => {
    const tracks = localStreamRef.current?.getVideoTracks();
    if (!tracks?.length) return;
    const next = camOff; // if currently off, next state is on
    tracks.forEach((t) => { t.enabled = next; });
    setCamOff(!next);
    // When turning camera back on the tile remounts — callback ref handles re-attach
  };

  const toggleScreenShare = async () => {
    if (isSharing) {
      screenTrackRef.current?.stop();
      const camTrack = localStreamRef.current?.getVideoTracks()[0];
      Object.values(peersRef.current).forEach((p) => {
        const s = p.getSenders().find((s) => s.track?.kind === 'video');
        if (s && camTrack) s.replaceTrack(camTrack);
      });
      screenTrackRef.current = null;
      setIsSharing(false);
    } else {
      try {
        const ss = await navigator.mediaDevices.getDisplayMedia({ video: true });
        const screenTrack = ss.getVideoTracks()[0];
        Object.values(peersRef.current).forEach((p) => {
          const s = p.getSenders().find((s) => s.track?.kind === 'video');
          if (s) s.replaceTrack(screenTrack);
        });
        screenTrack.onended = () => toggleScreenShare();
        screenTrackRef.current = screenTrack;
        setIsSharing(true);
      } catch {}
    }
  };

  const sendChat = (e) => {
    e.preventDefault();
    if (!chatInput.trim()) return;
    socket?.emit('meeting-chat', { meetingId: activeMeeting?.meetingId, message: chatInput.trim() });
    setChatInput('');
  };

  const toggleHand = () => {
    const raised = !handRaised;
    setHandRaised(raised);
    socket?.emit('meeting-raise-hand', { meetingId: activeMeeting?.meetingId, raised });
  };

  const sendReaction = (emoji) => {
    socket?.emit('meeting-reaction', { meetingId: activeMeeting?.meetingId, emoji });
  };

  const copyMeetingId = (id) => {
    navigator.clipboard?.writeText(id).then(() => showNotice('Meeting ID copied!'));
  };

  const hostMute = (uid) => socket?.emit('meeting-host-mute', { meetingId: activeMeeting?.meetingId, targetUserId: uid, mute: true });
  const hostMuteAll = () => socket?.emit('meeting-mute-all', { meetingId: activeMeeting?.meetingId });
  const hostRemove = (uid) => socket?.emit('meeting-remove-participant', { meetingId: activeMeeting?.meetingId, targetUserId: uid });
  const admitUser = (uid) => socket?.emit('meeting-admit', { meetingId: activeMeeting?.meetingId, targetUserId: uid });
  const denyUser  = (uid) => socket?.emit('meeting-deny',  { meetingId: activeMeeting?.meetingId, targetUserId: uid });
  const toggleLock = () => socket?.emit('meeting-set-lock', { meetingId: activeMeeting?.meetingId, locked: !activeMeeting?.locked });

  // ── Remote video tile ─────────────────────────────────────────────────────
  function RemoteTile({ participant }) {
    const ref = useRef(null);
    const stream = remoteStreams[participant.userId];
    useEffect(() => { if (ref.current && stream) ref.current.srcObject = stream; }, [stream]);
    const initials = (participant.name || participant.username || '?').charAt(0).toUpperCase();
    const isSpeaking = speakingIds.has(participant.userId);
    return (
      <div className={`mt-tile ${isSpeaking ? 'speaking' : ''}`}>
        {stream ? <video ref={ref} autoPlay playsInline className="mt-tile-video" /> : (
          <div className="mt-tile-avatar">{initials}</div>
        )}
        <div className="mt-tile-name">
          {participant.name || participant.username}
          {participant.micMuted && <MicOff size={12} className="mt-tile-muted" />}
          {participant.role === 'host' && <Shield size={12} className="mt-tile-host" />}
        </div>
      </div>
    );
  }

  // ── In-meeting layout ─────────────────────────────────────────────────────
  if (view === 'inMeeting') {
    const allParticipants = [
      { userId: user.id, name: user.name || user.username, username: user.username, role: activeMeeting?.myRole, micMuted, camOff, isMe: true },
      ...participants,
    ];
    return (
      <div className="mt-shell">
        {/* Top bar */}
        <div className="mt-topbar">
          <div className="mt-topbar-left">
            <span className="mt-title">{activeMeeting?.title}</span>
            <span className="mt-id" onClick={() => copyMeetingId(activeMeeting?.meetingId)} title="Copy ID">
              {activeMeeting?.meetingId} <Copy size={12} />
            </span>
          </div>
          <div className="mt-topbar-right">
            {isHost && (
              <button type="button" className={`mt-icon-btn ${activeMeeting?.locked ? 'active' : ''}`} title={activeMeeting?.locked ? 'Unlock meeting' : 'Lock meeting'} onClick={toggleLock}>
                {activeMeeting?.locked ? <Lock size={18} /> : <Unlock size={18} />}
              </button>
            )}
            {isHost && (
              <button
                type="button"
                className={`mt-icon-btn ${activeMeeting?.hostOnlyInvite ? 'active' : ''}`}
                title={activeMeeting?.hostOnlyInvite ? 'Anyone can invite (click to restrict)' : 'Only host can invite (click to allow all)'}
                onClick={toggleHostOnlyInvite}
              >
                <UserPlus size={18} />
              </button>
            )}
            <button type="button" className={`mt-icon-btn ${showParticipants ? 'active' : ''}`} onClick={() => { setShowParticipants((p) => !p); setShowChat(false); }}>
              <Users size={18} /> <span>{allParticipants.length}</span>
            </button>
            <button type="button" className={`mt-icon-btn ${showChat ? 'active' : ''}`} onClick={() => { setShowChat((p) => !p); setShowParticipants(false); }}>
              <MessageSquare size={18} />
            </button>
          </div>
        </div>

        {/* Waiting room banner for host */}
        {isHost && waitingList.length > 0 && (
          <div className="mt-waiting-banner">
            <span>{waitingList.length} participant{waitingList.length > 1 ? 's' : ''} waiting</span>
            {waitingList.map((w) => (
              <span key={w.userId} className="mt-waiting-person">
                {w.name || w.username}
                <button type="button" className="mt-admit-btn" onClick={() => admitUser(w.userId)}>Admit</button>
                <button type="button" className="mt-deny-btn" onClick={() => denyUser(w.userId)}>Deny</button>
              </span>
            ))}
          </div>
        )}

        {/* Reaction burst */}
        {reactionBurst && (
          <div className="mt-reaction-burst" key={reactionBurst.key}>{reactionBurst.emoji}</div>
        )}

        {/* Main area */}
        <div className="mt-main">
          {/* Video grid */}
          <div className={`mt-grid mt-grid-${Math.min(allParticipants.length, 4)}`}>
            {/* Local tile */}
            <div className={`mt-tile mt-tile-local ${speakingIds.has(user.id) ? 'speaking' : ''}`}>
              {!camOff
                ? <video ref={localVideoCallbackRef} autoPlay muted playsInline className="mt-tile-video" />
                : <div className="mt-tile-avatar">{(user.name || user.username || '?').charAt(0).toUpperCase()}</div>
              }
              <div className="mt-tile-name">You {micMuted && <MicOff size={12} />}</div>
            </div>
            {participants.map((p) => <RemoteTile key={p.userId} participant={p} />)}
          </div>

          {/* Side panel: Participants */}
          {showParticipants && (
            <div className="mt-side-panel">
              <div className="mt-side-header">
                <span>Participants ({allParticipants.length})</span>
                <div style={{ display: 'flex', alignItems: 'center', gap: '6px' }}>
                  {isHost && (
                    <button type="button" className="mt-mute-all-btn" title="Mute all" onClick={hostMuteAll}>
                      <VolumeX size={15} /> Mute all
                    </button>
                  )}
                  <button type="button" onClick={() => setShowParticipants(false)}><X size={16} /></button>
                </div>
              </div>
              <div className="mt-side-body">
                {allParticipants.map((p) => (
                  <div key={p.userId} className="mt-participant-row">
                    <span className="mt-participant-avatar">{(p.name || p.username || '?').charAt(0).toUpperCase()}</span>
                    <span className="mt-participant-name">{p.name || p.username}{p.isMe ? ' (You)' : ''}</span>
                    {p.micMuted && <MicOff size={13} className="mt-icon-muted" />}
                    {p.role === 'host' && <Shield size={13} className="mt-icon-host" />}
                    {isHost && !p.isMe && (
                      <div className="mt-host-actions">
                        <button type="button" title="Mute" onClick={() => hostMute(p.userId)}><VolumeX size={14} /></button>
                        <button type="button" title="Remove" onClick={() => hostRemove(p.userId)}><UserMinus size={14} /></button>
                      </div>
                    )}
                  </div>
                ))}
              </div>
            </div>
          )}

          {/* Side panel: Chat */}
          {showChat && (
            <div className="mt-side-panel">
              <div className="mt-side-header"><span>In-meeting chat</span><button type="button" onClick={() => setShowChat(false)}><X size={16} /></button></div>
              <div className="mt-chat-messages" ref={chatScrollRef}>
                {chatMessages.map((m, i) => (
                  <div key={i} className={`mt-chat-msg ${m.from.userId === user.id ? 'me' : ''}`}>
                    <span className="mt-chat-sender">{m.from.name || m.from.username}</span>
                    <span className="mt-chat-text">{m.message}</span>
                  </div>
                ))}
                {!chatMessages.length && <p className="mt-chat-empty">No messages yet.</p>}
              </div>
              <form className="mt-chat-form" onSubmit={sendChat}>
                <input value={chatInput} onChange={(e) => setChatInput(e.target.value)} placeholder="Message everyone…" maxLength={500} />
                <button type="submit" disabled={!chatInput.trim()}><Share2 size={16} /></button>
              </form>
            </div>
          )}
        </div>

        {/* Controls bar */}
        <div className="mt-controls">
          <button type="button" className={`mt-ctrl-btn ${micMuted ? 'off' : ''}`} onClick={toggleMic}>
            {micMuted ? <MicOff size={22} /> : <Mic size={22} />}
            <span>{micMuted ? 'Unmute' : 'Mute'}</span>
          </button>
          <button type="button" className={`mt-ctrl-btn ${camOff ? 'off' : ''}`} onClick={toggleCam}>
            {camOff ? <VideoOff size={22} /> : <Video size={22} />}
            <span>{camOff ? 'Start video' : 'Stop video'}</span>
          </button>
          <button type="button" className={`mt-ctrl-btn ${isSharing ? 'active' : ''}`} onClick={toggleScreenShare}>
            {isSharing ? <StopCircle size={22} /> : <ScreenShare size={22} />}
            <span>{isSharing ? 'Stop share' : 'Share screen'}</span>
          </button>
          <button type="button" className={`mt-ctrl-btn ${handRaised ? 'active' : ''}`} onClick={toggleHand}>
            <Hand size={22} />
            <span>{handRaised ? 'Lower hand' : 'Raise hand'}</span>
          </button>
          {/* Reactions */}
          <div className="mt-reactions-wrap">
            <button type="button" className="mt-ctrl-btn"><Smile size={22} /><span>React</span></button>
            <div className="mt-reactions-popup">
              {REACTIONS.map((emoji) => (
                <button key={emoji} type="button" onClick={() => sendReaction(emoji)}>{emoji}</button>
              ))}
            </div>
          </div>
          <button type="button" className="mt-ctrl-btn mt-end-btn" onClick={isHost ? endMeeting : leaveMeeting}>
            <PhoneOff size={22} />
            <span>{isHost ? 'End' : 'Leave'}</span>
          </button>
        </div>

        {/* Waiting msg (shown while in waiting room) */}
        {waitingMsg && (
          <div className="mt-waiting-overlay">
            <div className="mt-waiting-card">
              <div className="mt-waiting-spinner" />
              <p>{waitingMsg}</p>
              <button type="button" onClick={() => { setWaitingMsg(''); setView('home'); }}>Cancel</button>
            </div>
          </div>
        )}
      </div>
    );
  }

  // ── Home / Schedule / Join views ─────────────────────────────────────────
  return (
    <div className="mt-panel">
      {/* Header */}
      <div className="mt-panel-header">
        {view !== 'home' ? (
          <button type="button" className="mt-back-btn" onClick={() => setView('home')}><ArrowLeft size={18} /></button>
        ) : (
          <button type="button" className="mt-back-btn" onClick={onClose}><ArrowLeft size={18} /></button>
        )}
        <h2>{view === 'schedule' ? 'Schedule Meeting' : view === 'join' ? 'Join Meeting' : 'Meetings'}</h2>
      </div>

      {error  && <div className="mt-error">{error}</div>}
      {notice && <div className="mt-notice">{notice}</div>}

      {/* HOME */}
      {view === 'home' && (
        <div className="mt-home">
          <div className="mt-quick-actions">
            <button type="button" className="mt-action-btn primary" onClick={startInstant}>
              <Video size={22} /> New Meeting
            </button>
            <button type="button" className="mt-action-btn" onClick={() => setView('join')}>
              <Plus size={22} /> Join
            </button>
            <button type="button" className="mt-action-btn" onClick={() => setView('schedule')}>
              <Calendar size={22} /> Schedule
            </button>
          </div>

          <div className="mt-section-label">Upcoming &amp; Recent</div>
          {loading && <p className="mt-empty">Loading…</p>}
          {!loading && meetings.length === 0 && <p className="mt-empty">No meetings yet. Start or schedule one above.</p>}
          {meetings.map((m) => (
            <div key={m.id} className="mt-meeting-row">
              <div className="mt-meeting-info">
                <strong>{m.title}</strong>
                <span className="mt-meeting-meta">
                  {m.meetingId}
                  {m.scheduledAt && ` · ${new Date(m.scheduledAt).toLocaleString([], { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' })}`}
                  {m.recurring !== 'none' && ` · ${m.recurring}`}
                </span>
              </div>
              <div className="mt-meeting-actions">
                <button type="button" className="mt-copy-btn" onClick={() => copyMeetingId(m.meetingId)} title="Copy ID"><Copy size={14} /></button>
                <button type="button" className="mt-start-btn" onClick={() => joinFromList(m.meetingId)}>
                  {m.hostId === user.id ? 'Start' : 'Join'}
                </button>
              </div>
            </div>
          ))}
        </div>
      )}

      {/* SCHEDULE */}
      {view === 'schedule' && (
        <form className="mt-form" onSubmit={scheduleMeeting}>
          <label>Meeting title
            <input value={schedTitle} onChange={(e) => setSchedTitle(e.target.value)} placeholder="My Meeting" maxLength={80} />
          </label>
          <label>Date &amp; time
            <input type="datetime-local" value={schedDate} onChange={(e) => setSchedDate(e.target.value)} />
          </label>
          <label>Recurring
            <select value={schedRecurring} onChange={(e) => setSchedRecurring(e.target.value)}>
              <option value="none">Does not repeat</option>
              <option value="daily">Daily</option>
              <option value="weekly">Weekly</option>
              <option value="monthly">Monthly</option>
            </select>
          </label>
          <label>Passcode (optional)
            <input value={schedPasscode} onChange={(e) => setSchedPasscode(e.target.value)} placeholder="6-digit code" maxLength={10} />
          </label>
          <label className="mt-checkbox-label">
            <input type="checkbox" checked={schedWaiting} onChange={(e) => setSchedWaiting(e.target.checked)} />
            Enable waiting room
          </label>
          <label className="mt-checkbox-label">
            <input type="checkbox" checked={schedHostOnlyInvite} onChange={(e) => setSchedHostOnlyInvite(e.target.checked)} />
            Only host can add participants
          </label>
          <button type="submit" className="mt-submit-btn">Schedule</button>
        </form>
      )}

      {/* JOIN */}
      {view === 'join' && (
        <form className="mt-form" onSubmit={joinMeeting}>
          <label>Meeting ID
            <input value={joinId} onChange={(e) => setJoinId(e.target.value)} placeholder="abc-1234-xyz" required />
          </label>
          <label>Your name
            <input value={joinName} onChange={(e) => setJoinName(e.target.value)} placeholder="Display name" />
          </label>
          <label>Passcode (if required)
            <input value={joinPasscode} onChange={(e) => setJoinPasscode(e.target.value)} placeholder="Passcode" />
          </label>
          {waitingMsg && <p className="mt-waiting-text">{waitingMsg}</p>}
          <button type="submit" className="mt-submit-btn">Join Meeting</button>
        </form>
      )}
    </div>
  );
}
