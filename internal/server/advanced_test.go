package server

import (
	"bytes"
	"context"
	"encoding/json"
	"io"
	"net/http"
	"path/filepath"
	"testing"
	"time"

	"comeet/internal/store"
)

func TestModerationPersistsAcrossReconnect(t *testing.T) {
	a := setup(t)
	host := a.register(t, "host")
	guest := a.register(t, "guest")
	m := a.meeting(t, host)
	path := "/api/meetings/" + m.ID
	a.request(t, "POST", path+"/join", guest.Token, nil, 200, nil)
	c := a.connect(t, m, guest)
	readEvent(t, c, "ready")
	waitMembers(t, c, 1)
	a.request(t, "POST", path+"/moderation", guest.Token, map[string]any{"target": host.User.ID, "action": "mute"}, 403, nil)
	a.request(t, "POST", path+"/moderation", host.Token, map[string]any{"target": guest.User.ID, "action": "mute"}, 200, nil)
	readEvent(t, c, "moderation")
	_ = c.WriteJSON(incoming{Type: "state", Mic: true})
	for {
		values := waitMembers(t, c, 1)
		if values[0].MutedByHost && !values[0].Mic {
			break
		}
	}
	c.Close()
	reconnect := a.connect(t, m, guest)
	readEvent(t, reconnect, "ready")
	values := waitMembers(t, reconnect, 1)
	if !values[0].MutedByHost || values[0].Mic {
		t.Fatal("重连绕过静音限制")
	}
	a.request(t, "POST", path+"/moderation", host.Token, map[string]any{"target": guest.User.ID, "action": "allow-mic"}, 200, nil)
	readEvent(t, reconnect, "moderation")
	a.request(t, "POST", path+"/moderation", host.Token, map[string]any{"target": guest.User.ID, "action": "remove"}, 200, nil)
	readEvent(t, reconnect, "removed")
	a.request(t, "POST", path+"/join", guest.Token, nil, 403, nil)
	late := a.connect(t, m, guest)
	readEvent(t, late, "removed")
	a.request(t, "POST", path+"/media-token", guest.Token, nil, 403, nil)
}

func TestHistoryRecordingAuthenticationAndRange(t *testing.T) {
	a := setup(t)
	a.server.cfg.RecordingDir = t.TempDir()
	host := a.register(t, "host")
	guest := a.register(t, "guest")
	outsider := a.register(t, "outsider")
	m := a.meeting(t, host)
	path := "/api/meetings/" + m.ID
	a.request(t, "POST", path+"/join", guest.Token, nil, 200, nil)
	upload := func(token, contentType string, body []byte, want int) string {
		req, _ := http.NewRequest("POST", a.http.URL+path+"/recordings?duration=3", bytes.NewReader(body))
		req.Header.Set("Authorization", "Bearer "+token)
		req.Header.Set("Content-Type", contentType)
		response, err := http.DefaultClient.Do(req)
		if err != nil {
			t.Fatal(err)
		}
		defer response.Body.Close()
		if response.StatusCode != want {
			b, _ := io.ReadAll(response.Body)
			t.Fatalf("录制上传状态 %d: %s", response.StatusCode, b)
		}
		var envelope struct {
			Data store.Recording `json:"data"`
		}
		_ = json.NewDecoder(response.Body).Decode(&envelope)
		return envelope.Data.ID
	}
	content := append([]byte{0x1a, 0x45, 0xdf, 0xa3}, bytes.Repeat([]byte{0}, 64)...)
	upload(guest.Token, "video/webm", content, 403)
	upload(host.Token, "text/plain", content, 415)
	upload(host.Token, "video/webm", []byte("wrong"), 400)
	// 结束后仍可保存最终片段。
	a.request(t, "POST", path+"/end", host.Token, nil, 200, nil)
	id := upload(host.Token, "video/webm", content, 201)
	if _, err := filepath.Abs(filepath.Join(a.server.cfg.RecordingDir, id+".webm")); err != nil {
		t.Fatal(err)
	}
	var history struct {
		Participants []store.Participant `json:"participants"`
		Recordings   []store.Recording   `json:"recordings"`
	}
	a.request(t, "GET", path+"/history", guest.Token, nil, 200, &history)
	if len(history.Participants) != 2 || len(history.Recordings) != 1 {
		t.Fatal("历史详情缺少参会者或录制")
	}
	a.request(t, "GET", path+"/history", outsider.Token, nil, 403, nil)
	a.request(t, "GET", "/api/recordings/"+id, outsider.Token, nil, 403, nil)
	req, _ := http.NewRequest("GET", a.http.URL+"/api/recordings/"+id, nil)
	req.Header.Set("Authorization", "Bearer "+guest.Token)
	req.Header.Set("Range", "bytes=0-3")
	response, err := http.DefaultClient.Do(req)
	if err != nil {
		t.Fatal(err)
	}
	defer response.Body.Close()
	b, _ := io.ReadAll(response.Body)
	if response.StatusCode != 206 || !bytes.Equal(b, content[:4]) {
		t.Fatalf("Range 回放失败：%d", response.StatusCode)
	}
}

func TestMeetingTimeoutAndMediaReadiness(t *testing.T) {
	a := setup(t)
	host := a.register(t, "host")
	m := a.meeting(t, host)
	path := "/api/meetings/" + m.ID
	a.request(t, "POST", path+"/media-token", host.Token, nil, 409, nil)
	c := a.connect(t, m, host)
	readEvent(t, c, "ready")
	a.request(t, "POST", path+"/media-token", host.Token, nil, 200, nil)
	a.server.cfg.MaxMeetingDuration = time.Nanosecond
	a.server.expireMeetings(context.Background())
	readEvent(t, c, "ended")
	a.request(t, "POST", path+"/join", host.Token, nil, 409, nil)
}
