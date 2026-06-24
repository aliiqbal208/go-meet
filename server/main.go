package main

import (
	"crypto/rand"
	"encoding/hex"
	"encoding/json"
	"log/slog"
	"net/http"
	"os"
	"time"

	"github.com/gin-gonic/gin"
	"github.com/gorilla/websocket"
	"github.com/pion/interceptor"
	"github.com/pion/interceptor/pkg/intervalpli"
	"github.com/pion/webrtc/v4"
)

var (
	api      *webrtc.API
	rooms    = newRoomManager()
	upgrader = websocket.Upgrader{
		ReadBufferSize:  1024,
		WriteBufferSize: 1024,
		// Demo only: allow any origin (e.g. the Vite dev server). Restrict in prod.
		CheckOrigin: func(r *http.Request) bool { return true },
	}
)

func main() {
	slog.SetDefault(slog.New(slog.NewTextHandler(os.Stdout, &slog.HandlerOptions{Level: slog.LevelInfo})))

	var err error
	api, err = newWebRTCAPI()
	if err != nil {
		slog.Error("init webrtc api", "err", err)
		os.Exit(1)
	}

	router := gin.Default()

	router.GET("/ws", handleWebSocket)
	router.GET("/healthz", func(c *gin.Context) { c.String(http.StatusOK, "ok") })

	// Serve the built frontend if it exists (production). During development the
	// Vite dev server runs separately and proxies /ws to this port.
	if _, statErr := os.Stat("../frontend/dist/index.html"); statErr == nil {
		router.Static("/assets", "../frontend/dist/assets")
		router.StaticFile("/", "../frontend/dist/index.html")
	}

	addr := ":" + getenv("PORT", "8088")
	slog.Info("starting server", "addr", addr)
	if err := router.Run(addr); err != nil {
		slog.Error("server stopped", "err", err)
		os.Exit(1)
	}
}

// newPeerID returns a unique-per-connection id of the form "<name>-<hex>". The
// random suffix keeps two tabs with the same display name from colliding on the
// fan-out stream id. Falls back to a bare random id if name is empty.
func newPeerID(name string) string {
	b := make([]byte, 4)
	_, _ = rand.Read(b)
	suffix := hex.EncodeToString(b)
	if name == "" {
		return suffix
	}
	return name + "-" + suffix
}

// getenv returns the environment variable value or a fallback default.
func getenv(key, fallback string) string {
	if v, ok := os.LookupEnv(key); ok && v != "" {
		return v
	}
	return fallback
}

// newWebRTCAPI builds a *webrtc.API with default codecs (VP8/VP9/H264 + Opus),
// default interceptors (NACK, RTCP reports) and a periodic PLI interceptor so
// late subscribers receive keyframes.
func newWebRTCAPI() (*webrtc.API, error) {
	mediaEngine := &webrtc.MediaEngine{}
	if err := mediaEngine.RegisterDefaultCodecs(); err != nil {
		return nil, err
	}

	registry := &interceptor.Registry{}
	if err := webrtc.RegisterDefaultInterceptors(mediaEngine, registry); err != nil {
		return nil, err
	}

	pli, err := intervalpli.NewReceiverInterceptor()
	if err != nil {
		return nil, err
	}
	registry.Add(pli)

	return webrtc.NewAPI(
		webrtc.WithMediaEngine(mediaEngine),
		webrtc.WithInterceptorRegistry(registry),
	), nil
}

