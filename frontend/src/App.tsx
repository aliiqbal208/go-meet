import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
} from 'react'
import { SfuClient, type ChatMessage, type Participant } from './sfu'

type Phase = 'lobby' | 'call'

// ---------------------------------------------------------------------------
// Inline SVG icons (no icon dependency).
// ---------------------------------------------------------------------------
const Icon = ({ path, filled = true }: { path: string; filled?: boolean }) => (
  <svg viewBox="0 0 24 24" width="22" height="22" aria-hidden="true">
    <path d={path} fill={filled ? 'currentColor' : 'none'} stroke="currentColor" strokeWidth={filled ? 0 : 2} strokeLinecap="round" strokeLinejoin="round" />
  </svg>
)
const ICONS = {
  mic: 'M12 14a3 3 0 0 0 3-3V6a3 3 0 0 0-6 0v5a3 3 0 0 0 3 3zm5-3a5 5 0 0 1-10 0H5a7 7 0 0 0 6 6.92V21h2v-3.08A7 7 0 0 0 19 11h-2z',
  micOff: 'M3 3l18 18-1.4 1.4-3.2-3.2A7 7 0 0 1 13 18.9V21h-2v-2.1A7 7 0 0 1 5 11h2a5 5 0 0 0 7.1 4.5L12.9 14.3A3 3 0 0 1 9 11.4L1.6 4 3 3zm6 .9A3 3 0 0 1 15 6v4.2L9 4.2V3.9zM17 11a5 5 0 0 1-.1 1l1.6 1.6A7 7 0 0 0 19 11h-2z',
  cam: 'M17 10.5V7a1 1 0 0 0-1-1H4a1 1 0 0 0-1 1v10a1 1 0 0 0 1 1h12a1 1 0 0 0 1-1v-3.5l4 4v-11l-4 4z',
  camOff: 'M3 3l18 18-1.4 1.4-2.6-2.6a1 1 0 0 1-1 .8H4a1 1 0 0 1-1-1V7a1 1 0 0 1 1-1h.6L1.6 4.4 3 3zm18 4.5v9l-6.3-6.3L21 7.5z',
  chat: 'M4 4h16a1 1 0 0 1 1 1v11a1 1 0 0 1-1 1H8l-4 4V5a1 1 0 0 1 1-1z',
  leave: 'M12 9c-2 0-3.9.3-5.6.9v3.3c0 .4-.2.7-.5.9-.6.4-1.2.8-1.7 1.3-.2.2-.4.3-.7.3s-.5-.1-.7-.3l-2.2-2.2a1 1 0 0 1 0-1.4C3 9.9 7.2 8 12 8s9 1.9 11.4 4.8a1 1 0 0 1 0 1.4l-2.2 2.2c-.2.2-.4.3-.7.3s-.5-.1-.7-.3c-.5-.5-1.1-.9-1.7-1.3-.3-.2-.5-.5-.5-.9v-3.3C15.9 9.3 14 9 12 9z',
  copy: 'M9 9V5a1 1 0 0 1 1-1h9a1 1 0 0 1 1 1v9a1 1 0 0 1-1 1h-4M4 9h9a1 1 0 0 1 1 1v9a1 1 0 0 1-1 1H4a1 1 0 0 1-1-1v-9a1 1 0 0 1 1-1z',
}

function initials(name: string): string {
  // Drop parentheticals such as the "(you)" suffix on the local tile so they
  // don't leak into the avatar (e.g. "alice (you)" -> "AL", not "A(").
  const parts = name
    .replace(/\(.*?\)/g, ' ')
    .trim()
    .split(/\s+/)
    .filter(Boolean)
  if (parts.length === 0) return '?'
  if (parts.length === 1) return parts[0].slice(0, 2).toUpperCase()
  return (parts[0][0] + parts[parts.length - 1][0]).toUpperCase()
}

