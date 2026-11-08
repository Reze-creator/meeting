package server

import (
	"context"
	"encoding/json"
	"log/slog"
	"net/http"
	"strings"
	"sync"
	"time"
	"unicode/utf8"

	"comeet/internal/store"
	"github.com/gorilla/websocket"
)

type member struct {
	ID        int64  `json:"id"`
	Name      string `json:"name"`
	Host      bool   `json:"host"`
	Mic       bool   `json:"mic"`
	Camera    bool   `json:"camera"`
	SessionID string `json:"sessionId"`
}
type event struct {
	Type string `json:"type"`
	Data any    `json:"data,omitempty"`
}
type incoming struct {
	Type     string          `json:"type"`
	Token    string          `json:"token,omitempty"`
	Content  string          `json:"content,omitempty"`
	ClientID string          `json:"clientId,omitempty"`
	Mic      bool            `json:"mic"`
	Camera   bool            `json:"camera"`
	Target   int64           `json:"target,omitempty"`
	Signal   json.RawMessage `json:"signal,omitempty"`
}
type client struct {
	conn        *websocket.Conn
	send        chan event
	user        store.User
	meetingID   string
	member      member
	lastMessage time.Time
	expiresAt   time.Time
}

// Hub 串行处理房间变更。每个连接只有 writeLoop 写入，读取协程仅负责入队。
// 清理旧连接时必须核对连接身份，避免把同一用户的新连接移出房间。
type Hub struct {
	mu     sync.Mutex
	rooms  map[string]map[int64]*client
	store  *store.Store
	closed bool
	wg     sync.WaitGroup
}

func newHub(s *store.Store) *Hub { return &Hub{rooms: map[string]map[int64]*client{}, store: s} }
func (h *Hub) enqueue(c *client, e event) {
	select {
	case c.send <- e:
	default:
		_ = c.conn.Close()
	}
}
func (h *Hub) broadcastLocked(id string, e event) {
	for _, c := range h.rooms[id] {
		h.enqueue(c, e)
	}
}
func (h *Hub) membersLocked(id string) {
	members := []member{}
	for _, c := range h.rooms[id] {
		members = append(members, c.member)
	}
	h.broadcastLocked(id, event{Type: "members", Data: members})
}
func (h *Hub) detach(c *client) {
	h.mu.Lock()
	defer h.mu.Unlock()
	room := h.rooms[c.meetingID]
	if room[c.user.ID] != c {
		return
	}
	delete(room, c.user.ID)
	close(c.send)
	ctx, cancel := context.WithTimeout(context.Background(), 3*time.Second)
	defer cancel()
	if err := h.store.SetOnline(ctx, c.meetingID, c.user.ID, false); err != nil {
		slog.Error("更新离会状态失败", "error", err)
	}
	h.membersLocked(c.meetingID)
	if len(room) == 0 {
		delete(h.rooms, c.meetingID)
	}
}
func (h *Hub) leave(id string, userID int64) {
	h.mu.Lock()
	defer h.mu.Unlock()
	if c := h.rooms[id][userID]; c != nil {
		h.enqueue(c, event{Type: "left"})
		close(c.send)
		delete(h.rooms[id], userID)
		h.membersLocked(id)
		if len(h.rooms[id]) == 0 {
			delete(h.rooms, id)
		}
	}
	ctx, cancel := context.WithTimeout(context.Background(), 3*time.Second)
	defer cancel()
	if err := h.store.SetOnline(ctx, id, userID, false); err != nil {
		slog.Error("更新离会状态失败", "error", err)
	}
}
func (h *Hub) endLocked(id string) {
	for _, c := range h.rooms[id] {
		h.enqueue(c, event{Type: "ended"})
		close(c.send)
	}
	delete(h.rooms, id)
}
func (h *Hub) close() {
	h.mu.Lock()
	h.closed = true
	for id := range h.rooms {
		for _, c := range h.rooms[id] {
			_ = c.conn.Close()
		}
	}
	h.mu.Unlock()
	// 等待读写协程退出后再关闭数据库，避免退出时仍有离会状态写入。
	h.wg.Wait()
}

