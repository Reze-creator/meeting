package server

import (
	"bytes"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"path/filepath"
	"strconv"
	"strings"
	"testing"
	"time"

	"comeet/internal/config"
	"comeet/internal/store"
	"github.com/golang-jwt/jwt/v5"
	"github.com/gorilla/websocket"
)

const testOrigin = "http://localhost:5173"
const testSecret = "test-secret-with-more-than-32-characters"

type testApp struct {
	server *Server
	http   *httptest.Server
	db     *store.Store
}
type authResponse struct {
	Token string     `json:"token"`
	User  store.User `json:"user"`
}

func setup(t *testing.T) *testApp {
	t.Helper()
	db, err := store.Open(filepath.Join(t.TempDir(), "test.db"))
	if err != nil {
		t.Fatal(err)
	}
	s := New(db, config.Config{JWTSecret: testSecret, AllowedOrigins: map[string]bool{testOrigin: true}})
	h := httptest.NewServer(s.Handler())
	t.Cleanup(func() { s.Close(); h.Close(); db.Close() })
	return &testApp{server: s, http: h, db: db}
}

func (a *testApp) request(t *testing.T, method, path, token string, body any, want int, target any) {
	t.Helper()
	b, _ := json.Marshal(body)
	req, err := http.NewRequest(method, a.http.URL+path, bytes.NewReader(b))
	if err != nil {
		t.Fatal(err)
	}
	if token != "" {
		req.Header.Set("Authorization", "Bearer "+token)
	}
	req.Header.Set("Content-Type", "application/json")
	resp, err := http.DefaultClient.Do(req)
	if err != nil {
		t.Fatal(err)
	}
	defer resp.Body.Close()
	var out struct {
		Data  json.RawMessage `json:"data"`
		Error *apiError       `json:"error"`
	}
	if err = json.NewDecoder(resp.Body).Decode(&out); err != nil {
		t.Fatal(err)
	}
	if resp.StatusCode != want {
		t.Fatalf("%s %s: got %d, want %d; error=%+v", method, path, resp.StatusCode, want, out.Error)
	}
	if target != nil {
		if err = json.Unmarshal(out.Data, target); err != nil {
			t.Fatal(err)
		}
	}
}
func (a *testApp) register(t *testing.T, name string) authResponse {
	t.Helper()
	var out authResponse
	a.request(t, "POST", "/api/auth/register", "", map[string]string{"username": name, "name": name, "password": "test-password-123"}, 201, &out)
	return out
}
func (a *testApp) meeting(t *testing.T, host authResponse) store.Meeting {
	t.Helper()
	var out store.Meeting
	a.request(t, "POST", "/api/meetings", host.Token, map[string]string{"title": "基础档验收会议"}, 201, &out)
	return out
}

func (a *testApp) connect(t *testing.T, m store.Meeting, u authResponse) *websocket.Conn {
	t.Helper()
	c, _, err := websocket.DefaultDialer.Dial("ws"+strings.TrimPrefix(a.http.URL, "http")+"/ws?meeting="+m.ID, http.Header{"Origin": []string{testOrigin}})
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { c.Close() })
	if err = c.WriteJSON(incoming{Type: "auth", Token: u.Token}); err != nil {
		t.Fatal(err)
	}
	return c
}

type received struct {
	Type string          `json:"type"`
	Data json.RawMessage `json:"data"`
}

func readEvent(t *testing.T, c *websocket.Conn, want string) received {
	t.Helper()
	_ = c.SetReadDeadline(time.Now().Add(4 * time.Second))
	for {
		var event received
		if err := c.ReadJSON(&event); err != nil {
			t.Fatalf("waiting for %s: %v", want, err)
		}
		if event.Type == want {
			return event
		}
	}
}
func waitMembers(t *testing.T, c *websocket.Conn, count int) []member {
	t.Helper()
	for {
		event := readEvent(t, c, "members")
		var values []member
		if err := json.Unmarshal(event.Data, &values); err != nil {
			t.Fatal(err)
		}
		if len(values) == count {
			return values
		}
	}
}

func TestAuthenticationAndMeetingPermissions(t *testing.T) {
	a := setup(t)
	host := a.register(t, "host")
	guest := a.register(t, "guest")
	a.request(t, "POST", "/api/auth/register", "", map[string]string{"username": "host", "name": "重名", "password": "password123"}, 409, nil)
	a.request(t, "POST", "/api/auth/register", "", map[string]string{"username": "bad", "name": "bad", "password": "short"}, 400, nil)
	a.request(t, "POST", "/api/auth/login", "", map[string]string{"username": "host", "password": "wrong"}, 401, nil)
	var logged authResponse
	a.request(t, "POST", "/api/auth/login", "", map[string]string{"username": "host", "password": "test-password-123"}, 200, &logged)
	if logged.User.ID != host.User.ID || logged.Token == "" {
		t.Fatal("登录身份错误")
	}
	a.request(t, "GET", "/api/me", "", nil, 401, nil)
	expired, _ := jwt.NewWithClaims(jwt.SigningMethodHS256, jwt.RegisteredClaims{Subject: "1", Issuer: "comeet", ExpiresAt: jwt.NewNumericDate(time.Now().Add(-time.Hour))}).SignedString([]byte(testSecret))
	a.request(t, "GET", "/api/me", expired, nil, 401, nil)
	a.request(t, "GET", "/api/me", host.Token+"tampered", nil, 401, nil)
	m := a.meeting(t, host)
	a.request(t, "GET", "/api/meetings/"+m.ID, guest.Token, nil, 403, nil)
	a.request(t, "POST", "/api/meetings/123/join", guest.Token, nil, 400, nil)
	a.request(t, "POST", "/api/meetings/000000000/join", guest.Token, nil, 404, nil)
	a.request(t, "POST", "/api/meetings/"+m.ID+"/join", guest.Token, nil, 200, nil)
	a.request(t, "POST", "/api/meetings/"+m.ID+"/end", guest.Token, nil, 403, nil)
	var list []store.Meeting
	a.request(t, "GET", "/api/meetings", guest.Token, nil, 200, &list)
	if len(list) != 1 || list[0].ID != m.ID {
		t.Fatal("参会列表未保存")
	}
	a.request(t, "POST", "/api/meetings/"+m.ID+"/end", host.Token, nil, 200, nil)
	a.request(t, "POST", "/api/meetings/"+m.ID+"/join", guest.Token, nil, 409, nil)
	a.request(t, "POST", "/api/meetings/"+m.ID+"/end", host.Token, nil, 200, nil)
}

