package main

import (
	"encoding/json"
	"log/slog"
	"sync"
	"time"

	"github.com/pion/rtcp"
	"github.com/pion/rtp"
	"github.com/pion/webrtc/v4"
)

// peerConnectionState pairs a peer's RTCPeerConnection with its websocket
// writer and the presence metadata for the tile it owns. peerID is the unique
// fan-out stream id; name is the display label; micOn/camOn drive indicators.
type peerConnectionState struct {
	peerConnection *webrtc.PeerConnection
	websocket      *threadSafeWriter
	peerID         string
	name           string
	micOn          bool
	camOn          bool
}

// Room is an isolated SFU session. Every published track is fanned out to all
// other peers in the same room. All shared state is guarded by listLock.
type Room struct {
	id string

	listLock        sync.RWMutex
	peerConnections []peerConnectionState
	trackLocals     map[string]*webrtc.TrackLocalStaticRTP
}

func newRoom(id string) *Room {
	return &Room{
		id:          id,
		trackLocals: map[string]*webrtc.TrackLocalStaticRTP{},
	}
}

// addPeer registers a freshly created peer connection in the room. Mic and
// camera start enabled; the browser corrects this with a "state" message if it
// joined muted or with video off.
func (r *Room) addPeer(pc *webrtc.PeerConnection, ws *threadSafeWriter, peerID, name string) {
	r.listLock.Lock()
	r.peerConnections = append(r.peerConnections, peerConnectionState{
		peerConnection: pc,
		websocket:      ws,
		peerID:         peerID,
		name:           name,
		micOn:          true,
		camOn:          true,
	})
	r.listLock.Unlock()
}

// removePeer drops a peer connection from the room (on disconnect).
func (r *Room) removePeer(pc *webrtc.PeerConnection) {
	r.listLock.Lock()
	for i := range r.peerConnections {
		if r.peerConnections[i].peerConnection == pc {
			r.peerConnections = append(r.peerConnections[:i], r.peerConnections[i+1:]...)
			break
		}
	}
	r.listLock.Unlock()
}

// addTrack creates a local fan-out track mirroring an inbound remote track and
// triggers renegotiation so every other peer starts receiving it. streamID is
// the publisher's unique peerID so subscribers can map the remote tile to the
// publisher's presence entry (name, mic/cam state).
func (r *Room) addTrack(t *webrtc.TrackRemote, streamID string) *webrtc.TrackLocalStaticRTP {
	r.listLock.Lock()
	defer func() {
		r.listLock.Unlock()
		r.signalPeerConnections()
	}()

	trackLocal, err := webrtc.NewTrackLocalStaticRTP(t.Codec().RTPCodecCapability, t.ID(), streamID)
	if err != nil {
		slog.Error("create local track", "err", err)
		return nil
	}

	r.trackLocals[t.ID()] = trackLocal
	return trackLocal
}

// removeTrack tears down a fan-out track once its publisher goes away.
func (r *Room) removeTrack(t *webrtc.TrackLocalStaticRTP) {
	if t == nil {
		return
	}
	r.listLock.Lock()
	defer func() {
		r.listLock.Unlock()
		r.signalPeerConnections()
	}()

	delete(r.trackLocals, t.ID())
}

// signalPeerConnections reconciles every peer's senders with the current set of
// fan-out tracks, renegotiating (server-initiated offer) where needed. A peer
// that cannot be negotiated (closed, failed, or with a dead socket) is pruned so
// that one bad peer can never starve renegotiation for the rest of the room.
func (r *Room) signalPeerConnections() {
	r.listLock.Lock()
	defer func() {
		r.listLock.Unlock()
		r.dispatchKeyFrame()
	}()

	attemptSync := func() (tryAgain bool) {
		for i := range r.peerConnections {
			pc := r.peerConnections[i].peerConnection

			// Drop peers that have already gone away.
			if pc.ConnectionState() == webrtc.PeerConnectionStateClosed {
				r.peerConnections = append(r.peerConnections[:i], r.peerConnections[i+1:]...)
				return true // slice mutated, restart
			}

			// Reconcile + (re)offer this one peer. If it can't be negotiated,
			// close and remove it rather than retrying it forever in place —
			// otherwise a single wedged peer blocks the whole room.
			if err := r.syncPeer(&r.peerConnections[i]); err != nil {
				slog.Warn("pruning unsyncable peer", "peer", r.peerConnections[i].peerID, "err", err)
				_ = pc.Close()
				r.peerConnections = append(r.peerConnections[:i], r.peerConnections[i+1:]...)
				return true // slice mutated, restart
			}
		}
		return false
	}

	for syncAttempt := 0; ; syncAttempt++ {
		if syncAttempt == 25 {
			// Still churning (rapid join/leave). Back off and retry shortly.
			go func() {
				time.Sleep(time.Second * 3)
				r.signalPeerConnections()
			}()
			return
		}
		if !attemptSync() {
			break
		}
	}
}

