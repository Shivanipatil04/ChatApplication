import React, { useCallback, useEffect, useRef, useState } from 'react'
import axios from 'axios'
import { io } from 'socket.io-client'
import { useNavigate } from 'react-router-dom'

const API_URL = import.meta.env.VITE_API_URL || `http://${window.location.hostname || 'localhost'}:5000`;

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
  const peerConnectionRef = useRef(null);
  const selectedContactRef = useRef(null);
  const contactsRef = useRef([]);
  const navigate = useNavigate();
  const[incomingCall, setIncomingCall] = useState(null);
  const[localStream, setLocalStream] = useState(null);
  const[remoteStream, setRemoteStream] = useState(null);
  const[peerConnection, setPeerConnection] = useState(null);
  const[callStatus, setCallStatus] = useState('');
  const[socketStatus, setSocketStatus] = useState('Connecting...');

  const authorization = { headers: { Authorization: `Bearer ${token}` } };

  const stopMediaTracks = (stream) => {
    stream?.getTracks().forEach((track) => track.stop());
  };

  const setVideoRef = (video, stream) => {
    if (video && stream) {
      video.srcObject = stream;
    }
  };

  const logout = useCallback(() => {
    localStorage.removeItem('chatToken');
    localStorage.removeItem('chatUser');
    navigate('/login');
  }, [navigate]);

<<<<<<< Updated upstream
  useEffect(() => {
    selectedContactRef.current = selectedContact;
  }, [selectedContact]);
=======
  useEffect(() => { selectedRef.current = selected; }, [selected]);
  useEffect(() => { contactsRef.current = contacts; }, [contacts]);
  useEffect(() => { groupsRef.current = groups; }, [groups]);
  useEffect(() => { localStreamRef.current = localStream; if (localVideoRef.current) localVideoRef.current.srcObject = localStream; }, [localStream]);
  useEffect(() => { if (remoteVideoRef.current) remoteVideoRef.current.srcObject = remoteStream; }, [remoteStream]);

  const closeCall = useCallback((notify = true) => {

    if (notify && callTargetRef.current) {
        socketRef.current?.emit("call-end", {
            targetUserId: callTargetRef.current,
        });
    }

    if (peerConnectionRef.current) {
        peerConnectionRef.current.ontrack = null;
        peerConnectionRef.current.onicecandidate = null;
        peerConnectionRef.current.close();
        peerConnectionRef.current = null;
    }

    if (localStreamRef.current) {
        localStreamRef.current.getTracks().forEach(track => track.stop());
        localStreamRef.current = null;
    }

    if (localVideoRef.current) {
        localVideoRef.current.srcObject = null;
    }

    if (remoteVideoRef.current) {
        remoteVideoRef.current.srcObject = null;
    }

    callTargetRef.current = null;
    queuedCandidatesRef.current = [];

    setLocalStream(null);
    setRemoteStream(null);
    setIncomingCall(null);
    setActiveCall(null);

}, []);
>>>>>>> Stashed changes

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

    const socket = io(API_URL, {
      auth: { token },
      transports: ['websocket', 'polling'],
      reconnection: true,
    });

    socketRef.current = socket;

    const handleIncomingMessage = (incomingMessage) => {
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
    };

    const handleIncomingCall = ({ offer, senderId }) => {
      setIncomingCall({ senderId, offer });
      setCallStatus('Incoming call...');
    };

    const handleAnswer = async ({ answer }) => {
      const pc = peerConnectionRef.current;
      if (pc) {
        await pc.setRemoteDescription(answer);
        setCallStatus('Call connected');
      }
    };

    const handleIceCandidate = async ({ candidate }) => {
      const pc = peerConnectionRef.current;
      if (pc && candidate) {
        await pc.addIceCandidate(candidate);
      }
    };

    socket.on('connect', () => {
      setSocketStatus('Connected');
      setError('');
    });

    socket.on('connect_error', (error) => {
      console.error('Socket connect error:', error);
      setSocketStatus('Connection failed');
      setError(`Socket connection failed. URL: ${API_URL}`);
    });
