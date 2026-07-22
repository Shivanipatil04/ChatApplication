import { useCallback, useEffect, useRef, useState } from 'react';

const RTC_CONFIGURATION = {
  iceServers: [
    // Multiple STUN servers for redundancy
    { urls: 'stun:stun.l.google.com:19302' },
    { urls: 'stun:stun1.l.google.com:19302' },
    { urls: 'stun:stun2.l.google.com:19302' },
    { urls: 'stun:stun3.l.google.com:19302' },
    // Metered free TURN (more reliable endpoints)
    {
      urls: [
        'turn:openrelay.metered.ca:80',
        'turn:openrelay.metered.ca:443',
        'turns:openrelay.metered.ca:443', // TLS — works through strict firewalls
        'turn:openrelay.metered.ca:443?transport=tcp',
      ],
      username: 'openrelayproject',
      credential: 'openrelayproject',
    },
  ],
  iceCandidatePoolSize: 10,   // pre-gather candidates before call starts
  bundlePolicy: 'max-bundle', // bundle audio+video on one transport — fewer ports needed
  rtcpMuxPolicy: 'require',   // multiplex RTCP with RTP — reduces open ports
};

/**
 * Owns everything about a single 1:1 video call: signaling, media state, mute/camera,
 * screen sharing, and ICE-restart reconnect when the network blips.
 *
 * @param {import('socket.io-client').Socket|null} socket
 * @param {{ id: string }} user
 * @param {{ onCallFinished?: () => void }} [options] onCallFinished fires after any call ends
 *   (answered, declined, or hung up) — wire it to refresh call history in the parent.
 */
