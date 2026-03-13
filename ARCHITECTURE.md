# Polyglot — Technical Architecture

Deep dive into how Polyglot achieves real-time, bidirectional voice conversations with screen understanding.

## System Overview

```mermaid
flowchart TB
    subgraph Client["Browser (Next.js)"]
        direction TB
        A1["getUserMedia()"] -->|Raw PCM 48kHz| A2["Downsampler\n48kHz to 16kHz"]
        A2 -->|PCM 16-bit mono| A3["Audio Buffer\n250ms chunks"]
        A3 -->|base64 JSON| WS_C["WebSocket Client"]
        
        S1["getDisplayMedia()"] -->|Video stream| S2["Smart Capture\nChange Detection"]
        S2 -->|JPEG base64| WS_C
        
        T1["Text Input"] -->|JSON| WS_C
        
        WS_C -->|audio/wav base64| P1["Audio Player\nQueue-based"]
        WS_C -->|transcript fragments| P2["Message Accumulator"]
        P2 --> P3["Chat UI"]
    end

    subgraph Server["Backend (FastAPI on Cloud Run)"]
        direction TB
        WS_S["WebSocket Handler"] -->|bytes| AQ["asyncio.Queue\nAudio (maxsize=50)"]
        WS_S -->|bytes, mime| IQ["asyncio.Queue\nImage (maxsize=5)"]
        WS_S -->|string| TQ["asyncio.Queue\nText (maxsize=10)"]
        
        AQ --> SAL["_send_audio_loop()\nasyncio.Task"]
        IQ --> SML["_send_media_loop()\nasyncio.Task"]
        TQ --> SML
        
        SAL -->|"send_realtime_input(audio=)"| GS["Gemini Live\nSession"]
        SML -->|"send_realtime_input(video=)"| GS
        SML -->|"send(LiveClientContent)"| GS
        
        GS -->|"session.receive()"| RL["_receive_loop()\nasyncio.Task"]
        RL -->|events| OQ["asyncio.Queue\nOutput (maxsize=100)"]
        OQ --> WS_S
    end

    subgraph Gemini["Gemini Live API"]
        GL["gemini-live-2.5-flash-native-audio"]
        VAD["Server-side VAD"]
        AT["Audio Transcription"]
        GL --- VAD
        GL --- AT
    end

    WS_C <-->|"wss:// WebSocket"| WS_S
    GS <-->|"Bidirectional gRPC Stream"| GL

    style Client fill:#1a1a2e,stroke:#6c63ff,color:#fff
    style Server fill:#16213e,stroke:#0f3460,color:#fff
    style Gemini fill:#2d1b69,stroke:#8b5cf6,color:#fff
```

## Audio Pipeline

The audio path is the most latency-sensitive component. Here's the exact flow:

```mermaid
sequenceDiagram
    participant Mic as Browser Mic
    participant FE as Frontend
    participant WS as WebSocket
    participant BE as Backend
    participant GEM as Gemini Live

    Note over Mic: AudioContext at native rate 48kHz
    Mic->>FE: Raw PCM float32 4096 samples per frame
    FE->>FE: Downsample 48kHz to 16kHz
    FE->>FE: Convert float32 to int16 PCM
    FE->>FE: Buffer chunks at 250ms interval
    FE->>WS: JSON input.audio with audio_base64
    WS->>BE: Decode base64 to raw bytes
    BE->>BE: Enqueue to audio_queue
    BE->>GEM: send_realtime_input audio Blob
    Note over GEM: Server-side VAD detects speech end
    GEM->>BE: model_turn inline_data raw PCM 24kHz
    BE->>BE: PCM to WAV with 44-byte header
    BE->>BE: base64 encode WAV
    BE->>WS: JSON output.audio with audio_base64
    WS->>FE: Parse JSON and push to audioQ
    FE->>FE: Play audio via new Audio data URL
    Note over GEM: If user speaks during playback
    GEM->>BE: server_content.interrupted is true
    BE->>WS: Send interrupted event
    WS->>FE: Clear audioQ and stop playback
```

## Smart Screen Capture

Instead of capturing at fixed intervals, Polyglot detects actual visual changes:

