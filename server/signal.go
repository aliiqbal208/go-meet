package main

import (
	"sync"

	"github.com/gorilla/websocket"
)

// websocketMessage is the envelope exchanged between the browser and the SFU.
// Event is one of: "offer", "answer", "candidate", "participants", "chat", "state".
// Data carries a JSON-encoded payload appropriate for the event.
type websocketMessage struct {
	Event string `json:"event"`
	Data  string `json:"data"`
}

// participant is one entry in the presence list broadcast to the room. peerID is
// the unique fan-out stream id (so duplicate display names never collide); name
// is the human-facing label; micOn/camOn drive the per-tile indicators.
type participant struct {
	PeerID string `json:"peerID"`
	Name   string `json:"name"`
	MicOn  bool   `json:"micOn"`
	CamOn  bool   `json:"camOn"`
}

// stateIn is the payload of an inbound "state" message: a peer announcing its
// current mic/camera state so other peers can update its tile.
type stateIn struct {
	MicOn bool `json:"micOn"`
	CamOn bool `json:"camOn"`
}

// chatIn is the payload of an inbound "chat" message from a peer.
type chatIn struct {
	Text string `json:"text"`
}

// chatOut is the payload of an outbound "chat" message fanned out to the room.
type chatOut struct {
	From   string `json:"from"`
	PeerID string `json:"peerID"`
	Text   string `json:"text"`
	TS     int64  `json:"ts"`
}

// threadSafeWriter wraps a *websocket.Conn so that concurrent goroutines
// (the read loop, ICE callbacks, renegotiation) can write without racing.
type threadSafeWriter struct {
	*websocket.Conn
	sync.Mutex
}

// WriteJSON serializes v and writes it to the socket while holding the lock.
func (t *threadSafeWriter) WriteJSON(v interface{}) error {
	t.Lock()
	defer t.Unlock()

	return t.Conn.WriteJSON(v)
}