export function useDirectCall(socket, user, { onCallFinished } = {}) {
  const [incomingCall, setIncomingCall] = useState(null);
  const [activeCall, setActiveCall] = useState(null);
  const [localStream, setLocalStream] = useState(null);
  const [remoteStream, setRemoteStream] = useState(null);
  const [isMicMuted, setIsMicMuted] = useState(false);
  const [isCameraOff, setIsCameraOff] = useState(false);
  const [isScreenSharing, setIsScreenSharing] = useState(false);
  const [connectionState, setConnectionState] = useState('new'); // RTCPeerConnection.iceConnectionState

  const peerConnectionRef = useRef(null);
  const callTargetRef = useRef(null);
  const queuedCandidatesRef = useRef([]);
  const localStreamRef = useRef(null);
  const cameraTrackRef = useRef(null); // kept aside so screen share can hand the camera back
  const screenTrackRef = useRef(null);
  const reconnectAttemptedRef = useRef(false);
  // Keep the pending invite's caller id around even after `incomingCall` is cleared,
  // so a getUserMedia failure in acceptCall() can still notify them we couldn't join.
  const incomingCallerIdRef = useRef(null);

  useEffect(() => {
    incomingCallerIdRef.current = incomingCall?.from?.id || null;
  }, [incomingCall]);

  const closeCall = useCallback((notify = true) => {
    if (notify && callTargetRef.current) socket?.emit('call-end', { targetUserId: callTargetRef.current });
    peerConnectionRef.current?.close();
    peerConnectionRef.current = null;
    localStreamRef.current?.getTracks().forEach((track) => track.stop());
    screenTrackRef.current?.stop();
    screenTrackRef.current = null;
    cameraTrackRef.current = null;
    setLocalStream(null);
    setRemoteStream(null);
    setActiveCall(null);
    setIncomingCall(null);
    setIsMicMuted(false);
    setIsCameraOff(false);
    setIsScreenSharing(false);
    setConnectionState('new');
    callTargetRef.current = null;
    queuedCandidatesRef.current = [];
    reconnectAttemptedRef.current = false;
  }, [socket]);

  const attemptReconnect = useCallback(async () => {
    const peer = peerConnectionRef.current;
    const targetId = callTargetRef.current;
    if (!peer || !targetId || reconnectAttemptedRef.current) return;
    reconnectAttemptedRef.current = true;
    try {
      if (typeof peer.restartIce === 'function') peer.restartIce();
      const offer = await peer.createOffer({ iceRestart: true });
      await peer.setLocalDescription(offer);
      socket?.emit('renegotiate-offer', { targetUserId: targetId, offer });
    } catch (err) {
      console.error('[webrtc] reconnect attempt failed:', err);
    }
  }, [socket]);

  const createPeerConnection = useCallback((targetUserId, stream) => {
    const peer = new RTCPeerConnection(RTC_CONFIGURATION);
    callTargetRef.current = targetUserId;

    const tracks = stream.getTracks();
    console.log('[webrtc] createPeerConnection — tracks being added:', tracks.map((t) => `${t.kind} (enabled=${t.enabled}, muted=${t.muted})`));
    tracks.forEach((track) => peer.addTrack(track, stream));

    peer.onicecandidate = ({ candidate }) => {
      if (candidate) {
        console.log('[webrtc] local ICE candidate:', candidate.type, candidate.protocol, candidate.address);
        socket?.emit('ice-candidate', { targetUserId, candidate });
      } else {
        console.log('[webrtc] ICE gathering complete');
      }
    };

    peer.oniceconnectionstatechange = () => {
      console.log('[webrtc] iceConnectionState →', peer.iceConnectionState);
      setConnectionState(peer.iceConnectionState);
      if (peer.iceConnectionState === 'connected' || peer.iceConnectionState === 'completed') {
        reconnectAttemptedRef.current = false;
        console.log('[webrtc] ✅ ICE connected — media should be flowing');
      }
      if (peer.iceConnectionState === 'failed') {
        console.warn('[webrtc] ❌ ICE failed — attempting restart');
        attemptReconnect();
      }
      if (peer.iceConnectionState === 'disconnected') {
        console.warn('[webrtc] ⚠️ ICE disconnected — may recover automatically');
      }
    };

    peer.onicegatheringstatechange = () => {
      console.log('[webrtc] iceGatheringState →', peer.iceGatheringState);
    };

    peer.onsignalingstatechange = () => {
      console.log('[webrtc] signalingState →', peer.signalingState);
    };

    peer.ontrack = (event) => {
      console.log('[webrtc] ✅ ontrack fired — kind:', event.track.kind, '| streams:', event.streams.length, '| track enabled:', event.track.enabled, '| track muted:', event.track.muted);
      const remote = event.streams && event.streams[0];
      if (remote) {
        console.log('[webrtc] remote stream tracks:', remote.getTracks().map((t) => `${t.kind} enabled=${t.enabled}`));
        setRemoteStream(remote);
      } else {
        console.warn('[webrtc] ontrack fired but event.streams[0] is undefined — attaching track directly');
        // Fallback: build a stream from the track directly
        const fallbackStream = new MediaStream([event.track]);
        setRemoteStream(fallbackStream);
      }
    };

    peerConnectionRef.current = peer;
    return peer;
  }, [socket, attemptReconnect]);

  const addQueuedCandidates = useCallback(async () => {
    const peer = peerConnectionRef.current;
    if (!peer) return;
    for (const candidate of queuedCandidatesRef.current) {
      try { await peer.addIceCandidate(new RTCIceCandidate(candidate)); } catch (err) { console.error('[webrtc] error adding queued candidate:', err); }
    }
    queuedCandidatesRef.current = [];
  }, []);

  const startCall = useCallback(async (target, audioOnly = false) => {
    if (!target) return;
    try {
      const constraints = audioOnly ? { video: false, audio: true } : { video: true, audio: true };
      console.log('[webrtc] startCall — requesting getUserMedia', constraints);
      const stream = await navigator.mediaDevices.getUserMedia(constraints);
      console.log('[webrtc] getUserMedia granted — tracks:', stream.getTracks().map((t) => `${t.kind} enabled=${t.enabled}`));
      cameraTrackRef.current = audioOnly ? null : (stream.getVideoTracks()[0] || null);
      localStreamRef.current = stream;
      setLocalStream(stream);
      setActiveCall({ ...target, audioOnly });
      const peer = createPeerConnection(target.id, stream);
      const offer = await peer.createOffer();
      console.log('[webrtc] offer SDP (first 300 chars):', offer.sdp?.substring(0, 300));
      await peer.setLocalDescription(offer);
      socket?.emit('call-user', { targetUserId: target.id, offer, callType: audioOnly ? 'audio' : 'video' });
      console.log('[webrtc] call-user emitted to', target.id);
    } catch (err) {
      console.error('[webrtc] startCall error:', err);
      closeCall(false);
      throw new Error(audioOnly
        ? 'Microphone access is required to start a voice call.'
        : 'Camera or microphone access is required to start a video call.');
    }
  }, [socket, createPeerConnection, closeCall]);

  // 🔴 FIX: the server's `incoming-call` payload is { from: { id, username }, offer, callType }.
  // There is no `.contact` field on it — `incomingCall.contact` was always undefined, which
  // crashed the ringing modal in ChatApp.jsx (`incomingCall.contact.username` → TypeError) the
  // instant a call came in, and would have crashed here too via `setActiveCall(undefined)`.
  // We now use `incomingCall.from` directly, which is populated and has both `id` and `username`.
  //
  // 🔴 FIX #2: previously, if getUserMedia failed here (mic/camera denied or unavailable), the
  // catch block called `closeCall(true)`. But `closeCall`'s `notify` branch only fires when
  // `callTargetRef.current` is set — and that ref is only assigned inside `createPeerConnection`,
  // which we never reach because we failed before that. So the caller was NEVER told we couldn't
  // join, and was left ringing indefinitely with no feedback. We now emit `call-decline` directly
  // using the caller id captured from the invite, regardless of how far we got.
  const acceptCall = useCallback(async () => {
    if (!incomingCall) return;
    const callerId = incomingCall.from.id;
    const audioOnly = incomingCall.callType === 'audio';
    try {
      const constraints = audioOnly ? { video: false, audio: true } : { video: true, audio: true };
      console.log('[webrtc] acceptCall — requesting getUserMedia', constraints);
      const stream = await navigator.mediaDevices.getUserMedia(constraints);
      console.log('[webrtc] getUserMedia granted — tracks:', stream.getTracks().map((t) => `${t.kind} enabled=${t.enabled}`));
      cameraTrackRef.current = audioOnly ? null : (stream.getVideoTracks()[0] || null);
      localStreamRef.current = stream;
      setLocalStream(stream);
      setActiveCall({ ...incomingCall.from, audioOnly });
      const peer = createPeerConnection(incomingCall.from.id, stream);
      await peer.setRemoteDescription(new RTCSessionDescription(incomingCall.offer));
      console.log('[webrtc] remote description set from offer');
      await addQueuedCandidates();
      const answer = await peer.createAnswer();
      console.log('[webrtc] answer SDP (first 300 chars):', answer.sdp?.substring(0, 300));
      await peer.setLocalDescription(answer);
      socket?.emit('call-answer', { callerId: incomingCall.from.id, answer });
      console.log('[webrtc] call-answer emitted to', callerId);
      setIncomingCall(null);
    } catch (err) {
      console.error('[webrtc] acceptCall error:', err);
      socket?.emit('call-decline', { callerId });
      closeCall(false);
      setIncomingCall(null);
      throw new Error('Microphone access is required to answer this call.');
    }
  }, [incomingCall, socket, createPeerConnection, addQueuedCandidates, closeCall]);

  const declineCall = useCallback(() => {
    if (incomingCall) socket?.emit('call-decline', { callerId: incomingCall.from.id });
    setIncomingCall(null);
  }, [incomingCall, socket]);

  const toggleMic = useCallback(() => {
    const stream = localStreamRef.current;
    if (!stream) return;
    setIsMicMuted((prev) => {
      const next = !prev;
      stream.getAudioTracks().forEach((track) => { track.enabled = !next; });
      return next;
    });
  }, []);

  const toggleCamera = useCallback(() => {
    const stream = localStreamRef.current;
    if (!stream) return;
    setIsCameraOff((prev) => {
      const next = !prev;
      stream.getVideoTracks().forEach((track) => { track.enabled = !next; });
      return next;
    });
  }, []);

  const stopScreenShare = useCallback(() => {
    const peer = peerConnectionRef.current;
    const camTrack = cameraTrackRef.current;
    const sender = peer?.getSenders().find((s) => s.track && s.track.kind === 'video');
    if (sender && camTrack) sender.replaceTrack(camTrack).catch(() => {});
    screenTrackRef.current?.stop();
    screenTrackRef.current = null;
    setIsScreenSharing(false);
  }, []);

  const toggleScreenShare = useCallback(async () => {
    const peer = peerConnectionRef.current;
    if (!peer) return;
    if (isScreenSharing) { stopScreenShare(); return; }
    try {
      const screenStream = await navigator.mediaDevices.getDisplayMedia({ video: true });
      const screenTrack = screenStream.getVideoTracks()[0];
      const sender = peer.getSenders().find((s) => s.track && s.track.kind === 'video');
      if (sender) await sender.replaceTrack(screenTrack);
      screenTrack.onended = () => stopScreenShare(); // fires if the user stops via the browser's own UI
      screenTrackRef.current = screenTrack;
      setIsScreenSharing(true);
    } catch {
      // user cancelled the screen picker — nothing to do
    }
  }, [isScreenSharing, stopScreenShare]);

  // Hands control back to the caller: ends the 1:1 leg (notifying the other person) and returns
  // their id so the caller can kick off a fresh group call including them + the new invitee.
  const addPersonToCall = useCallback(() => {
    if (!activeCall) return null;
    const partnerId = activeCall.id;
    closeCall(true);
    return partnerId;
  }, [activeCall, closeCall]);

  useEffect(() => {
    if (!socket) return;

    const handleIncomingCall = (call) => setIncomingCall(call);

    const handleCallAnswered = async ({ answer }) => {
      try {
        if (!peerConnectionRef.current) return;
        await peerConnectionRef.current.setRemoteDescription(new RTCSessionDescription(answer));
        await addQueuedCandidates();
      } catch (err) {
        console.error('[webrtc] error handling call-answered:', err);
      }
    };

    const handleIceCandidate = async ({ candidate }) => {
      try {
        if (peerConnectionRef.current?.remoteDescription) {
          await peerConnectionRef.current.addIceCandidate(new RTCIceCandidate(candidate));
          console.log('[webrtc] remote ICE candidate added:', candidate.type, candidate.protocol);
        } else {
          console.log('[webrtc] queuing ICE candidate (no remote description yet)');
          queuedCandidatesRef.current.push(candidate);
        }
      } catch (err) {
        console.error('[webrtc] error adding remote candidate:', err);
      }
    };

    // Reconnect path: the other side sent us a fresh (ICE-restart) offer on our existing call.
    const handleRenegotiateOffer = async ({ fromUserId, offer }) => {
      const peer = peerConnectionRef.current;
      if (!peer || callTargetRef.current !== fromUserId) return;
      try {
        await peer.setRemoteDescription(new RTCSessionDescription(offer));
        const answer = await peer.createAnswer();
        await peer.setLocalDescription(answer);
        socket.emit('renegotiate-answer', { targetUserId: fromUserId, answer });
      } catch (err) {
        console.error('[webrtc] error handling renegotiate-offer:', err);
      }
    };

    const handleRenegotiateAnswer = async ({ fromUserId, answer }) => {
      const peer = peerConnectionRef.current;
      if (!peer || callTargetRef.current !== fromUserId) return;
      try {
        await peer.setRemoteDescription(new RTCSessionDescription(answer));
      } catch (err) {
        console.error('[webrtc] error handling renegotiate-answer:', err);
      }
    };

    const handleCallEnded = () => { closeCall(false); onCallFinished?.(); };

    socket.on('incoming-call', handleIncomingCall);
    socket.on('call-answered', handleCallAnswered);
    socket.on('ice-candidate', handleIceCandidate);
    socket.on('renegotiate-offer', handleRenegotiateOffer);
    socket.on('renegotiate-answer', handleRenegotiateAnswer);
    socket.on('call-ended', handleCallEnded);

    return () => {
      socket.off('incoming-call', handleIncomingCall);
      socket.off('call-answered', handleCallAnswered);
      socket.off('ice-candidate', handleIceCandidate);
      socket.off('renegotiate-offer', handleRenegotiateOffer);
      socket.off('renegotiate-answer', handleRenegotiateAnswer);
      socket.off('call-ended', handleCallEnded);
    };
  }, [socket, addQueuedCandidates, closeCall, onCallFinished]);

  useEffect(() => () => closeCall(false), []); // eslint-disable-line react-hooks/exhaustive-deps

  return {
    incomingCall, activeCall, localStream, remoteStream,
    isMicMuted, isCameraOff, isScreenSharing, connectionState,
    startCall, acceptCall, declineCall, closeCall,
    toggleMic, toggleCamera, toggleScreenShare, addPersonToCall,
  };
}