func (s *Server) websocket(w http.ResponseWriter, r *http.Request) {
	id := r.URL.Query().Get("meeting")
	if !meetingPattern.MatchString(id) {
		fail(w, 400, "INVALID_MEETING_ID", "会议号无效")
		return
	}
	up := websocket.Upgrader{ReadBufferSize: 4096, WriteBufferSize: 4096, CheckOrigin: func(r *http.Request) bool { return s.cfg.AllowedOrigins[r.Header.Get("Origin")] }}
	conn, err := up.Upgrade(w, r, nil)
	if err != nil {
		return
	}
	defer conn.Close()
	// JWT 放在首帧中，避免通过 URL 进入访问日志或浏览器历史。
	conn.SetReadLimit(16 << 10)
	_ = conn.SetReadDeadline(time.Now().Add(5 * time.Second))
	var first incoming
	if err = conn.ReadJSON(&first); err != nil || first.Type != "auth" {
		return
	}
	u, expiresAt, err := s.parseToken(first.Token)
	if err != nil {
		_ = conn.WriteJSON(event{Type: "unauthorized"})
		return
	}
	c := &client{conn: conn, send: make(chan event, 128), user: u, meetingID: id, expiresAt: expiresAt}
	s.hub.mu.Lock()
	ctx, cancel := context.WithTimeout(context.Background(), 3*time.Second)
	m, err := s.store.Meeting(ctx, id)
	if err != nil || m.EndedAt != nil || !s.store.HasParticipant(ctx, id, u.ID) || s.hub.closed {
		cancel()
		s.hub.mu.Unlock()
		_ = conn.WriteJSON(event{Type: "unavailable"})
		return
	}
	if err = s.store.SetOnline(ctx, id, u.ID, true); err != nil {
		cancel()
		s.hub.mu.Unlock()
		return
	}
	cancel()
	if s.hub.rooms[id] == nil {
		s.hub.rooms[id] = map[int64]*client{}
	}
	room := s.hub.rooms[id]
	if old := room[u.ID]; old != nil {
		s.hub.enqueue(old, event{Type: "replaced"})
		close(old.send)
	}
	c.member = member{ID: u.ID, Name: u.Name, Host: u.ID == m.HostID, Mic: first.Mic, Camera: first.Camera, SessionID: randomID()}
	room[u.ID] = c
	s.hub.enqueue(c, event{Type: "ready", Data: map[string]any{"meeting": m, "sessionId": c.member.SessionID}})
	s.hub.membersLocked(id)
	s.hub.wg.Add(2)
	s.hub.mu.Unlock()
	defer s.hub.wg.Done()
	go func() { defer s.hub.wg.Done(); c.writeLoop() }()
	defer s.hub.detach(c)
	_ = conn.SetReadDeadline(time.Now().Add(60 * time.Second))
	conn.SetPongHandler(func(string) error { return conn.SetReadDeadline(time.Now().Add(60 * time.Second)) })
	for {
		var in incoming
		if err := conn.ReadJSON(&in); err != nil {
			return
		}
		if !s.hub.handle(c, in) {
			return
		}
	}
}

func (c *client) writeLoop() {
	ticker := time.NewTicker(25 * time.Second)
	expiry := time.NewTimer(time.Until(c.expiresAt))
	defer expiry.Stop()
	defer ticker.Stop()
	defer c.conn.Close()
	for {
		select {
		case <-expiry.C:
			_ = c.conn.SetWriteDeadline(time.Now().Add(5 * time.Second))
			_ = c.conn.WriteJSON(event{Type: "unauthorized"})
			return
		case e, ok := <-c.send:
			if !ok {
				return
			}
			_ = c.conn.SetWriteDeadline(time.Now().Add(5 * time.Second))
			if err := c.conn.WriteJSON(e); err != nil {
				return
			}
		case <-ticker.C:
			_ = c.conn.SetWriteDeadline(time.Now().Add(5 * time.Second))
			if err := c.conn.WriteMessage(websocket.PingMessage, nil); err != nil {
				return
			}
		}
	}
}

func (h *Hub) handle(c *client, in incoming) bool {
	h.mu.Lock()
	defer h.mu.Unlock()
	room := h.rooms[c.meetingID]
	if room[c.user.ID] != c {
		return false
	}
	switch in.Type {
	case "state":
		c.member.Mic = in.Mic
		c.member.Camera = in.Camera
		h.membersLocked(c.meetingID)
	case "chat":
		content := strings.TrimSpace(in.Content)
		if utf8.RuneCountInString(content) == 0 || utf8.RuneCountInString(content) > 2000 || len(in.ClientID) < 1 || len(in.ClientID) > 64 {
			h.enqueue(c, event{Type: "error", Data: apiError{Code: "INVALID_MESSAGE", Message: "消息需为 1–2000 字"}})
			return true
		}
		if time.Since(c.lastMessage) < 200*time.Millisecond {
			h.enqueue(c, event{Type: "error", Data: apiError{Code: "RATE_LIMITED", Message: "发送过快，请稍后再试"}})
			return true
		}
		c.lastMessage = time.Now()
		ctx, cancel := context.WithTimeout(context.Background(), 3*time.Second)
		defer cancel()
		m, err := h.store.AddMessage(ctx, c.meetingID, c.user, in.ClientID, content)
		if err != nil {
			slog.Error("保存消息失败", "error", err)
			h.enqueue(c, event{Type: "error", Data: apiError{Code: "MESSAGE_FAILED", Message: "消息保存失败，请重试"}})
			return true
		}
		h.broadcastLocked(c.meetingID, event{Type: "chat", Data: m})
	case "signal":
		if target := room[in.Target]; target != nil && target != c && len(in.Signal) > 0 {
			h.enqueue(target, event{Type: "signal", Data: map[string]any{"from": c.user.ID, "sessionId": c.member.SessionID, "signal": in.Signal}})
		}
	case "leave":
		return false
	default:
		h.enqueue(c, event{Type: "error", Data: apiError{Code: "UNKNOWN_EVENT", Message: "不支持的消息类型"}})
	}
	return true
}
