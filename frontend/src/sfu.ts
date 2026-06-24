// SfuClient drives one browser participant's signaling session against the Go
// SFU. The server is always the offerer: we add our local camera/mic tracks,
// then answer every offer the server sends and trickle ICE candidates back.

export interface Participant {
  peerID: string
  name: string
  micOn: boolean
  camOn: boolean
}

export interface ChatMessage {
  from: string
  peerID: string
  text: string
  ts: number
}

export interface JoinOptions {
  videoDeviceId?: string
  audioDeviceId?: string
  micOn?: boolean
  camOn?: boolean
}

export interface SfuEvents {
  onLocalStream?: (stream: MediaStream) => void
  onRemoteStream?: (streamId: string, stream: MediaStream) => void
  onRemoteRemove?: (streamId: string) => void
  onParticipants?: (users: Participant[]) => void
  onChat?: (message: ChatMessage) => void
  onStatus?: (status: string) => void
}

interface SignalMessage {
  event: 'offer' | 'answer' | 'candidate' | 'participants' | 'chat' | 'state'
  data: string
}

const ICE_SERVERS: RTCIceServer[] = [{ urls: 'stun:stun.l.google.com:19302' }]

export class SfuClient {
  private pc?: RTCPeerConnection
  private ws?: WebSocket
  private localStream?: MediaStream

  constructor(private readonly events: SfuEvents = {}) {}

  async join(room: string, user: string, opts: JoinOptions = {}): Promise<void> {
    // 1. Acquire camera + microphone before negotiating so our first answer
    //    already advertises the outbound tracks. Honor the chosen devices.
    this.localStream = await navigator.mediaDevices.getUserMedia({
      video: opts.videoDeviceId
        ? { deviceId: { exact: opts.videoDeviceId } }
        : true,
      audio: opts.audioDeviceId
        ? { deviceId: { exact: opts.audioDeviceId } }
        : true,
    })

    // Apply the initial mic/camera state chosen in the lobby (default on).
    const micOn = opts.micOn ?? true
    const camOn = opts.camOn ?? true
    this.localStream.getAudioTracks().forEach((t) => (t.enabled = micOn))
    this.localStream.getVideoTracks().forEach((t) => (t.enabled = camOn))
    this.events.onLocalStream?.(this.localStream)

    // 2. Build the peer connection and attach local tracks.
    const pc = new RTCPeerConnection({ iceServers: ICE_SERVERS })
    this.pc = pc
    for (const track of this.localStream.getTracks()) {
      pc.addTrack(track, this.localStream)
    }

    // 3. Surface inbound tracks as one stream per remote participant. The
    //    server sets each fan-out track's stream id to the publisher's peerID.
    pc.ontrack = (event: RTCTrackEvent) => {
      const [stream] = event.streams
      if (!stream) return
      this.events.onRemoteStream?.(stream.id, stream)
      stream.addEventListener('removetrack', () => {
        if (stream.getTracks().length === 0) {
          this.events.onRemoteRemove?.(stream.id)
        }
      })
    }

    pc.onicecandidate = (event) => {
      if (event.candidate) {
        this.send({ event: 'candidate', data: JSON.stringify(event.candidate) })
      }
    }

    pc.onconnectionstatechange = () => {
      this.events.onStatus?.(pc.connectionState)
    }

    // 4. Open the signaling socket (proxied to the Go SFU in dev).
    const proto = location.protocol === 'https:' ? 'wss' : 'ws'
    const url = `${proto}://${location.host}/ws?room=${encodeURIComponent(
      room,
    )}&user=${encodeURIComponent(user)}`
    const ws = new WebSocket(url)
    this.ws = ws

    ws.onopen = () => {
      this.events.onStatus?.('connecting')
      // Announce our initial mic/camera state so other tiles render correctly.
      this.sendState({ micOn, camOn })
    }
    ws.onclose = () => this.events.onStatus?.('disconnected')
    ws.onerror = () => this.events.onStatus?.('error')

    ws.onmessage = async (raw: MessageEvent<string>) => {
      let message: SignalMessage
      try {
        message = JSON.parse(raw.data)
      } catch {
        return
      }

      switch (message.event) {
        case 'offer': {
          const offer = JSON.parse(message.data) as RTCSessionDescriptionInit
          await pc.setRemoteDescription(offer)
          const answer = await pc.createAnswer()
          await pc.setLocalDescription(answer)
          this.send({ event: 'answer', data: JSON.stringify(answer) })
          break
        }
        case 'candidate': {
          const candidate = JSON.parse(message.data) as RTCIceCandidateInit
          try {
            await pc.addIceCandidate(candidate)
          } catch (err) {
            console.error('addIceCandidate failed', err)
          }
          break
        }
        case 'participants': {
          this.events.onParticipants?.(JSON.parse(message.data) as Participant[])
          break
        }
        case 'chat': {
          this.events.onChat?.(JSON.parse(message.data) as ChatMessage)
          break
        }
      }
    }
  }

  setMicEnabled(enabled: boolean): void {
    this.localStream?.getAudioTracks().forEach((t) => (t.enabled = enabled))
    this.sendState({ micOn: enabled, camOn: this.cameraEnabled() })
  }

  setCameraEnabled(enabled: boolean): void {
    this.localStream?.getVideoTracks().forEach((t) => (t.enabled = enabled))
    this.sendState({ micOn: this.micEnabled(), camOn: enabled })
  }

  sendChat(text: string): void {
    const trimmed = text.trim()
    if (trimmed) this.send({ event: 'chat', data: JSON.stringify({ text: trimmed }) })
  }

  private sendState(state: { micOn: boolean; camOn: boolean }): void {
    this.send({ event: 'state', data: JSON.stringify(state) })
  }

  private micEnabled(): boolean {
    return this.localStream?.getAudioTracks().some((t) => t.enabled) ?? false
  }

  private cameraEnabled(): boolean {
    return this.localStream?.getVideoTracks().some((t) => t.enabled) ?? false
  }

  leave(): void {
    this.ws?.close()
    this.pc?.close()
    this.localStream?.getTracks().forEach((t) => t.stop())
    this.ws = undefined
    this.pc = undefined
    this.localStream = undefined
  }

  private send(message: SignalMessage): void {
    if (this.ws?.readyState === WebSocket.OPEN) {
      this.ws.send(JSON.stringify(message))
    }
  }
}
