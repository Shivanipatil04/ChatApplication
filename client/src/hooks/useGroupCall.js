import { useCallback, useEffect, useRef, useState } from 'react';

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

/**
 * Owns the group (mesh) call: one RTCPeerConnection per remote participant, invite/join/leave,
 * mid-call invites, screen sharing across every peer, and per-peer ICE-restart reconnect.
 *
 * @param {import('socket.io-client').Socket|null} socket
 * @param {{ id: string }} user
 * @param {{ onCallFinished?: () => void, onError?: (message: string) => void }} [options]
 *   onError fires when the server rejects an invite/join (full call, not a member, blocked, etc.)
 *   — wire it up if you want to surface that message to the user; it's optional.
 */
export function useGroupCall(socket, user, { onCallFinished, onError } = {}) {
  const [groupCallInvite, setGroupCallInvite] = useState(null);
  const [groupCall, setGroupCall] = useState(null); // { callId, groupId }
  const [groupCallParticipants, setGroupCallParticipants] = useState([]); // [{ userId, username, stream }]
  const [localGroupStream, setLocalGroupStream] = useState(null);
  const [isGroupMicMuted, setIsGroupMicMuted] = useState(false);
  const [isGroupCameraOff, setIsGroupCameraOff] = useState(false);
  const [isGroupScreenSharing, setIsGroupScreenSharing] = useState(false);

  const groupPeersRef = useRef({}); // remoteUserId -> RTCPeerConnection
  const groupCallIdRef = useRef(null);
  const localGroupStreamRef = useRef(null);
  const cameraTrackRef = useRef(null);
  const screenTrackRef = useRef(null);
  const reconnectAttemptedRef = useRef({}); // remoteUserId -> bool, so we don't spam restartIce()

  useEffect(() => { localGroupStreamRef.current = localGroupStream; }, [localGroupStream]);

  const attemptReconnectPeer = useCallback(async (remoteUserId, peer) => {
    if (reconnectAttemptedRef.current[remoteUserId]) return;
    reconnectAttemptedRef.current[remoteUserId] = true;
    try {
      if (typeof peer.restartIce === 'function') peer.restartIce();
      const offer = await peer.createOffer({ iceRestart: true });
      await peer.setLocalDescription(offer);
      socket?.emit('group-call-signal', {
        callId: groupCallIdRef.current,
        targetUserId: remoteUserId,
        data: { type: 'offer', sdp: offer },
      });
    } catch (err) {
      console.error('[group-call] reconnect attempt failed:', err);
    }
  }, [socket]);

  const ensureGroupPeerConnection = useCallback((remoteUserId) => {
    if (groupPeersRef.current[remoteUserId]) return groupPeersRef.current[remoteUserId];

    const peer = new RTCPeerConnection(RTC_CONFIGURATION);

    peer.onicecandidate = ({ candidate }) => {
      if (candidate) {
        socket?.emit('group-call-signal', {
          callId: groupCallIdRef.current,
          targetUserId: remoteUserId,
          data: { type: 'candidate', candidate },
        });
      }
    };

    peer.oniceconnectionstatechange = () => {
      if (peer.iceConnectionState === 'connected' || peer.iceConnectionState === 'completed') {
        reconnectAttemptedRef.current[remoteUserId] = false;
      }
      if (peer.iceConnectionState === 'failed') attemptReconnectPeer(remoteUserId, peer);
    };

    peer.ontrack = (event) => {
      const remoteStream = event.streams && event.streams[0];
      setGroupCallParticipants((previous) => previous.map((p) => (p.userId === remoteUserId ? { ...p, stream: remoteStream } : p)));
    };

    groupPeersRef.current[remoteUserId] = peer;
    return peer;
  }, [socket, attemptReconnectPeer]);

  // Deterministic glare-avoidance: whoever has the lexicographically smaller userId always
  // sends the offer, so two peers never both try to initiate the same connection at once.
  const connectToGroupParticipant = useCallback(async (remoteUserId, stream) => {
    const peer = ensureGroupPeerConnection(remoteUserId);
    stream.getTracks().forEach((track) => {
      if (!peer.getSenders().some((sender) => sender.track === track)) peer.addTrack(track, stream);
    });
    if (user.id < remoteUserId) {
      try {
        const offer = await peer.createOffer();
        await peer.setLocalDescription(offer);
        socket?.emit('group-call-signal', {
          callId: groupCallIdRef.current,
          targetUserId: remoteUserId,
          data: { type: 'offer', sdp: offer },
        });
      } catch (err) {
        console.error('[group-call] error creating offer:', err);
      }
    }
  }, [ensureGroupPeerConnection, socket, user.id]);

  const teardownGroupCall = useCallback(() => {
    Object.values(groupPeersRef.current).forEach((peer) => { try { peer.close(); } catch { /* ignore */ } });
    groupPeersRef.current = {};
    reconnectAttemptedRef.current = {};
    localGroupStreamRef.current?.getTracks().forEach((track) => track.stop());
    screenTrackRef.current?.stop();
    screenTrackRef.current = null;
    cameraTrackRef.current = null;
    localGroupStreamRef.current = null;
    setLocalGroupStream(null);
    setIsGroupMicMuted(false);
    setIsGroupCameraOff(false);
    setIsGroupScreenSharing(false);
    groupCallIdRef.current = null;
    setGroupCall(null);
    setGroupCallParticipants([]);
  }, []);

  const startGroupCall = useCallback(async (targetUserIds, groupId = null) => {
    if (!targetUserIds.length) return;
    try {
      const stream = await navigator.mediaDevices.getUserMedia({ video: true, audio: true });
      cameraTrackRef.current = stream.getVideoTracks()[0] || null;
      const callId = `${user.id}-${Date.now()}`;
      localGroupStreamRef.current = stream;
      setLocalGroupStream(stream);
      groupCallIdRef.current = callId;
      setGroupCall({ callId, groupId });
      setGroupCallParticipants([]);
      socket?.emit('group-call-invite', { callId, targetUserIds, groupId, callType: 'video' });
    } catch {
      throw new Error('Camera or microphone access is required to start a group call.');
    }
  }, [socket, user.id]);

  // 🔴 FIX: previously, if getUserMedia failed here, we just cleared the invite and threw —
  // the host was never told we couldn't join, so they'd see us as "still invited" until the
  // whole call ended, and we'd be wrongly counted toward the participant cap in the meantime.
  const acceptGroupCallInvite = useCallback(async () => {
    if (!groupCallInvite) return;
    const { callId } = groupCallInvite;
    try {
      const stream = await navigator.mediaDevices.getUserMedia({ video: true, audio: true });
      cameraTrackRef.current = stream.getVideoTracks()[0] || null;
      const { groupId } = groupCallInvite;
      localGroupStreamRef.current = stream;
      setLocalGroupStream(stream);
      groupCallIdRef.current = callId;
      setGroupCall({ callId, groupId });
      setGroupCallParticipants([]);
      setGroupCallInvite(null);
      socket?.emit('group-call-join', { callId });
    } catch {
      socket?.emit('group-call-decline', { callId }); // let the host know we couldn't join
      setGroupCallInvite(null);
      throw new Error('Camera or microphone access is required to join this call.');
    }
  }, [groupCallInvite, socket]);

  const declineGroupCallInvite = useCallback(() => {
    if (groupCallInvite) socket?.emit('group-call-decline', { callId: groupCallInvite.callId });
    setGroupCallInvite(null);
  }, [groupCallInvite, socket]);

  const leaveGroupCall = useCallback(() => {
    if (groupCallIdRef.current) socket?.emit('group-call-leave', { callId: groupCallIdRef.current });
    teardownGroupCall();
    onCallFinished?.();
  }, [socket, teardownGroupCall, onCallFinished]);

  // Invite more people into a call that's already running — the server just expands the
  // invite set on the existing call; new joiners follow the normal join flow below.
  const inviteMoreToGroupCall = useCallback((targetUserIds) => {
    if (!groupCallIdRef.current || !targetUserIds?.length) return;
    socket?.emit('group-call-invite-more', { callId: groupCallIdRef.current, targetUserIds });
  }, [socket]);

  const toggleGroupMic = useCallback(() => {
    const stream = localGroupStreamRef.current;
    if (!stream) return;
    setIsGroupMicMuted((prev) => {
      const next = !prev;
      stream.getAudioTracks().forEach((track) => { track.enabled = !next; });
      return next;
    });
  }, []);

  const toggleGroupCamera = useCallback(() => {
    const stream = localGroupStreamRef.current;
    if (!stream) return;
    setIsGroupCameraOff((prev) => {
      const next = !prev;
      stream.getVideoTracks().forEach((track) => { track.enabled = !next; });
      return next;
    });
  }, []);

  const stopGroupScreenShare = useCallback(() => {
    const camTrack = cameraTrackRef.current;
    Object.values(groupPeersRef.current).forEach((peer) => {
      const sender = peer.getSenders().find((s) => s.track && s.track.kind === 'video');
      if (sender && camTrack) sender.replaceTrack(camTrack).catch(() => {});
    });
    screenTrackRef.current?.stop();
    screenTrackRef.current = null;
    setIsGroupScreenSharing(false);
  }, []);

  const toggleGroupScreenShare = useCallback(async () => {
    if (isGroupScreenSharing) { stopGroupScreenShare(); return; }
    try {
      const screenStream = await navigator.mediaDevices.getDisplayMedia({ video: true });
      const screenTrack = screenStream.getVideoTracks()[0];
      Object.values(groupPeersRef.current).forEach((peer) => {
        const sender = peer.getSenders().find((s) => s.track && s.track.kind === 'video');
        sender?.replaceTrack(screenTrack).catch(() => {});
      });
      screenTrack.onended = () => stopGroupScreenShare();
      screenTrackRef.current = screenTrack;
      setIsGroupScreenSharing(true);
    } catch {
      // user cancelled the screen picker
    }
  }, [isGroupScreenSharing, stopGroupScreenShare]);

  useEffect(() => {
    if (!socket) return;

    const handleInvite = (payload) => setGroupCallInvite(payload);

    // 🔴 FIX: this used to be a complete no-op. The server sends `group-call-error` when an
    // invite/join is rejected (call full, not a member, blocked, etc.) — but by the time that
    // arrives, startGroupCall()/acceptGroupCallInvite() has ALREADY turned the camera on and set
    // groupCall/localGroupStream optimistically. With the no-op handler, the UI was stuck showing
    // an "active" call — camera running, modal open — for a call that doesn't exist server-side,
    // with no way out except manually hitting "Leave call" (which itself does nothing useful,
    // since the server has no record of this call to leave). We now actually tear down local
    // state and, if the caller provided one, forward the message via onError.
    const handleError = ({ message } = {}) => {
      teardownGroupCall();
      setGroupCallInvite(null);
      onError?.(message || 'Could not join the group call.');
    };

    const handleState = ({ callId, participants }) => {
      if (callId !== groupCallIdRef.current) return;
      setGroupCallParticipants(participants.map((p) => ({ ...p, stream: null })));
      const stream = localGroupStreamRef.current;
      if (stream) participants.forEach((p) => connectToGroupParticipant(p.userId, stream));
    };

    const handleParticipantJoined = ({ callId, userId: joinedId, username: joinedUsername }) => {
      if (callId !== groupCallIdRef.current || joinedId === user.id) return;
      setGroupCallParticipants((previous) => (
        previous.some((p) => p.userId === joinedId) ? previous : [...previous, { userId: joinedId, username: joinedUsername, stream: null }]
      ));
      const stream = localGroupStreamRef.current;
      if (stream) connectToGroupParticipant(joinedId, stream);
    };

    const handleParticipantLeft = ({ callId, userId: leftId }) => {
      if (callId !== groupCallIdRef.current) return;
      groupPeersRef.current[leftId]?.close();
      delete groupPeersRef.current[leftId];
      delete reconnectAttemptedRef.current[leftId];
      setGroupCallParticipants((previous) => previous.filter((p) => p.userId !== leftId));
    };

    const handleSignal = async ({ callId, fromUserId, data }) => {
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
          socket.emit('group-call-signal', { callId, targetUserId: fromUserId, data: { type: 'answer', sdp: answer } });
        } else if (data.type === 'answer') {
          await peer.setRemoteDescription(new RTCSessionDescription(data.sdp));
        } else if (data.type === 'candidate') {
          await peer.addIceCandidate(new RTCIceCandidate(data.candidate));
        }
      } catch (err) {
        console.error('[group-call] signaling error:', err);
      }
    };

    socket.on('group-call-invite', handleInvite);
    socket.on('group-call-error', handleError);
    socket.on('group-call-state', handleState);
    socket.on('group-call-participant-joined', handleParticipantJoined);
    socket.on('group-call-participant-left', handleParticipantLeft);
    socket.on('group-call-signal', handleSignal);

    return () => {
      socket.off('group-call-invite', handleInvite);
      socket.off('group-call-error', handleError);
      socket.off('group-call-state', handleState);
      socket.off('group-call-participant-joined', handleParticipantJoined);
      socket.off('group-call-participant-left', handleParticipantLeft);
      socket.off('group-call-signal', handleSignal);
    };
  }, [socket, user.id, ensureGroupPeerConnection, connectToGroupParticipant, teardownGroupCall, onError]);

  useEffect(() => () => teardownGroupCall(), []); // eslint-disable-line react-hooks/exhaustive-deps

  return {
    groupCallInvite, groupCall, groupCallParticipants, localGroupStream,
    isGroupMicMuted, isGroupCameraOff, isGroupScreenSharing,
    startGroupCall, acceptGroupCallInvite, declineGroupCallInvite, leaveGroupCall,
    inviteMoreToGroupCall, toggleGroupMic, toggleGroupCamera, toggleGroupScreenShare,
  };
}