package media

import (
	"context"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"

	"github.com/golang-jwt/jwt/v5"
)

func TestTokenScopeAndMutedSources(t *testing.T) {
	c := &Client{Key: "key", Secret: "server-only-secret"}
	raw, err := c.JoinToken("123456789", 42, "成员", true)
	if err != nil {
		t.Fatal(err)
	}
	token, err := jwt.Parse(raw, func(*jwt.Token) (any, error) { return []byte(c.Secret), nil }, jwt.WithValidMethods([]string{"HS256"}))
	if err != nil {
		t.Fatal(err)
	}
	claims := token.Claims.(jwt.MapClaims)
	grant := claims["video"].(map[string]any)
	if claims["sub"] != "42" || grant["room"] != "123456789" || grant["roomAdmin"] != nil {
		t.Fatal("令牌越权")
	}
	for _, source := range grant["canPublishSources"].([]any) {
		if source == "microphone" {
			t.Fatal("被限制成员获得麦克风权限")
		}
	}
}
func TestModerationCallsAndFailurePropagation(t *testing.T) {
	calls := []string{}
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		method := strings.TrimPrefix(r.URL.Path, "/twirp/livekit.RoomService/")
		calls = append(calls, method)
		token := strings.TrimPrefix(r.Header.Get("Authorization"), "Bearer ")
		if _, err := jwt.Parse(token, func(*jwt.Token) (any, error) { return []byte("secret"), nil }); err != nil {
			t.Error(err)
		}
		var input map[string]any
		_ = json.NewDecoder(r.Body).Decode(&input)
		if input["room"] != "room" {
			t.Error("房间范围缺失")
		}
		if method == "GetParticipant" {
			_, _ = w.Write([]byte(`{"tracks":[{"sid":"TR_microphone","source":"MICROPHONE"}]}`))
			return
		}
		if method == "DeleteRoom" {
			w.WriteHeader(503)
			return
		}
		_, _ = w.Write([]byte(`{}`))
	}))
	defer server.Close()
	c := &Client{URL: server.URL, InternalURL: server.URL, Key: "key", Secret: "secret", HTTP: server.Client()}
	if err := c.Mute(context.Background(), "room", 1, true); err != nil {
		t.Fatal(err)
	}
	if strings.Join(calls, ",") != "UpdateParticipant,GetParticipant,MutePublishedTrack" {
		t.Fatal(calls)
	}
	if err := c.End(context.Background(), "room"); err == nil {
		t.Fatal("不能将媒体服务错误伪装成成功")
	}
}