func TestRoomChatReconnectAndSessionReplacement(t *testing.T) {
	a := setup(t)
	host := a.register(t, "host")
	guest := a.register(t, "guest")
	m := a.meeting(t, host)
	// Membership is required even when a valid JWT is presented to the WebSocket.
	unauthorized := a.connect(t, m, guest)
	readEvent(t, unauthorized, "unavailable")
	unauthorized.Close()
	a.request(t, "POST", "/api/meetings/"+m.ID+"/join", guest.Token, nil, 200, nil)
	hostConn := a.connect(t, m, host)
	readEvent(t, hostConn, "ready")
	waitMembers(t, hostConn, 1)
	guestConn := a.connect(t, m, guest)
	readEvent(t, guestConn, "ready")
	members := waitMembers(t, hostConn, 2)
	if !members[0].Host && !members[1].Host {
		t.Fatal("主持人标识丢失")
	}
	_ = guestConn.WriteJSON(incoming{Type: "state", Mic: true, Camera: true})
	for {
		values := waitMembers(t, hostConn, 2)
		found := false
		for _, value := range values {
			if value.ID == guest.User.ID && value.Mic && value.Camera {
				found = true
			}
		}
		if found {
			break
		}
	}
	_ = guestConn.WriteJSON(incoming{Type: "chat", Content: "你好，会议伙伴", ClientID: "message-1"})
	readEvent(t, hostConn, "chat")
	readEvent(t, guestConn, "chat")
	// A resend must acknowledge the original persisted row instead of duplicating it.
	time.Sleep(210 * time.Millisecond)
	_ = guestConn.WriteJSON(incoming{Type: "chat", Content: "你好，会议伙伴", ClientID: "message-1"})
	readEvent(t, hostConn, "chat")
	var history []store.Message
	a.request(t, "GET", "/api/meetings/"+m.ID+"/messages", host.Token, nil, 200, &history)
	if len(history) != 1 || history[0].Name != "guest" {
		t.Fatalf("消息持久化/去重失败: %+v", history)
	}
	guestConn.Close()
	waitMembers(t, hostConn, 1)
	_ = hostConn.WriteJSON(incoming{Type: "chat", Content: "断线期间的消息", ClientID: "message-2"})
	readEvent(t, hostConn, "chat")
	reconnected := a.connect(t, m, guest)
	readEvent(t, reconnected, "ready")
	waitMembers(t, hostConn, 2)
	a.request(t, "GET", "/api/meetings/"+m.ID+"/messages?after="+stringID(history[0].ID), guest.Token, nil, 200, &history)
	if len(history) != 1 || history[0].Content != "断线期间的消息" {
		t.Fatal("重连消息补齐失败")
	}
	replacement := a.connect(t, m, guest)
	readEvent(t, replacement, "ready")
	readEvent(t, reconnected, "replaced")
	reconnected.Close()
	// Wait for the replacement snapshot, then prove old cleanup did not remove it.
	waitMembers(t, replacement, 2)
	_ = replacement.WriteJSON(incoming{Type: "chat", Content: "新连接仍可发送", ClientID: "message-3"})
	readEvent(t, hostConn, "chat")
	a.request(t, "POST", "/api/meetings/"+m.ID+"/end", host.Token, nil, 200, nil)
	readEvent(t, hostConn, "ended")
	readEvent(t, replacement, "ended")
	late := a.connect(t, m, host)
	readEvent(t, late, "unavailable")
}

func TestOriginAndInputBoundaries(t *testing.T) {
	a := setup(t)
	host := a.register(t, "host")
	m := a.meeting(t, host)
	_, resp, err := websocket.DefaultDialer.Dial("ws"+strings.TrimPrefix(a.http.URL, "http")+"/ws?meeting="+m.ID, http.Header{"Origin": []string{"http://untrusted.example"}})
	if err == nil || resp.StatusCode != 403 {
		t.Fatal("不可信来源被接受")
	}
	resp.Body.Close()
	a.request(t, "POST", "/api/meetings", host.Token, map[string]string{"title": strings.Repeat("字", 61)}, 400, nil)
	a.request(t, "GET", "/api/meetings/"+m.ID+"/messages?after=-1", host.Token, nil, 400, nil)
	c := a.connect(t, m, host)
	readEvent(t, c, "ready")
	_ = c.WriteJSON(incoming{Type: "chat", Content: strings.Repeat("字", 2001), ClientID: "long"})
	readEvent(t, c, "error")
	var history []store.Message
	a.request(t, "GET", "/api/meetings/"+m.ID+"/messages", host.Token, nil, 200, &history)
	if len(history) != 0 {
		t.Fatal("非法消息写入数据库")
	}
	a.request(t, "POST", "/api/meetings/"+m.ID+"/leave", host.Token, nil, 200, nil)
	readEvent(t, c, "left")
}

func stringID(id int64) string { return strconv.FormatInt(id, 10) }
