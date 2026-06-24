// src/hooks/useLiveSession.ts — the live voice-session lifecycle, extracted VERBATIM out of
// src/App.tsx (bead dbt4 — App.tsx decomposition, mirroring the DBT5 server.ts strangler-fig).
//
// Owns the WebSocket + Web-Audio capture/playback graph and the connect/start/stop/cleanup +
// auto-reconnect lifecycle. This is irreducibly browser-coupled (WebSocket / AudioContext /
// navigator.mediaDevices), so it lives behind a thin params seam: the caller (App) supplies the
// live-state setters, the active-pane ref, and an `onWsMessage(msg, playbackCtx)` callback that
// routes each frame through the existing dispatchWsMessage table. The pure decision pieces it
// delegates to (disposeRefs / planReconnect) are unit-pinned in tests/test_use_live_session.ts.
//
// Behavior is byte-for-byte the same as the former App body: same ref set, same onopen mic-capture
// wiring, same onclose/catch reconnect timer (3000ms), same start/stop/reconnect semantics. No
// observable change — the e2e voice journeys are the integration witness.

import type * as React from "react";
import { useRef } from "react";
import { pcmToBase64, resetAudioPlayback, applyOutputDevice } from "../utils/audio";
import { disposeRefs, planReconnect } from "./liveSessionLogic";

const RECONNECT_DELAY_MS = 3000;

export interface LiveSessionParams {
  /** Mirror of activeTerminalId for the connect-time set_active_pane re-assert. */
  activeTerminalIdRef: React.MutableRefObject<string | null>;
  /** App-owned mirror of isMicMuted (kept in sync by an App effect); gates audio frames. */
  isMicMutedRef: React.MutableRefObject<boolean>;
  setIsLive: (v: boolean) => void;
  setIsReconnecting: (v: boolean) => void;
  /** Read by reconnectLive to decide whether a teardown+restart is warranted. */
  isLive: boolean;
  /**
   * Routes one parsed WS frame. `playbackCtx` is the connection-local 24kHz AudioContext, handed
   * through so audio frames play on the right graph (App wires it into dispatchWsMessage).
   */
  onWsMessage: (msg: any, playbackCtx: AudioContext) => void;
}

export interface LiveSession {
  /** Exposed because App also sends set_active_pane / draft_edit frames on this socket. */
  wsRef: React.MutableRefObject<WebSocket | null>;
  startLive: () => Promise<void>;
  stopLive: () => void;
  reconnectLive: () => Promise<void>;
}