```mermaid
flowchart TD
    A["Every 2 seconds"] --> B{"Screen sharing\nactive?"}
    B -->|No| A
    B -->|Yes| C["Draw video frame\nto 64×64 canvas"]
    C --> D["getImageData()\nread pixel values"]
    D --> E{"Compare with\nprevious frame"}
    E -->|Significant change| F["CHANGED: Capture full\n1024px JPEG frame"]
    E -->|Below threshold| G{"Last send\nover 10 seconds?"}
    G -->|Yes| H["HEARTBEAT: Capture\nfull frame anyway"]
    G -->|No| A
    F --> I["Send to Gemini via\ninput.image WebSocket msg"]
    H --> I
    I --> J["Update thumbnail\nin UI"]
    J --> A

    style F fill:#22c55e,stroke:#16a34a,color:#fff
    style H fill:#eab308,stroke:#ca8a04,color:#fff
```

## Concurrency Model

The backend runs 4 concurrent asyncio tasks per session:

```mermaid
flowchart LR
    subgraph Tasks["Per-Session Tasks"]
        T1["_send_audio_loop()\nDrains audio queue"]
        T2["_send_media_loop()\nDrains image + text queues"]
        T3["_receive_loop()\nReads from Gemini"]
        T4["_drain_output()\nSends events to frontend"]
    end

    subgraph Queues["Backpressure Queues"]
        Q1["audio_queue\nmaxsize=50"]
        Q2["image_queue\nmaxsize=5"]
        Q3["text_queue\nmaxsize=10"]
        Q4["output_queue\nmaxsize=100"]
    end

    Q1 --> T1
    Q2 --> T2
    Q3 --> T2
    T3 --> Q4
    Q4 --> T4

    style Tasks fill:#1e293b,stroke:#475569,color:#fff
    style Queues fill:#0f172a,stroke:#334155,color:#fff
```

**Why queues?** Without backpressure, audio floods the Gemini WebSocket faster than it can process, causing `ConnectionClosedError`. Bounded queues with drop-oldest policy keep the stream healthy.

**Why `while True` in receive?** `session.receive()` yields messages for one turn only. After `turn_complete`, the async iterator ends. Wrapping in `while True` re-enters the iterator for the next turn — this is the official Google pattern.

## Deployment Architecture

```mermaid
flowchart LR
    subgraph GCP["Google Cloud (us-east1)"]
        CR_FE["Cloud Run\npolyglot-frontend\nNext.js :3000"]
        CR_BE["Cloud Run\npolyglot-backend\nFastAPI :8080"]
        AR["Artifact Registry\nDocker images"]
        VA["Vertex AI\nGemini Live API"]
    end

    USER["User Browser"] -->|HTTPS| CR_FE
    CR_FE -->|"Static assets"| USER
    USER -->|"wss:// WebSocket"| CR_BE
    CR_BE -->|"gRPC stream"| VA

    AR -.->|images| CR_FE
    AR -.->|images| CR_BE

    style GCP fill:#1a1a2e,stroke:#6c63ff,color:#fff
    style USER fill:#4a0e4e,stroke:#c84b96,color:#fff
```

| Service | Config |
|---|---|
| **polyglot-backend** | 512Mi RAM, 1 CPU, timeout 3600s, session affinity, 0-3 instances |
| **polyglot-frontend** | 256Mi RAM, 1 CPU, default timeout, 0-3 instances |

## Key Design Decisions

1. **Server-side VAD over client-side** — Gemini's built-in voice activity detection is more accurate and eliminates client-side complexity. We just stream audio continuously.

2. **Queue-based concurrency over sequential** — Sending audio, receiving responses, and processing images happen concurrently via `asyncio.create_task()`. This prevents any one slow operation from blocking others.

3. **Client-side downsampling** — Browsers typically ignore `sampleRate: 16000` on AudioContext and default to 48kHz. We downsample manually to ensure Gemini receives correct 16kHz PCM.

4. **Transcript accumulation** — Gemini sends transcription fragments word-by-word. We accumulate them client-side and update a single message bubble, rather than creating a new bubble per fragment.

5. **PCM-to-WAV conversion** — Gemini outputs raw PCM but browsers need proper audio containers for `new Audio()` playback. We add a 44-byte WAV header server-side.
