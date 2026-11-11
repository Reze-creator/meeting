package server

import (
	"bytes"
	"context"
	"encoding/binary"
	"encoding/json"
	"io"
	"net/http"
	"net/http/httptest"
	"net/url"
	"strconv"
	"strings"
	"sync/atomic"
	"testing"
	"time"

	"comeet/internal/store"
)

func speechWAV() []byte {
	data := make([]byte, 44+16000*2)
	copy(data, "RIFF")
	binary.LittleEndian.PutUint32(data[4:], uint32(len(data)-8))
	copy(data[8:], "WAVEfmt ")
	binary.LittleEndian.PutUint32(data[16:], 16)
	binary.LittleEndian.PutUint16(data[20:], 1)
	binary.LittleEndian.PutUint16(data[22:], 1)
	binary.LittleEndian.PutUint32(data[24:], 16000)
	binary.LittleEndian.PutUint32(data[28:], 32000)
	binary.LittleEndian.PutUint16(data[32:], 2)
	binary.LittleEndian.PutUint16(data[34:], 16)
	copy(data[36:], "data")
	binary.LittleEndian.PutUint32(data[40:], 32000)
	return data
}
func TestSpeechWAVValidation(t *testing.T) {
	data := speechWAV()
	if duration, ok := validateSpeechWAV(data); !ok || duration != 1 {
		t.Fatal("合法 WAV 未通过")
	}
	for _, offset := range []int{0, 4, 8, 12, 16, 20, 22, 24, 28, 32, 34, 36, 40} {
		bad := append([]byte{}, data...)
		bad[offset] ^= 0xff
		if _, ok := validateSpeechWAV(bad); ok {
			t.Fatalf("接受损坏 WAV 字段 %d", offset)
		}
	}
	if _, ok := validateSpeechWAV(data[:20]); ok {
		t.Fatal("接受截断音频")
	}
}
func TestCaptionsAuthenticationDedupeAndLateModeration(t *testing.T) {
	a := setup(t)
	host := a.register(t, "host")
	other := a.register(t, "other")
	m := a.meeting(t, host)
	path := "/api/meetings/" + m.ID
	var calls atomic.Int32
	entered, release := make(chan struct{}), make(chan struct{})
	provider := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		calls.Add(1)
		if r.URL.Path != "/v1/audio/transcriptions" || r.Header.Get("Authorization") != "Bearer stt-secret" {
			t.Error("STT 地址/鉴权错误")
		}
		if err := r.ParseMultipartForm(2 << 20); err != nil {
			t.Error(err)
		} else {
			defer r.MultipartForm.RemoveAll()
		}
		if calls.Load() == 2 {
			close(entered)
			<-release
		}
		w.Header().Set("Content-Type", "application/json")
		_, _ = io.WriteString(w, `{"text":"周五前完成测试。"}`)
	}))
	defer provider.Close()
	a.server.cfg.STTURL = provider.URL + "/v1"
	a.server.intelligence.STTURL = provider.URL + "/v1"
	a.server.intelligence.STTKey = "stt-secret"
	c := a.connect(t, m, host)
	ready := readEvent(t, c, "ready")
	var data struct {
		SessionID string `json:"sessionId"`
	}
	_ = json.Unmarshal(ready.Data, &data)
	waitMembers(t, c, 1)
	upload := func(clientID, session string, want int) {
		t.Helper()
		query := url.Values{"clientId": {clientID}, "sessionId": {session}, "startedAt": {time.Now().UTC().Format(time.RFC3339Nano)}}
		req, _ := http.NewRequest("POST", a.http.URL+path+"/transcribe?"+query.Encode(), bytes.NewReader(speechWAV()))
		req.Header.Set("Authorization", "Bearer "+host.Token)
		req.Header.Set("Content-Type", "audio/wav")
		response, err := http.DefaultClient.Do(req)
		if err != nil {
			t.Error(err)
			return
		}
		defer response.Body.Close()
		if response.StatusCode != want {
			body, _ := io.ReadAll(response.Body)
			t.Errorf("字幕状态 %d，预期 %d: %s", response.StatusCode, want, body)
		}
	}
	upload("clip00001", data.SessionID, 403)
	_ = c.WriteJSON(incoming{Type: "state", Mic: true, Captioning: true})
	waitMembers(t, c, 1)
	upload("clip00001", "wrong-session", 403)
	upload("clip00001", data.SessionID, 201)
	readEvent(t, c, "caption")
	upload("clip00001", data.SessionID, 200)
	if calls.Load() != 1 {
		t.Fatal("重试重复调用 STT")
	}
	a.request(t, "GET", path+"/captions", other.Token, nil, 403, nil)
	done := make(chan struct{})
	go func() { defer close(done); upload("clip00002", data.SessionID, 409) }()
	select {
	case <-entered:
	case <-time.After(3 * time.Second):
		t.Fatal("未进入识别")
	}
	_ = c.WriteJSON(incoming{Type: "state", Mic: false, Captioning: false})
	waitMembers(t, c, 1)
	close(release)
	<-done
	var captions []store.Caption
	a.request(t, "GET", path+"/captions", host.Token, nil, 200, &captions)
	if len(captions) != 1 || captions[0].UserID != host.User.ID || captions[0].Text != "周五前完成测试。" {
		t.Fatal("字幕身份、去重或迟到结果检查失败")
	}
}
func TestMinutesHostOnlyStalenessFailurePreservesSaved(t *testing.T) {
	a := setup(t)
	host := a.register(t, "host")
	guest := a.register(t, "guest")
	m := a.meeting(t, host)
	path := "/api/meetings/" + m.ID
	a.request(t, "POST", path+"/join", guest.Token, nil, 200, nil)
	var fail atomic.Bool
	provider := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.Header.Get("Authorization") != "Bearer deepseek-test" {
			t.Error("DeepSeek 密钥未在服务端传递")
		}
		var payload struct {
			Model          string `json:"model"`
			Messages       []struct{ Role, Content string }
			ResponseFormat map[string]string `json:"response_format"`
		}
		if err := json.NewDecoder(r.Body).Decode(&payload); err != nil {
			t.Error(err)
		}
		if payload.Model != "deepseek-flash" || payload.ResponseFormat["type"] != "json_object" || len(payload.Messages) != 2 {
			t.Error("DeepSeek 请求结构错误")
		}
		if fail.Load() {
			w.WriteHeader(429)
			_, _ = io.WriteString(w, "secret-upstream-error")
			return
		}
		content := `{"overview":"讨论测试计划","decisions":["周五验收"],"actions":[{"task":"补充测试","owner":"未明确","due":"周五"}],"risks":null}`
		_ = json.NewEncoder(w).Encode(map[string]any{"choices": []any{map[string]any{"message": map[string]string{"content": content}, "finish_reason": "stop"}}})
	}))
	defer provider.Close()
	a.server.cfg.DeepSeekKey = "deepseek-test"
	a.server.cfg.DeepSeekModel = "deepseek-flash"
	a.server.intelligence.DeepSeekURL = provider.URL
	a.server.intelligence.DeepSeekKey = "deepseek-test"
	a.server.intelligence.DeepSeekModel = "deepseek-flash"
	a.request(t, "POST", path+"/minutes", host.Token, nil, 422, nil)
	_, err := a.db.AddMessage(context.Background(), m.ID, host.User, "msg-1", "周五验收，请补充测试。")
	if err != nil {
		t.Fatal(err)
	}
	a.request(t, "POST", path+"/minutes", guest.Token, nil, 403, nil)
	var result struct {
		Minutes store.Minutes `json:"minutes"`
		Stale   bool          `json:"stale"`
	}
	a.request(t, "POST", path+"/minutes", host.Token, nil, 200, &result)
	if result.Stale || !strings.Contains(string(result.Minutes.Content), "周五验收") || !strings.Contains(string(result.Minutes.Content), `"risks":[]`) {
		t.Fatal("纪要保存或结构错误")
	}
	hash := result.Minutes.SourceHash
	_, _ = a.db.AddMessage(context.Background(), m.ID, host.User, "msg-2", "新增资料")
	a.request(t, "GET", path+"/minutes", guest.Token, nil, 200, &result)
	if !result.Stale {
		t.Fatal("未提示资料变更")
	}
	fail.Store(true)
	a.request(t, "POST", path+"/minutes", host.Token, nil, 502, nil)
	a.request(t, "GET", path+"/minutes", host.Token, nil, 200, &result)
	if result.Minutes.SourceHash != hash {
		t.Fatal("失败覆盖了原纪要")
	}
}

func TestTranscriptExportIncludesAllPages(t *testing.T) {
	a := setup(t)
	host := a.register(t, "host")
	m := a.meeting(t, host)
	for i := 0; i < 205; i++ {
		_, err := a.db.AddCaption(context.Background(), store.Caption{MeetingID: m.ID, UserID: host.User.ID, Name: host.User.Name, ClientID: strconv.Itoa(i), Text: "记录" + strconv.Itoa(i), StartedAt: time.Now().Format(time.RFC3339Nano), Duration: 1})
		if err != nil {
			t.Fatal(err)
		}
	}
	req, _ := http.NewRequest("GET", a.http.URL+"/api/meetings/"+m.ID+"/transcript", nil)
	req.Header.Set("Authorization", "Bearer "+host.Token)
	response, err := http.DefaultClient.Do(req)
	if err != nil {
		t.Fatal(err)
	}
	defer response.Body.Close()
	data, _ := io.ReadAll(response.Body)
	if response.StatusCode != 200 || strings.Count(string(data), "记录") != 205 {
		t.Fatal("导出遗漏分页字幕")
	}
}