export function useLiveSession(params: LiveSessionParams): LiveSession {
  const { activeTerminalIdRef, isMicMutedRef, setIsLive, setIsReconnecting, onWsMessage } = params;

  const wsRef = useRef<WebSocket | null>(null);
  const voiceCaptureCtxRef = useRef<AudioContext | null>(null);
  const voicePlaybackCtxRef = useRef<AudioContext | null>(null);
  const streamRef = useRef<MediaStream | null>(null);
  const processorRef = useRef<ScriptProcessorNode | null>(null);
  const sourceRef = useRef<MediaStreamAudioSourceNode | null>(null);
  const desiredLiveRef = useRef<boolean>(false);
  const reconnectTimeoutRef = useRef<any>(null);

  const cleanupSocketOnly = () => {
    // Burndown: each teardown was an identical `if (ref.current) { try { close } catch; ref=null }`.
    // disposeRefs performs that exact guarded teardown + null-out per ref; behavior (which refs,
    // which closer, the null-out) is unchanged.
    disposeRefs([
      [wsRef, (ws: WebSocket) => ws.close()],
      [processorRef, (p: ScriptProcessorNode) => p.disconnect()],
      [sourceRef, (s: MediaStreamAudioSourceNode) => s.disconnect()],
      [streamRef, (s: MediaStream) => s.getTracks().forEach((track) => track.stop())],
      [voiceCaptureCtxRef, (c: AudioContext) => c.close()],
      [voicePlaybackCtxRef, (c: AudioContext) => c.close()],
    ]);
  };

  // The onclose/catch reconnect path (shared by both sites in the original). plan() pins the
  // desiredLive branch; the timer + setters are applied here exactly as before.
  const applyReconnect = () => {
    const plan = planReconnect(desiredLiveRef.current);
    setIsLive(plan.live);
    setIsReconnecting(plan.reconnecting);
    if (plan.scheduleRetry) {
      if (reconnectTimeoutRef.current) clearTimeout(reconnectTimeoutRef.current);
      reconnectTimeoutRef.current = setTimeout(() => {
        if (desiredLiveRef.current) {
          connectLive();
        }
      }, RECONNECT_DELAY_MS);
    }
  };

  const connectLive = async () => {
    try {
      const protocol = window.location.protocol === "https:" ? "wss:" : "ws:";
      const wsUrl = `${protocol}//${window.location.host}/live`;
      const ws = new WebSocket(wsUrl);
      wsRef.current = ws;

      const captureCtx = new AudioContext({ sampleRate: 16000 });
      const playbackCtx = new AudioContext({ sampleRate: 24000 });
      applyOutputDevice(playbackCtx);
      voiceCaptureCtxRef.current = captureCtx;
      voicePlaybackCtxRef.current = playbackCtx;
      resetAudioPlayback();

      ws.onopen = async () => {
        setIsLive(true);
        setIsReconnecting(false);
        // Step 5: re-assert the source of truth on (re)connect so the server knows which pane the
        // operator has open before Janus can propose anything.
        ws.send(JSON.stringify({ type: "set_active_pane", paneId: activeTerminalIdRef.current }));
        try {
          const stream = await navigator.mediaDevices.getUserMedia({ audio: { echoCancellation: true, noiseSuppression: true, autoGainControl: true } });
          streamRef.current = stream;

          const source = captureCtx.createMediaStreamSource(stream);
          sourceRef.current = source;
          const processor = captureCtx.createScriptProcessor(4096, 1, 1);
          processorRef.current = processor;

          source.connect(processor);
          processor.connect(captureCtx.destination);

          processor.onaudioprocess = (e) => {
            if (wsRef.current && wsRef.current.readyState === WebSocket.OPEN && !isMicMutedRef.current) {
              const base64 = pcmToBase64(e.inputBuffer.getChannelData(0));
              wsRef.current.send(JSON.stringify({ type: "audio", audio: base64 }));
            }
          };
        } catch (mediaErr) {
          console.error("Microphone streaming failed to start:", mediaErr);
        }
      };

      ws.onmessage = (event) => {
        const msg = JSON.parse(event.data);
        // WS-D / burndown: the per-type dispatch lives in dispatchWsMessage (appHelpers). App wires
        // the ctx; we just hand the parsed frame + the connection-local playback ctx through.
        onWsMessage(msg, playbackCtx);
      };

      ws.onclose = () => {
        cleanupSocketOnly();
        // Adaptive auto-reconnection if closure was unexpected from server-side or connection drops.
        applyReconnect();
      };
    } catch (e) {
      console.error("Connection establish failed:", e);
      cleanupSocketOnly();
      applyReconnect();
    }
  };

  const startLive = async () => {
    desiredLiveRef.current = true;
    setIsReconnecting(false);
    if (reconnectTimeoutRef.current) {
      clearTimeout(reconnectTimeoutRef.current);
      reconnectTimeoutRef.current = null;
    }
    await connectLive();
  };

  const stopLive = () => {
    desiredLiveRef.current = false;
    setIsLive(false);
    setIsReconnecting(false);
    if (reconnectTimeoutRef.current) {
      clearTimeout(reconnectTimeoutRef.current);
      reconnectTimeoutRef.current = null;
    }
    cleanupSocketOnly();
  };

  const reconnectLive = async () => {
    if (params.isLive) {
      stopLive();
      setTimeout(() => { startLive(); }, 400);
    }
  };

  return { wsRef, startLive, stopLive, reconnectLive };
}