// handleWebSocket upgrades the request and drives one peer's signaling session.
// The server is always the offerer; the browser answers and trickles ICE.
func handleWebSocket(c *gin.Context) {
	roomID := c.DefaultQuery("room", "default")
	userID := c.DefaultQuery("user", "anonymous")
	// peerID is unique per connection so two tabs sharing a display name still
	// get distinct fan-out streams (and therefore distinct tiles).
	peerID := newPeerID(userID)
	room := rooms.get(roomID)

	unsafeConn, err := upgrader.Upgrade(c.Writer, c.Request, nil)
	if err != nil {
		slog.Error("websocket upgrade", "err", err)
		return
	}
	ws := &threadSafeWriter{Conn: unsafeConn}
	defer ws.Close()

	peerConnection, err := api.NewPeerConnection(webrtc.Configuration{
		ICEServers: []webrtc.ICEServer{
			{URLs: []string{"stun:stun.l.google.com:19302"}},
		},
	})
	if err != nil {
		slog.Error("create peer connection", "err", err)
		return
	}
	defer peerConnection.Close() //nolint:errcheck

	// Accept one inbound audio and one inbound video track from this peer.
	for _, typ := range []webrtc.RTPCodecType{webrtc.RTPCodecTypeVideo, webrtc.RTPCodecTypeAudio} {
		if _, err := peerConnection.AddTransceiverFromKind(typ, webrtc.RTPTransceiverInit{
			Direction: webrtc.RTPTransceiverDirectionRecvonly,
		}); err != nil {
			slog.Error("add transceiver", "err", err)
			return
		}
	}

	room.addPeer(peerConnection, ws, peerID, userID)

	// Trickle ICE: forward locally gathered candidates to the browser.
	peerConnection.OnICECandidate(func(i *webrtc.ICECandidate) {
		if i == nil {
			return
		}
		candidateString, err := json.Marshal(i.ToJSON())
		if err != nil {
			slog.Error("marshal candidate", "err", err)
			return
		}
		if err := ws.WriteJSON(&websocketMessage{Event: "candidate", Data: string(candidateString)}); err != nil {
			slog.Error("write candidate", "err", err)
		}
	})

	peerConnection.OnConnectionStateChange(func(p webrtc.PeerConnectionState) {
		slog.Info("connection state change", "user", userID, "room", roomID, "state", p.String())
		switch p {
		case webrtc.PeerConnectionStateFailed:
			// Permanently broken — tear it down; the Closed case prunes it.
			_ = peerConnection.Close()
		case webrtc.PeerConnectionStateDisconnected:
			// May recover (transient blip). Give it a grace window, then close
			// it if it hasn't returned to a healthy state, so the room heals.
			go func() {
				time.Sleep(8 * time.Second)
				switch peerConnection.ConnectionState() {
				case webrtc.PeerConnectionStateConnected, webrtc.PeerConnectionStateClosed:
					// recovered, or already gone
				default:
					_ = peerConnection.Close()
				}
			}()
		case webrtc.PeerConnectionStateClosed:
			room.signalPeerConnections()
			room.broadcastParticipants()
		default:
		}
	})

	// Fan out every inbound track to the rest of the room. The fan-out track's
	// stream id is set to this user's id so subscribers can label the tile.
	peerConnection.OnTrack(func(t *webrtc.TrackRemote, _ *webrtc.RTPReceiver) {
		slog.Info("new inbound track", "user", userID, "kind", t.Kind().String())
		local := room.addTrack(t, peerID)
		defer room.removeTrack(local)
		pumpTrack(t, local)
	})

	// Kick off the first negotiation and announce presence.
	room.signalPeerConnections()
	room.broadcastParticipants()

	// Read loop: process answers and remote ICE candidates.
	message := &websocketMessage{}
	for {
		_, raw, err := ws.ReadMessage()
		if err != nil {
			break
		}
		if err := json.Unmarshal(raw, &message); err != nil {
			slog.Error("unmarshal ws message", "err", err)
			continue
		}

		switch message.Event {
		case "candidate":
			candidate := webrtc.ICECandidateInit{}
			if err := json.Unmarshal([]byte(message.Data), &candidate); err != nil {
				slog.Error("unmarshal candidate", "err", err)
				continue
			}
			if err := peerConnection.AddICECandidate(candidate); err != nil {
				slog.Error("add ice candidate", "err", err)
			}
		case "answer":
			answer := webrtc.SessionDescription{}
			if err := json.Unmarshal([]byte(message.Data), &answer); err != nil {
				slog.Error("unmarshal answer", "err", err)
				continue
			}
			if err := peerConnection.SetRemoteDescription(answer); err != nil {
				slog.Error("set remote description", "err", err)
			}
		case "state":
			var s stateIn
			if err := json.Unmarshal([]byte(message.Data), &s); err != nil {
				slog.Error("unmarshal state", "err", err)
				continue
			}
			room.setPeerState(peerID, s.MicOn, s.CamOn)
		case "chat":
			var ch chatIn
			if err := json.Unmarshal([]byte(message.Data), &ch); err != nil {
				slog.Error("unmarshal chat", "err", err)
				continue
			}
			if ch.Text != "" {
				room.broadcastChat(peerID, userID, ch.Text, time.Now().UnixMilli())
			}
		default:
		}
	}

	// Cleanup on disconnect.
	room.removePeer(peerConnection)
	room.signalPeerConnections()
	room.broadcastParticipants()
}