// genRoomCode produces a Meet-style code like "abc-defg-hij" — random enough to
// not collide in practice, readable enough to say out loud.
function genRoomCode(): string {
  const alphabet = 'abcdefghijklmnopqrstuvwxyz'
  const pick = (n: number) =>
    Array.from(crypto.getRandomValues(new Uint8Array(n)))
      .map((b) => alphabet[b % alphabet.length])
      .join('')
  return `${pick(3)}-${pick(4)}-${pick(3)}`
}

// parseRoomInput accepts either a raw code or a full pasted meeting URL and
// returns the room id.
function parseRoomInput(input: string): string {
  const trimmed = input.trim()
  try {
    const room = new URL(trimmed).searchParams.get('room')
    if (room) return room.trim()
  } catch {
    // not a URL — fall through and treat the whole thing as a code
  }
  return trimmed
}

// roomFromUrl reads the current ?room= param (the shareable link is the source
// of truth for which meeting you're in).
function roomFromUrl(): string {
  return new URLSearchParams(location.search).get('room')?.trim() ?? ''
}

// ---------------------------------------------------------------------------
// useActiveSpeaker: returns the id of the loudest stream above a threshold.
// Runs entirely client-side (the server strips the audio-level RTP extension).
// ---------------------------------------------------------------------------
function useActiveSpeaker(
  streams: { id: string; stream: MediaStream }[],
): string | null {
  const [active, setActive] = useState<string | null>(null)
  const ctxRef = useRef<AudioContext | null>(null)
  const key = streams.map((s) => s.id).join(',')

  useEffect(() => {
    if (streams.length === 0) {
      setActive(null)
      return
    }
    const Ctx =
      window.AudioContext ?? (window as unknown as { webkitAudioContext: typeof AudioContext }).webkitAudioContext
    const ctx = ctxRef.current ?? new Ctx()
    ctxRef.current = ctx
    void ctx.resume()

    const nodes = streams
      .filter((s) => s.stream.getAudioTracks().length > 0)
      .map(({ id, stream }) => {
        const src = ctx.createMediaStreamSource(stream)
        const analyser = ctx.createAnalyser()
        analyser.fftSize = 512
        src.connect(analyser)
        return { id, src, analyser, data: new Uint8Array(analyser.frequencyBinCount) }
      })

    const interval = setInterval(() => {
      let bestId: string | null = null
      let best = 0
      for (const n of nodes) {
        n.analyser.getByteTimeDomainData(n.data)
        let sum = 0
        for (let i = 0; i < n.data.length; i++) {
          const v = (n.data[i] - 128) / 128
          sum += v * v
        }
        const rms = Math.sqrt(sum / n.data.length)
        if (rms > best) {
          best = rms
          bestId = n.id
        }
      }
      setActive(best > 0.04 ? bestId : null)
    }, 200)

    return () => {
      clearInterval(interval)
      nodes.forEach((n) => n.src.disconnect())
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [key])

  useEffect(
    () => () => {
      void ctxRef.current?.close()
      ctxRef.current = null
    },
    [],
  )

  return active
}

// ---------------------------------------------------------------------------
// VideoTile
// ---------------------------------------------------------------------------
function VideoTile({
  stream,
  label,
  muted = false,
  isLocal = false,
  micOn = true,
  camOn = true,
  speaking = false,
}: {
  stream: MediaStream
  label: string
  muted?: boolean
  isLocal?: boolean
  micOn?: boolean
  camOn?: boolean
  speaking?: boolean
}) {
  const videoRef = useRef<HTMLVideoElement>(null)

  useEffect(() => {
    const el = videoRef.current
    if (el && el.srcObject !== stream) {
      el.srcObject = stream
    }
  }, [stream])

  return (
    <div
      className={`tile${isLocal ? ' tile--local' : ''}${speaking ? ' tile--speaking' : ''}`}
    >
      <video ref={videoRef} autoPlay playsInline muted={muted} />
      {!camOn && (
        <div className="tile__avatar">
          <span>{initials(label)}</span>
        </div>
      )}
      <span className="tile__label">
        {!micOn && (
          <span className="tile__mic-off" title="Muted">
            <Icon path={ICONS.micOff} />
          </span>
        )}
        {label}
      </span>
    </div>
  )
}

// ---------------------------------------------------------------------------
// App
// ---------------------------------------------------------------------------
type LobbyStep = 'start' | 'prejoin'

export default function App() {
  const [phase, setPhase] = useState<Phase>('lobby')
  // The shareable link drives the room: if the URL already has ?room=, jump
  // straight to the device-preview (pre-join) step for that meeting.
  const [room, setRoom] = useState(() => roomFromUrl())
  const [lobbyStep, setLobbyStep] = useState<LobbyStep>(() =>
    roomFromUrl() ? 'prejoin' : 'start',
  )
  const [joinCode, setJoinCode] = useState('')
  const [name, setName] = useState('')
  const [error, setError] = useState('')

  const [localStream, setLocalStream] = useState<MediaStream | null>(null)
  const [remoteStreams, setRemoteStreams] = useState<Map<string, MediaStream>>(
    new Map(),
  )
  const [participants, setParticipants] = useState<Participant[]>([])
  const [status, setStatus] = useState('idle')
  const [micOn, setMicOn] = useState(true)
  const [camOn, setCamOn] = useState(true)

  // Chat
  const [messages, setMessages] = useState<ChatMessage[]>([])
  const [chatOpen, setChatOpen] = useState(false)
  const [chatInput, setChatInput] = useState('')
  const [unread, setUnread] = useState(0)

  // Device selection (lobby)
  const [previewStream, setPreviewStream] = useState<MediaStream | null>(null)
  const [cameras, setCameras] = useState<MediaDeviceInfo[]>([])
  const [mics, setMics] = useState<MediaDeviceInfo[]>([])
  const [videoDeviceId, setVideoDeviceId] = useState<string>('')
  const [audioDeviceId, setAudioDeviceId] = useState<string>('')
  const [copied, setCopied] = useState(false)

  const clientRef = useRef<SfuClient | null>(null)
  const previewVideoRef = useRef<HTMLVideoElement>(null)

  const participantsByPeer = useMemo(() => {
    const map = new Map<string, Participant>()
    participants.forEach((p) => map.set(p.peerID, p))
    return map
  }, [participants])

  const remotes = useMemo(
    () => Array.from(remoteStreams.entries()),
    [remoteStreams],
  )

  const activeStreams = useMemo(() => {
    const list: { id: string; stream: MediaStream }[] = []
    if (localStream) list.push({ id: 'local', stream: localStream })
    remotes.forEach(([id, stream]) => list.push({ id, stream }))
    return list
  }, [localStream, remotes])

  const activeSpeaker = useActiveSpeaker(phase === 'call' ? activeStreams : [])

  // --- Lobby preview: acquire camera/mic, enumerate devices ----------------
  // Only at the pre-join step — the landing screen shouldn't grab the camera.
  useEffect(() => {
    if (phase !== 'lobby' || lobbyStep !== 'prejoin') return
    let cancelled = false
    let stream: MediaStream | undefined

    ;(async () => {
      try {
        stream = await navigator.mediaDevices.getUserMedia({
          video: videoDeviceId ? { deviceId: { exact: videoDeviceId } } : true,
          audio: audioDeviceId ? { deviceId: { exact: audioDeviceId } } : true,
        })
        if (cancelled) {
          stream.getTracks().forEach((t) => t.stop())
          return
        }
        stream.getAudioTracks().forEach((t) => (t.enabled = micOn))
        stream.getVideoTracks().forEach((t) => (t.enabled = camOn))
        setPreviewStream(stream)
        setError('')

        const devices = await navigator.mediaDevices.enumerateDevices()
        if (cancelled) return
        setCameras(devices.filter((d) => d.kind === 'videoinput'))
        setMics(devices.filter((d) => d.kind === 'audioinput'))
      } catch {
        if (!cancelled) setError('Camera/microphone permission is required to join.')
      }
    })()

    return () => {
      cancelled = true
      stream?.getTracks().forEach((t) => t.stop())
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [phase, lobbyStep, videoDeviceId, audioDeviceId])

  // Reflect mic/cam toggles onto the live preview without re-acquiring.
  useEffect(() => {
    previewStream?.getAudioTracks().forEach((t) => (t.enabled = micOn))
  }, [micOn, previewStream])
  useEffect(() => {
    previewStream?.getVideoTracks().forEach((t) => (t.enabled = camOn))
  }, [camOn, previewStream])

  // Bind the preview stream to the lobby <video>.
  useEffect(() => {
    if (previewVideoRef.current && previewStream) {
      previewVideoRef.current.srcObject = previewStream
    }
  }, [previewStream, phase])

  // Point the address bar at this meeting so the URL itself is shareable.
  const goToRoom = useCallback((code: string) => {
    setRoom(code)
    history.replaceState(null, '', `/?room=${encodeURIComponent(code)}`)
    setError('')
    setLobbyStep('prejoin')
  }, [])

  const startNewMeeting = useCallback(() => goToRoom(genRoomCode()), [goToRoom])

  const joinWithCode = useCallback(
    (e: React.FormEvent) => {
      e.preventDefault()
      const code = parseRoomInput(joinCode)
      if (!code) {
        setError('Enter a meeting code or paste a meeting link.')
        return
      }
      goToRoom(code)
    },
    [joinCode, goToRoom],
  )

  const backToStart = useCallback(() => {
    history.replaceState(null, '', '/')
    setRoom('')
    setJoinCode('')
    setError('')
    setLobbyStep('start')
  }, [])

  const handleJoin = useCallback(
    async (e: React.FormEvent) => {
      e.preventDefault()
      setError('')

      // Release the preview so join() can re-open the chosen devices cleanly.
      previewStream?.getTracks().forEach((t) => t.stop())
      setPreviewStream(null)

      const client = new SfuClient({
        onLocalStream: setLocalStream,
        onRemoteStream: (id, stream) =>
          setRemoteStreams((prev) => new Map(prev).set(id, stream)),
        onRemoteRemove: (id) =>
          setRemoteStreams((prev) => {
            const next = new Map(prev)
            next.delete(id)
            return next
          }),
        onParticipants: setParticipants,
        onChat: (msg) =>
          setMessages((prev) => {
            setUnread((u) => (chatOpen ? u : u + 1))
            return [...prev, msg]
          }),
        onStatus: setStatus,
      })
      clientRef.current = client

      try {
        await client.join(room.trim() || 'default', name.trim() || 'guest', {
          videoDeviceId: videoDeviceId || undefined,
          audioDeviceId: audioDeviceId || undefined,
          micOn,
          camOn,
        })
        setPhase('call')
      } catch (err) {
        setError(
          err instanceof Error ? err.message : 'Failed to access camera/mic',
        )
        client.leave()
        clientRef.current = null
      }
    },
    [room, name, videoDeviceId, audioDeviceId, micOn, camOn, previewStream, chatOpen],
  )

  const handleLeave = useCallback(() => {
    clientRef.current?.leave()
    clientRef.current = null
    setLocalStream(null)
    setRemoteStreams(new Map())
    setParticipants([])
    setMessages([])
    setUnread(0)
    setChatOpen(false)
    setStatus('idle')
    setMicOn(true)
    setCamOn(true)
    setLobbyStep('prejoin') // keep the meeting link so rejoining is one click
    setPhase('lobby')
  }, [])

  const toggleMic = useCallback(() => {
    setMicOn((on) => {
      clientRef.current?.setMicEnabled(!on)
      return !on
    })
  }, [])

  const toggleCam = useCallback(() => {
    setCamOn((on) => {
      clientRef.current?.setCameraEnabled(!on)
      return !on
    })
  }, [])

  const toggleChat = useCallback(() => {
    setChatOpen((open) => {
      if (!open) setUnread(0)
      return !open
    })
  }, [])

  const sendChat = useCallback(
    (e: React.FormEvent) => {
      e.preventDefault()
      const text = chatInput.trim()
      if (!text) return
      clientRef.current?.sendChat(text)
      setChatInput('')
    },
    [chatInput],
  )

  const copyLink = useCallback(() => {
    const url = `${location.origin}/?room=${encodeURIComponent(room || 'default')}`
    void navigator.clipboard?.writeText(url)
    setCopied(true)
    setTimeout(() => setCopied(false), 1500)
  }, [room])

  // Tear down media when the tab closes or the component unmounts.
  useEffect(() => () => clientRef.current?.leave(), [])

  // -------------------------------------------------------------------------
  // Landing: start a new meeting or join an existing one by code/link.
  if (phase === 'lobby' && lobbyStep === 'start') {
    return (
      <div className="lobby">
        <div className="card">
          <h1>Go Video Conference</h1>
          <p className="subtitle">Pion SFU · WebSocket signaling</p>

          <button type="button" onClick={startNewMeeting}>
            Start a new meeting
          </button>

          <div className="divider">
            <span>or</span>
          </div>

          <form className="join-code" onSubmit={joinWithCode}>
            <label>
              Join with a code or link
              <input
                value={joinCode}
                onChange={(e) => setJoinCode(e.target.value)}
                placeholder="abc-defg-hij or paste a link"
                autoFocus
              />
            </label>
            {error && <p className="error">{error}</p>}
            <button type="submit" className="secondary">
              Join
            </button>
          </form>
        </div>
      </div>
    )
  }

  // Pre-join: device preview + name, with the shareable link front and center.
  if (phase === 'lobby') {
    return (
      <div className="lobby">
        <form className="card" onSubmit={handleJoin}>
          <h1>Ready to join?</h1>
          <p className="subtitle">
            Meeting code: <strong className="code">{room}</strong>
          </p>

          <div className="preview">
            <video ref={previewVideoRef} autoPlay playsInline muted />
            {!camOn && (
              <div className="tile__avatar">
                <span>{initials(name || 'guest')}</span>
              </div>
            )}
            <div className="preview__controls">
              <button
                type="button"
                className={`ctrl${micOn ? '' : ' ctrl--off'}`}
                onClick={() => setMicOn((v) => !v)}
                title={micOn ? 'Mute microphone' : 'Unmute microphone'}
              >
                <Icon path={micOn ? ICONS.mic : ICONS.micOff} />
              </button>
              <button
                type="button"
                className={`ctrl${camOn ? '' : ' ctrl--off'}`}
                onClick={() => setCamOn((v) => !v)}
                title={camOn ? 'Turn camera off' : 'Turn camera on'}
              >
                <Icon path={camOn ? ICONS.cam : ICONS.camOff} />
              </button>
            </div>
          </div>

          <label>
            Camera
            <select
              value={videoDeviceId}
              onChange={(e) => setVideoDeviceId(e.target.value)}
            >
              <option value="">Default camera</option>
              {cameras.map((d, i) => (
                <option key={d.deviceId} value={d.deviceId}>
                  {d.label || `Camera ${i + 1}`}
                </option>
              ))}
            </select>
          </label>

          <label>
            Microphone
            <select
              value={audioDeviceId}
              onChange={(e) => setAudioDeviceId(e.target.value)}
            >
              <option value="">Default microphone</option>
              {mics.map((d, i) => (
                <option key={d.deviceId} value={d.deviceId}>
                  {d.label || `Microphone ${i + 1}`}
                </option>
              ))}
            </select>
          </label>

          <button
            type="button"
            className="link-btn lobby-copy"
            onClick={copyLink}
            title="Copy the joining link"
          >
            <Icon path={ICONS.copy} filled={false} />
            {copied ? 'Link copied' : 'Copy joining link'}
          </button>

          <label>
            Display name
            <input
              value={name}
              onChange={(e) => setName(e.target.value)}
              placeholder="Your name"
              autoFocus
            />
          </label>

          {error && <p className="error">{error}</p>}

          <button type="submit">Join now</button>
          <button type="button" className="text-btn" onClick={backToStart}>
            Use a different meeting
          </button>
        </form>
      </div>
    )
  }

  return (
    <div className="call">
      <header className="topbar">
        <div>
          <strong>Room:</strong> {room || 'default'}
          <button className="link-btn" onClick={copyLink} title="Copy invite link">
            <Icon path={ICONS.copy} filled={false} />
            {copied ? 'Copied' : 'Copy link'}
          </button>
        </div>
        <div className={`status status--${status}`}>{status}</div>
        <div className="people">
          {participants.length} in room
        </div>
      </header>

      <div className="stage">
        <main className="grid">
          {localStream && (
            <VideoTile
              stream={localStream}
              label={`${name || 'guest'} (you)`}
              muted
              isLocal
              micOn={micOn}
              camOn={camOn}
              speaking={activeSpeaker === 'local'}
            />
          )}
          {remotes.map(([id, stream]) => {
            const p = participantsByPeer.get(id)
            return (
              <VideoTile
                key={id}
                stream={stream}
                label={p?.name ?? 'Connecting…'}
                micOn={p?.micOn ?? true}
                camOn={p?.camOn ?? true}
                speaking={activeSpeaker === id}
              />
            )
          })}
          {remotes.length === 0 && (
            <div className="tile tile--empty">
              Waiting for others to join room "{room || 'default'}"…
            </div>
          )}
        </main>

        {chatOpen && (
          <aside className="chat">
            <div className="chat__header">In-call messages</div>
            <div className="chat__messages">
              {messages.length === 0 && (
                <p className="chat__empty">No messages yet.</p>
              )}
              {messages.map((m, i) => (
                <div className="chat__msg" key={`${m.peerID}-${m.ts}-${i}`}>
                  <div className="chat__meta">
                    <span className="chat__from">{m.from}</span>
                    <span className="chat__time">
                      {new Date(m.ts).toLocaleTimeString([], {
                        hour: '2-digit',
                        minute: '2-digit',
                      })}
                    </span>
                  </div>
                  <div className="chat__text">{m.text}</div>
                </div>
              ))}
            </div>
            <form className="chat__form" onSubmit={sendChat}>
              <input
                value={chatInput}
                onChange={(e) => setChatInput(e.target.value)}
                placeholder="Send a message"
              />
              <button type="submit">Send</button>
            </form>
          </aside>
        )}
      </div>

      <footer className="controls">
        <button
          className={`ctrl${micOn ? '' : ' ctrl--off'}`}
          onClick={toggleMic}
          title={micOn ? 'Mute' : 'Unmute'}
        >
          <Icon path={micOn ? ICONS.mic : ICONS.micOff} />
        </button>
        <button
          className={`ctrl${camOn ? '' : ' ctrl--off'}`}
          onClick={toggleCam}
          title={camOn ? 'Stop video' : 'Start video'}
        >
          <Icon path={camOn ? ICONS.cam : ICONS.camOff} />
        </button>
        <button
          className={`ctrl${chatOpen ? ' ctrl--active' : ''}`}
          onClick={toggleChat}
          title="Chat"
        >
          <Icon path={ICONS.chat} />
          {unread > 0 && <span className="ctrl__badge">{unread}</span>}
        </button>
        <button className="ctrl ctrl--leave" onClick={handleLeave} title="Leave">
          <Icon path={ICONS.leave} />
        </button>
      </footer>
    </div>
  )
}