// syncPeer reconciles one peer's senders with the room's fan-out tracks and, if
// needed, sends it a fresh server-initiated offer. It returns an error only when
// the peer connection or its socket is unusable — the caller prunes on error.
func (r *Room) syncPeer(ps *peerConnectionState) error {
	pc := ps.peerConnection

	// Tracks this peer is already sending or receiving.
	existingSenders := map[string]bool{}
	for _, sender := range pc.GetSenders() {
		if sender.Track() == nil {
			continue
		}
		existingSenders[sender.Track().ID()] = true

		// Sender maps to a track that no longer exists -> remove it.
		if _, ok := r.trackLocals[sender.Track().ID()]; !ok {
			if err := pc.RemoveTrack(sender); err != nil {
				return err
			}
		}
	}

	// Never send a peer its own track (avoid loopback).
	for _, receiver := range pc.GetReceivers() {
		if receiver.Track() == nil {
			continue
		}
		existingSenders[receiver.Track().ID()] = true
	}

	// Add any fan-out track this peer isn't yet sending.
	for trackID := range r.trackLocals {
		if _, ok := existingSenders[trackID]; !ok {
			if _, err := pc.AddTrack(r.trackLocals[trackID]); err != nil {
				return err
			}
		}
	}

	offer, err := pc.CreateOffer(nil)
	if err != nil {
		return err
	}
	if err := pc.SetLocalDescription(offer); err != nil {
		return err
	}

	offerString, err := json.Marshal(offer)
	if err != nil {
		return err
	}
	return ps.websocket.WriteJSON(&websocketMessage{Event: "offer", Data: string(offerString)})
}

// dispatchKeyFrame asks every publisher for a keyframe so newly subscribed
// peers can start decoding video immediately.
func (r *Room) dispatchKeyFrame() {
	r.listLock.Lock()
	defer r.listLock.Unlock()

	for i := range r.peerConnections {
		for _, receiver := range r.peerConnections[i].peerConnection.GetReceivers() {
			if receiver.Track() == nil {
				continue
			}
			_ = r.peerConnections[i].peerConnection.WriteRTCP([]rtcp.Packet{
				&rtcp.PictureLossIndication{MediaSSRC: uint32(receiver.Track().SSRC())},
			})
		}
	}
}

// broadcastParticipants pushes the current presence list (peerID, name, mic/cam
// state) to every peer in the room.
func (r *Room) broadcastParticipants() {
	r.listLock.RLock()
	users := make([]participant, 0, len(r.peerConnections))
	writers := make([]*threadSafeWriter, 0, len(r.peerConnections))
	for _, pc := range r.peerConnections {
		users = append(users, participant{
			PeerID: pc.peerID,
			Name:   pc.name,
			MicOn:  pc.micOn,
			CamOn:  pc.camOn,
		})
		writers = append(writers, pc.websocket)
	}
	r.listLock.RUnlock()

	data, err := json.Marshal(users)
	if err != nil {
		slog.Error("marshal participants", "err", err)
		return
	}
	for _, w := range writers {
		_ = w.WriteJSON(&websocketMessage{Event: "participants", Data: string(data)})
	}
}

// setPeerState records a peer's latest mic/camera state and re-broadcasts the
// presence list so every tile updates its indicators.
func (r *Room) setPeerState(peerID string, micOn, camOn bool) {
	r.listLock.Lock()
	for i := range r.peerConnections {
		if r.peerConnections[i].peerID == peerID {
			r.peerConnections[i].micOn = micOn
			r.peerConnections[i].camOn = camOn
			break
		}
	}
	r.listLock.Unlock()

	r.broadcastParticipants()
}

// broadcastChat fans a chat message out to every peer in the room (including the
// sender, so all clients render an identical, server-ordered transcript).
func (r *Room) broadcastChat(fromPeerID, fromName, text string, tsMillis int64) {
	data, err := json.Marshal(chatOut{
		From:   fromName,
		PeerID: fromPeerID,
		Text:   text,
		TS:     tsMillis,
	})
	if err != nil {
		slog.Error("marshal chat", "err", err)
		return
	}

	r.listLock.RLock()
	writers := make([]*threadSafeWriter, 0, len(r.peerConnections))
	for _, pc := range r.peerConnections {
		writers = append(writers, pc.websocket)
	}
	r.listLock.RUnlock()

	for _, w := range writers {
		_ = w.WriteJSON(&websocketMessage{Event: "chat", Data: string(data)})
	}
}

// pumpTrack copies RTP packets from an inbound remote track into its fan-out
// local track until the remote side stops.
func pumpTrack(remote *webrtc.TrackRemote, local *webrtc.TrackLocalStaticRTP) {
	if local == nil {
		return
	}
	buf := make([]byte, 1500)
	pkt := &rtp.Packet{}
	for {
		i, _, err := remote.Read(buf)
		if err != nil {
			return
		}
		if err = pkt.Unmarshal(buf[:i]); err != nil {
			slog.Error("unmarshal rtp", "err", err)
			return
		}
		// Strip extensions; they aren't negotiated on the fan-out track.
		pkt.Extension = false
		pkt.Extensions = nil
		if err = local.WriteRTP(pkt); err != nil {
			return
		}
	}
}

// RoomManager lazily creates and hands out rooms by id.
type RoomManager struct {
	mu    sync.Mutex
	rooms map[string]*Room
}

func newRoomManager() *RoomManager {
	return &RoomManager{rooms: map[string]*Room{}}
}

func (m *RoomManager) get(id string) *Room {
	m.mu.Lock()
	defer m.mu.Unlock()

	room, ok := m.rooms[id]
	if !ok {
		room = newRoom(id)
		m.rooms[id] = room
	}
	return room
}
