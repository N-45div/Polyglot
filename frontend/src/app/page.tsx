"use client";

import { useCallback, useEffect, useRef, useState } from "react";

type SessionState = "idle" | "connecting" | "live" | "error";
type Message = { id: string; role: "user" | "ai"; text: string; time: number };

const WS_URL = process.env.NEXT_PUBLIC_WS_URL ?? "ws://localhost:8001/ws/live";

const LANGS = [
  { code: "en-US", name: "English", native: "English" },
  { code: "hi-IN", name: "Hindi", native: "हिन्दी" },
  { code: "es-ES", name: "Spanish", native: "Español" },
  { code: "ja-JP", name: "Japanese", native: "日本語" },
  { code: "de-DE", name: "German", native: "Deutsch" },
  { code: "fr-FR", name: "French", native: "Français" },
  { code: "pt-BR", name: "Portuguese", native: "Português" },
  { code: "ko-KR", name: "Korean", native: "한국어" },
];

const uid = () => Math.random().toString(36).slice(2, 9);

export default function Home() {
  const [state, setState] = useState<SessionState>("idle");
  const [lang, setLang] = useState("en-US");
  const [msgs, setMsgs] = useState<Message[]>([]);
  const [input, setInput] = useState("");
  const [micOn, setMicOn] = useState(false);
  const [screenOn, setScreenOn] = useState(false);
  const [autoCapture, setAutoCapture] = useState(false);
  const [speaking, setSpeaking] = useState(false);
  const [frame, setFrame] = useState<string | null>(null);
  const [showLangPicker, setShowLangPicker] = useState(false);

  const ws = useRef<WebSocket | null>(null);
  const video = useRef<HTMLVideoElement>(null);
  const stream = useRef<MediaStream | null>(null);
  const mic = useRef<MediaStream | null>(null);
  const audioCtx = useRef<AudioContext | null>(null);
  const audioQ = useRef<string[]>([]);
  const playing = useRef(false);
  const captureInt = useRef<NodeJS.Timeout | null>(null);
  const endRef = useRef<HTMLDivElement>(null);

  const scroll = () => endRef.current?.scrollIntoView({ behavior: "smooth" });
  useEffect(scroll, [msgs]);

  const playNext = useCallback(async () => {
    if (playing.current || !audioQ.current.length) return;
    playing.current = true;
    setSpeaking(true);
    const b64 = audioQ.current.shift()!;
    try {
      const a = new Audio(`data:audio/wav;base64,${b64}`);
      a.onended = a.onerror = () => {
        playing.current = false;
        setSpeaking(false);
        playNext();
      };
      await a.play();
    } catch {
      playing.current = false;
      setSpeaking(false);
      playNext();
    }
  }, []);

  const qAudio = useCallback((b64: string) => {
    audioQ.current.push(b64);
    playNext();
  }, [playNext]);

  const send = useCallback((p: Record<string, unknown>) => {
    if (ws.current?.readyState === WebSocket.OPEN) ws.current.send(JSON.stringify(p));
  }, []);

  const startSession = useCallback(() => {
    if (ws.current) return;
    setState("connecting");
    const s = new WebSocket(WS_URL);
    ws.current = s;
    s.onopen = () => s.send(JSON.stringify({ type: "session.start", data: { language_code: lang, voice_name: "Aoede" } }));
    // Accumulate transcript fragments into complete messages
    let userBuf = "";
    let aiBuf = "";
    let userMsgId = "";
    let aiMsgId = "";

    s.onmessage = (e) => {
      try {
        const m = JSON.parse(e.data);
        if (m.type === "session.ready") {
          setState("live");
          console.log("Session is LIVE");
        }
        // Accumulate user transcript fragments
        if (m.type === "transcript.user" && m.data?.text) {
          // Flush any pending AI message
          if (aiBuf) { aiBuf = ""; aiMsgId = ""; }
          userBuf += m.data.text;
          if (!userMsgId) userMsgId = uid();
          const id = userMsgId;
          const text = userBuf;
          setMsgs((p) => {
            const existing = p.findIndex((msg) => msg.id === id);
            if (existing >= 0) {
              const updated = [...p];
              updated[existing] = { ...updated[existing], text };
              return updated;
            }
            return [...p, { id, role: "user", text, time: Date.now() }];
          });
        }
        // Accumulate model transcript fragments
        if (m.type === "transcript.model" && m.data?.text) {
          // Flush any pending user message
          if (userBuf) { userBuf = ""; userMsgId = ""; }
          aiBuf += m.data.text;
          if (!aiMsgId) aiMsgId = uid();
          const id = aiMsgId;
          const text = aiBuf;
          setMsgs((p) => {
            const existing = p.findIndex((msg) => msg.id === id);
            if (existing >= 0) {
              const updated = [...p];
              updated[existing] = { ...updated[existing], text };
              return updated;
            }
            return [...p, { id, role: "ai", text, time: Date.now() }];
          });
        }
        // Interrupted = user started speaking, flush AI buffer
        if (m.type === "interrupted") {
          aiBuf = ""; aiMsgId = "";
          // Clear audio queue so old audio doesn't play over new conversation
          audioQ.current = [];
        }
        if (m.type === "output.audio" && m.data?.audio_base64) qAudio(m.data.audio_base64);
      } catch {}
    };
    s.onclose = () => { setState("idle"); ws.current = null; };
    s.onerror = () => setState("error");
  }, [lang, qAudio]);

  const endSession = useCallback(() => {
    captureInt.current && clearInterval(captureInt.current);
    stream.current?.getTracks().forEach((t) => t.stop());
    mic.current?.getTracks().forEach((t) => t.stop());
    ws.current?.close();
    stream.current = mic.current = ws.current = null;
    audioQ.current = [];
    playing.current = false;
    setScreenOn(false);
    setMicOn(false);
    setSpeaking(false);
    setState("idle");
  }, []);

  const sendText = useCallback(() => {
    const t = input.trim();
    if (!t || state !== "live") return;
    setMsgs((p) => [...p, { id: uid(), role: "user", text: t, time: Date.now() }]);
    send({ type: "input.text", data: { text: t } });
    setInput("");
  }, [input, state, send]);

  // Smart capture: grabs frame, sends to Gemini, updates thumbnail
  const captureCanvas = useRef<HTMLCanvasElement | null>(null);
  const lastPixels = useRef<Uint8ClampedArray | null>(null);
  const smartCapRef = useRef<NodeJS.Timeout | null>(null);

  const captureFrame = useCallback((forceUpdate = true): string | null => {
    if (!video.current || !stream.current) return null;
    const v = video.current;
    if (!v.videoWidth || !v.videoHeight) return null;
    const maxW = 1024;
    const scale = Math.min(1, maxW / v.videoWidth);
    const w = Math.round(v.videoWidth * scale);
    const h = Math.round(v.videoHeight * scale);
    if (!captureCanvas.current) captureCanvas.current = document.createElement("canvas");
    const c = captureCanvas.current;
    c.width = w; c.height = h;
    const ctx = c.getContext("2d", { willReadFrequently: true });
    if (!ctx) return null;
    ctx.drawImage(v, 0, 0, w, h);
    const url = c.toDataURL("image/jpeg", 0.5);
    if (forceUpdate) setFrame(url);
    return url;
  }, []);

  // Send frame to Gemini
  const sendFrame = useCallback((url: string) => {
    send({ type: "input.image", data: { image_base64: url.split(",")[1], mime_type: "image/jpeg" } });
  }, [send]);

  // Manual capture button
  const capture = useCallback(() => {
    const url = captureFrame(true);
    if (url) sendFrame(url);
  }, [captureFrame, sendFrame]);

  // Detect if screen changed significantly using pixel sampling
  const hasChanged = useCallback((): boolean => {
    if (!video.current || !stream.current) return false;
    const v = video.current;
    if (!v.videoWidth || !v.videoHeight) return false;
    // Use small thumbnail for fast comparison
    const sz = 64;
    if (!captureCanvas.current) captureCanvas.current = document.createElement("canvas");
    const c = captureCanvas.current;
    c.width = sz; c.height = sz;
    const ctx = c.getContext("2d", { willReadFrequently: true });
    if (!ctx) return false;
    ctx.drawImage(v, 0, 0, sz, sz);
    const pixels = ctx.getImageData(0, 0, sz, sz).data;
    if (!lastPixels.current) { lastPixels.current = new Uint8ClampedArray(pixels); return true; }
    // Compare: sum of absolute differences
    let diff = 0;
    const len = pixels.length;
    const prev = lastPixels.current;
    for (let i = 0; i < len; i += 16) { diff += Math.abs(pixels[i] - prev[i]); }
    const threshold = 500; // tuned for meaningful changes
    const changed = diff > threshold;
    if (changed) lastPixels.current = new Uint8ClampedArray(pixels);
    return changed;
  }, []);

  const startScreen = useCallback(async () => {
    try {
      const s = await navigator.mediaDevices.getDisplayMedia({ video: { frameRate: 5 }, audio: false });
      stream.current = s;
      if (video.current) { video.current.srcObject = s; await video.current.play(); }
      setScreenOn(true);
      setAutoCapture(true);
      s.getVideoTracks()[0].onended = () => {
        setScreenOn(false);
        setAutoCapture(false);
        smartCapRef.current && clearInterval(smartCapRef.current);
        stream.current = null;
        lastPixels.current = null;
      };
    } catch (e) { console.error("Screen share failed:", e); }
  }, []);

  const stopScreen = useCallback(() => {
    smartCapRef.current && clearInterval(smartCapRef.current);
    smartCapRef.current = null;
    stream.current?.getTracks().forEach((t) => t.stop());
    if (video.current) video.current.srcObject = null;
    stream.current = null;
    lastPixels.current = null;
    setScreenOn(false);
    setAutoCapture(false);
  }, []);

  // Smart auto-capture: checks for changes every 2s, sends frame if changed
  // Also sends a frame every 10s regardless as a heartbeat
  const lastForceSend = useRef(0);
  useEffect(() => {
    if (!screenOn || !autoCapture) {
      smartCapRef.current && clearInterval(smartCapRef.current);
      smartCapRef.current = null;
      return;
    }
    // Initial capture after 1s
    const initTimer = setTimeout(() => {
      const url = captureFrame(true);
      if (url) sendFrame(url);
      lastForceSend.current = Date.now();
    }, 1000);
    // Check for changes every 2 seconds
    smartCapRef.current = setInterval(() => {
      const now = Date.now();
      const changed = hasChanged();
      const heartbeat = now - lastForceSend.current > 10000;
      if (changed || heartbeat) {
        const url = captureFrame(true);
        if (url) {
          sendFrame(url);
          lastForceSend.current = now;
          if (changed) console.log("Smart capture: screen changed, sent frame");
        }
      }
    }, 2000);
    return () => {
      clearTimeout(initTimer);
      smartCapRef.current && clearInterval(smartCapRef.current);
      smartCapRef.current = null;
    };
  }, [screenOn, autoCapture, hasChanged, captureFrame, sendFrame]);

  const audioBuffer = useRef<Int16Array[]>([]);
  const lastSend = useRef(0);
  const stateRef = useRef(state);
  
  useEffect(() => { stateRef.current = state; }, [state]);

  const procRef = useRef<ScriptProcessorNode | null>(null);
  const srcRef = useRef<MediaStreamAudioSourceNode | null>(null);

  const startMic = useCallback(async () => {
    // Use native sample rate - we'll downsample to 16kHz ourselves
    if (!audioCtx.current) audioCtx.current = new AudioContext();
    if (audioCtx.current.state === "suspended") await audioCtx.current.resume();
    const nativeSR = audioCtx.current.sampleRate;
    const targetSR = 16000;
    const ratio = nativeSR / targetSR;
    console.log(`Mic: native=${nativeSR}Hz, target=${targetSR}Hz, ratio=${ratio}`);
    try {
      const s = await navigator.mediaDevices.getUserMedia({
        audio: { channelCount: 1, echoCancellation: true, noiseSuppression: true, autoGainControl: true },
      });
      mic.current = s;
      setMicOn(true);
      srcRef.current = audioCtx.current.createMediaStreamSource(s);
      procRef.current = audioCtx.current.createScriptProcessor(4096, 1, 1);
      let chunkCount = 0;
      procRef.current.onaudioprocess = (e) => {
        if (stateRef.current !== "live" || !ws.current) return;
        const inp = e.inputBuffer.getChannelData(0);
        const now = Date.now();

        // Downsample from native rate to 16kHz
        const outLen = Math.floor(inp.length / ratio);
        const pcm = new Int16Array(outLen);
        for (let i = 0; i < outLen; i++) {
          const srcIdx = Math.floor(i * ratio);
          const sample = Math.max(-1, Math.min(1, inp[srcIdx]));
          pcm[i] = sample * (sample < 0 ? 0x8000 : 0x7fff);
        }
        audioBuffer.current.push(pcm);

        // Send buffered audio every 250ms (backend has queue backpressure)
        if (now - lastSend.current >= 250 && audioBuffer.current.length > 0) {
          const total = audioBuffer.current.reduce((s, a) => s + a.length, 0);
          const merged = new Int16Array(total);
          let off = 0;
          for (const chunk of audioBuffer.current) { merged.set(chunk, off); off += chunk.length; }
          audioBuffer.current = [];
          lastSend.current = now;
          const bytes = new Uint8Array(merged.buffer);
          let b64 = "";
          for (let i = 0; i < bytes.length; i += 8192) {
            b64 += String.fromCharCode(...bytes.subarray(i, i + 8192));
          }
          if (ws.current?.readyState === WebSocket.OPEN) {
            ws.current.send(JSON.stringify({ type: "input.audio", data: { audio_base64: btoa(b64) } }));
            chunkCount++;
            if (chunkCount % 10 === 0) console.log(`Audio chunks sent: ${chunkCount}, size: ${total * 2} bytes`);
          }
        }
      };
      srcRef.current.connect(procRef.current);
      procRef.current.connect(audioCtx.current.destination);
      console.log("Mic started, streaming 16kHz PCM audio...");
    } catch (e) { console.error("Mic failed:", e); }
  }, []);

  const stopMic = useCallback(() => {
    procRef.current?.disconnect();
    srcRef.current?.disconnect();
    procRef.current = null;
    srcRef.current = null;
    mic.current?.getTracks().forEach((t) => t.stop());
    mic.current = null;
    setMicOn(false);
  }, []);

  useEffect(() => () => endSession(), [endSession]);

  const selLang = LANGS.find((l) => l.code === lang);

  return (
    <div className="fixed inset-0 flex flex-col bg-[#0a0a0f] text-white">
      {/* ── Header ── */}
      <header className="flex h-14 shrink-0 items-center justify-between border-b border-white/[0.06] px-5">
        <div className="flex items-center gap-3">
          <div className="flex h-8 w-8 items-center justify-center rounded-lg bg-gradient-to-br from-violet-500 to-fuchsia-500">
            <span className="text-sm font-bold">P</span>
          </div>
          <div className="leading-tight">
            <h1 className="text-sm font-semibold">Polyglot</h1>
            <p className="text-[10px] text-white/40">Live Companion</p>
          </div>
        </div>

        <div className="flex items-center gap-2">
          {/* Language */}
          <div className="relative">
            <button
              onClick={() => setShowLangPicker(!showLangPicker)}
              disabled={state === "live"}
              className="flex items-center gap-1.5 rounded-lg border border-white/[0.08] bg-white/[0.03] px-3 py-1.5 text-xs text-white/70 transition hover:bg-white/[0.06] disabled:opacity-40"
            >
              {selLang?.native}
              <svg className="h-3 w-3 opacity-40" fill="none" viewBox="0 0 24 24" stroke="currentColor"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M19 9l-7 7-7-7" /></svg>
            </button>
            {showLangPicker && state !== "live" && (
              <div className="absolute right-0 top-full z-50 mt-1 w-44 rounded-lg border border-white/[0.08] bg-[#14141e] p-1 shadow-xl">
                {LANGS.map((l) => (
                  <button
                    key={l.code}
                    onClick={() => { setLang(l.code); setShowLangPicker(false); }}
                    className={`flex w-full items-center justify-between rounded-md px-2.5 py-1.5 text-xs transition ${lang === l.code ? "bg-white/[0.08] text-white" : "text-white/60 hover:bg-white/[0.04] hover:text-white"}`}
                  >
                    <span>{l.native}</span>
                    <span className="text-[10px] text-white/30">{l.name}</span>
                  </button>
                ))}
              </div>
            )}
          </div>

          {/* Session control */}
          {state === "idle" ? (
            <button onClick={startSession} className="rounded-lg bg-violet-600 px-4 py-1.5 text-xs font-medium transition hover:bg-violet-500">
              Start
            </button>
          ) : state === "connecting" ? (
            <div className="flex items-center gap-1.5 rounded-lg border border-amber-500/20 bg-amber-500/10 px-3 py-1.5 text-xs text-amber-300">
              <div className="h-1.5 w-1.5 animate-pulse rounded-full bg-amber-400" />
              Connecting
            </div>
          ) : (
            <div className="flex items-center gap-1.5">
              <div className="flex items-center gap-1.5 rounded-lg border border-emerald-500/20 bg-emerald-500/10 px-3 py-1.5 text-xs text-emerald-300">
                <div className="h-1.5 w-1.5 animate-pulse rounded-full bg-emerald-400" />
                Live
              </div>
              <button onClick={endSession} className="rounded-lg border border-red-500/20 bg-red-500/10 px-3 py-1.5 text-xs text-red-300 transition hover:bg-red-500/20">
                End
              </button>
            </div>
          )}
        </div>
      </header>

      {/* ── Main ── */}
      <div className="flex min-h-0 flex-1">
        {/* Left: Screen */}
        <div className="flex flex-1 flex-col">
          <div className="relative flex-1 bg-black">
            <video ref={video} className="h-full w-full object-contain" muted playsInline />

            {!screenOn && (
              <div className="absolute inset-0 flex flex-col items-center justify-center gap-4">
                <svg className="h-12 w-12 text-white/20" fill="none" viewBox="0 0 24 24" stroke="currentColor"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.5} d="M9.75 17L9 20l-1 1h8l-1-1-.75-3M3 13h18M5 17h14a2 2 0 002-2V5a2 2 0 00-2-2H5a2 2 0 00-2 2v10a2 2 0 002 2z" /></svg>
                <p className="text-sm text-white/30">Share your screen for visual context</p>
                {state === "live" && (
                  <button onClick={startScreen} className="rounded-lg bg-white/[0.08] px-5 py-2 text-sm transition hover:bg-white/[0.12]">
                    Share Screen
                  </button>
                )}
              </div>
            )}

            {screenOn && (
              <>
                <div className="absolute left-3 top-3 flex items-center gap-1.5 rounded-md bg-black/70 px-2 py-1 backdrop-blur">
                  <div className="h-1.5 w-1.5 animate-pulse rounded-full bg-red-500" />
                  <span className="text-[10px] font-medium">LIVE</span>
                </div>
                <div className="absolute bottom-3 left-1/2 flex -translate-x-1/2 items-center gap-1.5 rounded-lg bg-black/70 p-1.5 backdrop-blur">
                  <button onClick={capture} className="rounded-md bg-white/10 px-3 py-1.5 text-xs transition hover:bg-white/20">Capture</button>
                  <button
                    onClick={() => setAutoCapture((v) => !v)}
                    className={`rounded-md px-3 py-1.5 text-xs transition ${autoCapture ? "bg-emerald-500/20 text-emerald-300" : "bg-white/10 hover:bg-white/20"}`}
                  >
                    {autoCapture ? "Auto On" : "Auto Off"}
                  </button>
                  <button onClick={stopScreen} className="rounded-md bg-white/10 px-3 py-1.5 text-xs transition hover:bg-white/20">Stop</button>
                </div>
              </>
            )}
          </div>

          {/* Bottom bar: mic + text input */}
          <div className="flex h-14 shrink-0 items-center gap-3 border-t border-white/[0.06] px-4">
            <button
              onClick={micOn ? stopMic : startMic}
              disabled={state !== "live"}
              className={`flex h-9 w-9 shrink-0 items-center justify-center rounded-lg transition ${
                micOn ? "bg-emerald-500/20 text-emerald-400" : "bg-white/[0.06] text-white/50 hover:text-white"
              } disabled:opacity-30`}
            >
              <svg className="h-4 w-4" fill={micOn ? "currentColor" : "none"} viewBox="0 0 24 24" stroke={micOn ? "none" : "currentColor"} strokeWidth={2}>
                {micOn ? (
                  <><path d="M12 14c1.66 0 3-1.34 3-3V5c0-1.66-1.34-3-3-3S9 3.34 9 5v6c0 1.66 1.34 3 3 3z"/><path d="M17 11c0 2.76-2.24 5-5 5s-5-2.24-5-5H5c0 3.53 2.61 6.43 6 6.92V21h2v-3.08c3.39-.49 6-3.39 6-6.92h-2z"/></>
                ) : (
                  <path strokeLinecap="round" strokeLinejoin="round" d="M19 11a7 7 0 01-7 7m0 0a7 7 0 01-7-7m7 7v4m0 0H8m4 0h4m-4-8a3 3 0 01-3-3V5a3 3 0 116 0v6a3 3 0 01-3 3z" />
                )}
              </svg>
            </button>
            <input
              value={input}
              onChange={(e) => setInput(e.target.value)}
              onKeyDown={(e) => e.key === "Enter" && sendText()}
              placeholder={state === "live" ? "Type a message..." : "Start a session first"}
              disabled={state !== "live"}
              className="min-w-0 flex-1 bg-transparent text-sm text-white placeholder-white/25 outline-none disabled:opacity-40"
            />
            <button
              onClick={sendText}
              disabled={state !== "live" || !input.trim()}
              className="rounded-lg bg-violet-600 px-4 py-1.5 text-xs font-medium transition hover:bg-violet-500 disabled:opacity-30"
            >
              Send
            </button>
          </div>
        </div>

        {/* Right: Conversation panel */}
        <div className="flex w-[340px] shrink-0 flex-col border-l border-white/[0.06] xl:w-[380px]">
          {/* Status orb */}
          <div className="flex shrink-0 flex-col items-center gap-2 border-b border-white/[0.06] py-5">
            <div className="relative">
              <div className={`h-16 w-16 rounded-full bg-gradient-to-br from-violet-500 via-fuchsia-500 to-cyan-400 transition-shadow ${speaking ? "shadow-[0_0_30px_rgba(168,85,247,0.4)]" : ""}`}>
                {speaking && (
                  <div className="flex h-full items-center justify-center gap-0.5">
                    {[...Array(5)].map((_, i) => (
                      <div key={i} className="w-[3px] animate-pulse rounded-full bg-white/80" style={{ height: `${12 + Math.random() * 16}px`, animationDelay: `${i * 80}ms`, animationDuration: "0.4s" }} />
                    ))}
                  </div>
                )}
              </div>
              {micOn && (
                <div className="absolute -bottom-0.5 -right-0.5 h-4 w-4 rounded-full border-2 border-[#0a0a0f] bg-emerald-400" />
              )}
            </div>
            <span className="text-xs text-white/40">
              {speaking ? "Speaking..." : micOn ? "Listening..." : state === "live" ? "Ready" : "Offline"}
            </span>
          </div>

          {/* Messages */}
          <div className="flex-1 overflow-y-auto">
            {msgs.length === 0 ? (
              <div className="flex h-full items-center justify-center p-6">
                <p className="text-center text-xs text-white/25">
                  {state === "live" ? "Start talking or type a message" : "Start a session to begin"}
                </p>
              </div>
            ) : (
              <div className="space-y-3 p-4">
                {msgs.map((m) => (
                  <div key={m.id} className={`flex ${m.role === "user" ? "justify-end" : "justify-start"}`}>
                    <div className={`max-w-[85%] rounded-2xl px-3.5 py-2 text-[13px] leading-relaxed ${
                      m.role === "user"
                        ? "bg-violet-600 text-white"
                        : "bg-white/[0.07] text-white/90"
                    }`}>
                      {m.text}
                    </div>
                  </div>
                ))}
                <div ref={endRef} />
              </div>
            )}
          </div>

          {/* Last capture */}
          {frame && (
            <div className="shrink-0 border-t border-white/[0.06] p-3">
              <p className="mb-1.5 text-[10px] font-medium uppercase tracking-wider text-white/30">Last capture</p>
              <img src={frame} alt="capture" className="w-full rounded-lg" />
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
