import { useEffect, useRef, useState } from 'react';

const THRESHOLD   = 12;   // RMS level (0–255) above which a participant is considered "speaking"
const POLL_MS     = 120;  // how often to sample audio levels
const SILENCE_TTL = 600;  // ms of silence before we un-highlight (avoids rapid flicker)

/**
 * Detects which stream IDs are actively speaking using Web Audio AnalyserNode.
 *
 * @param {Record<string, MediaStream | null>} streams  { id -> MediaStream }
 * @returns {Set<string>}  Set of IDs currently speaking
 *
 * Usage:
 *   const speakingIds = useSpeaking({ [user.id]: localStream, ...remoteStreams });
 *   // then in JSX: className={`tile ${speakingIds.has(p.userId) ? 'speaking' : ''}`}
 */
export function useSpeaking(streams) {
  const [speakingIds, setSpeakingIds] = useState(new Set());

  // Track per-id: { analyser, dataArray, lastAboveThreshold }
  const analysersRef  = useRef({});
  const timerRef      = useRef(null);
  const streamsRef    = useRef(streams);

  // Keep ref in sync so the interval closure always sees latest streams
  useEffect(() => { streamsRef.current = streams; });

  useEffect(() => {
    let ctx;

    const getOrCreate = (id, stream) => {
      if (analysersRef.current[id]) return analysersRef.current[id];
      if (!stream) return null;
      try {
        if (!ctx) ctx = new (window.AudioContext || window.webkitAudioContext)();
        const source   = ctx.createMediaStreamSource(stream);
        const analyser = ctx.createAnalyser();
        analyser.fftSize = 512;
        source.connect(analyser);
        const dataArray = new Uint8Array(analyser.frequencyBinCount);
        const entry = { analyser, dataArray, lastAbove: 0, source };
        analysersRef.current[id] = entry;
        return entry;
      } catch {
        return null;
      }
    };

    const getRMS = (entry) => {
      entry.analyser.getByteTimeDomainData(entry.dataArray);
      let sum = 0;
      for (let i = 0; i < entry.dataArray.length; i++) {
        const v = entry.dataArray[i] - 128;
        sum += v * v;
      }
      return Math.sqrt(sum / entry.dataArray.length);
    };

    const poll = () => {
      const now  = Date.now();
      const cur  = streamsRef.current;
      const next = new Set();

      // Clean up analysers for ids that are no longer in streams
      Object.keys(analysersRef.current).forEach((id) => {
        if (!cur[id]) {
          try { analysersRef.current[id].source.disconnect(); } catch {}
          delete analysersRef.current[id];
        }
      });

      Object.entries(cur).forEach(([id, stream]) => {
        if (!stream) return;
        const entry = getOrCreate(id, stream);
        if (!entry) return;
        const rms = getRMS(entry);
        if (rms > THRESHOLD) entry.lastAbove = now;
        if (now - entry.lastAbove < SILENCE_TTL) next.add(id);
      });

      setSpeakingIds((prev) => {
        // Only trigger re-render if the set actually changed
        if (prev.size === next.size && [...prev].every((id) => next.has(id))) return prev;
        return next;
      });
    };

    timerRef.current = setInterval(poll, POLL_MS);

    return () => {
      clearInterval(timerRef.current);
      // Disconnect all analysers
      Object.values(analysersRef.current).forEach((e) => {
        try { e.source.disconnect(); } catch {}
      });
      analysersRef.current = {};
      try { ctx?.close(); } catch {}
    };
  }, []); // eslint-disable-line react-hooks/exhaustive-deps

  return speakingIds;
}