<<<<<<< Updated upstream
=======
    socket.on('incoming-call', (call) => {
      const contact = contactsRef.current.find((entry) => entry.id === call.from.id) || call.from;
      setIncomingCall({ ...call, contact });
    });
    socket.on("call-answered", async ({ answer }) => {

      if (!peerConnectionRef.current) return;

      await peerConnectionRef.current.setRemoteDescription(
          new RTCSessionDescription(answer)
      );

      await addQueuedCandidates();

  });
    socket.on("ice-candidate", async ({ candidate }) => {

    try {

        if (
            peerConnectionRef.current &&
            peerConnectionRef.current.remoteDescription
        ) {

            await peerConnectionRef.current.addIceCandidate(
                new RTCIceCandidate(candidate)
            );

        } else {

            queuedCandidatesRef.current.push(candidate);

        }

    } catch (err) {

        console.error("ICE Candidate Error:", err);

    }

});
    socket.on('call-ended', () => closeCall(false));
>>>>>>> Stashed changes

    socket.on('msg', handleIncomingMessage);
    socket.on('call-user', handleIncomingCall);
    socket.on('answer-call', handleAnswer);
    socket.on('ice-candidate', handleIceCandidate);

<<<<<<< Updated upstream
    return () => socket.disconnect();
  }, [logout, token, user.id]);

  const selectContact = async (contact) => {
    setSelectedContact(contact);
=======
  const createPeerConnection = (targetUserId, stream) => {

    if (peerConnectionRef.current) {
        peerConnectionRef.current.ontrack = null;
        peerConnectionRef.current.onicecandidate = null;
        peerConnectionRef.current.close();
        peerConnectionRef.current = null;
    }

    const peer = new RTCPeerConnection(RTC_CONFIGURATION);

    callTargetRef.current = targetUserId;

    stream.getTracks().forEach(track => {
        peer.addTrack(track, stream);
    });

    peer.onicecandidate = ({ candidate }) => {
        if (candidate) {
            socketRef.current?.emit("ice-candidate", {
                targetUserId,
                candidate,
            });
        }
    };

    peer.ontrack = ({ streams }) => {
        setRemoteStream(streams[0]);
    };

    peerConnectionRef.current = peer;

    return peer;
};

  const addQueuedCandidates = async () => {

    const peer = peerConnectionRef.current;

    if (!peer) return;

    for (const candidate of queuedCandidatesRef.current) {

        try {
            await peer.addIceCandidate(
                new RTCIceCandidate(candidate)
            );
        } catch (err) {
            console.error("ICE Candidate Error:", err);
        }

    }

    queuedCandidatesRef.current = [];
};

  const startCall = async () => {

    if (activeCall) return;

    if (selected?.type !== "direct") return;

    try {

        const stream =
            await navigator.mediaDevices.getUserMedia({
                video: true,
                audio: true,
            });

        setLocalStream(stream);

        setActiveCall(selected.data);

        const peer = createPeerConnection(
            selected.data.id,
            stream
        );

        const offer = await peer.createOffer();

        await peer.setLocalDescription(offer);

        socketRef.current.emit("call-user", {
            targetUserId: selected.data.id,
            offer,
        });

    } catch {

        setError(
            "Camera or microphone access is required."
        );

        closeCall(false);

    }
};

  const acceptCall = async () => {

    if (!incomingCall) return;

    if (activeCall) return;

    try {

        const stream =
            await navigator.mediaDevices.getUserMedia({
                video: true,
                audio: true,
            });

        setLocalStream(stream);

        setActiveCall(incomingCall.contact);

        const peer = createPeerConnection(
            incomingCall.from.id,
            stream
        );

        await peer.setRemoteDescription(
            new RTCSessionDescription(
                incomingCall.offer
            )
        );

        const answer = await peer.createAnswer();

        await peer.setLocalDescription(answer);

        await addQueuedCandidates();

        socketRef.current.emit("call-answer", {
            callerId: incomingCall.from.id,
            answer,
        });

        setIncomingCall(null);

    } catch {

        setError(
            "Camera or microphone access is required."
        );

        closeCall(true);

    }
};

  const selectChat = async (type, data) => {
    setSelected({ type, data });
>>>>>>> Stashed changes
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

  const createPeerConnection = async (targetId) => {
    const pc = new RTCPeerConnection({
      iceServers: [{ urls: 'stun:stun.l.google.com:19302' }],
    });

    pc.onicecandidate = (event) => {
      if (event.candidate && targetId) {
        socketRef.current?.emit('ice-candidate', {
          recipientId: targetId,
          candidate: event.candidate,
        });
      }
    };

    pc.ontrack = (event) => {
      setRemoteStream(event.streams[0]);
    };

    peerConnectionRef.current = pc;
    setPeerConnection(pc);

    return pc;
  };

  const startVideoCall = async () => {
    if (!selectedContact) return;

    try {
      const stream = await navigator.mediaDevices.getUserMedia({
        video: true,
        audio: true,
      });

      setLocalStream(stream);

      const pc = await createPeerConnection(selectedContact.id);
      stream.getTracks().forEach((track) => pc.addTrack(track, stream));

      const offer = await pc.createOffer();
      await pc.setLocalDescription(offer);

      socketRef.current?.emit('call-user', {
        recipientId: selectedContact.id,
        offer,
      });

      setCallStatus('Calling...');
    } catch (error) {
      console.error(error);
      if (error?.name === 'NotReadableError') {
        setCallStatus('Camera or microphone is already in use. Close another app/tab and try again.');
      } else {
        setCallStatus('Could not access camera/microphone');
      }
    }
  };

  const acceptCall = async () => {
    if (!incomingCall) return;

    try {
      const stream = await navigator.mediaDevices.getUserMedia({
        video: true,
        audio: true,
      });

      setLocalStream(stream);

      const pc = await createPeerConnection(incomingCall.senderId);
      stream.getTracks().forEach((track) => pc.addTrack(track, stream));

      await pc.setRemoteDescription(incomingCall.offer);

      const answer = await pc.createAnswer();
      await pc.setLocalDescription(answer);

      socketRef.current?.emit('answer-call', {
        recipientId: incomingCall.senderId,
        answer,
      });

      setCallStatus('Call connected');
    } catch (error) {
      console.error(error);
      if (error?.name === 'NotReadableError') {
        setCallStatus('Camera or microphone is already in use. Close another app/tab and try again.');
      } else {
        setCallStatus('Could not access camera/microphone');
      }
    }
  };

  const endVideoCall = () => {
    if (peerConnectionRef.current) {
      peerConnectionRef.current.close();
    }

    stopMediaTracks(localStream);

    peerConnectionRef.current = null;
    setLocalStream(null);
    setRemoteStream(null);
    setPeerConnection(null);
    setCallStatus('');
    setIncomingCall(null);
  };

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
          <p className="call-status">Socket: {socketStatus}</p>
          <div className="chat">
            {messages.map((item) => (
              <div key={item.id} className={`message ${item.senderId === user.id ? 'me' : ''}`}>
                <div className="text">{item.msg}</div>
                <div className="time">{new Date(item.timeStamp).toLocaleTimeString()}</div>
              </div>
            ))}
          </div>

          {incomingCall && (
            <div className="call-actions">
              <p className="call-status">Incoming call...</p>
              <button type="button" onClick={acceptCall} className="video-call-button">Accept</button>
              <button type="button" onClick={endVideoCall} className="video-call-button">Decline</button>
            </div>
          )}

          {(localStream || remoteStream || incomingCall) && (
            <div className="video-panel">
              <video
                className="video-element"
                ref={(video) => setVideoRef(video, localStream)}
                autoPlay
                muted
                playsInline
              />
              <video
                className="video-element"
                ref={(video) => setVideoRef(video, remoteStream)}
                autoPlay
                playsInline
              />
            </div>
          )}

          <form className="inputbar" onSubmit={sendMessage}>
            <input
              value={message}
              onChange={(event) => setMessage(event.target.value)}
              placeholder={`Message @${selectedContact.username}`}
            />
            <button type="button" onClick={startVideoCall} className="video-call-button">
              Call
            </button>
            <button type="button" onClick={endVideoCall} className="video-call-button">
              End Call
            </button>
            <button type="submit">Send</button>
          </form>
        </> : <div className="empty-conversation">Select a person to start chatting.</div>}
        {error && <p className="auth-error">{error}</p>}
      </main>
    </div>
  )
}

export default ChatApp
