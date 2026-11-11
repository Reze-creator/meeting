//go:build intelligence_integration

package server

import (
	"bytes"
	"context"
	"encoding/json"
	"io"
	"net/http"
	"net/url"
	"os"
	"testing"
	"time"

	"comeet/internal/store"
)

// 用临时数据库、合成语音、真实本地 STT 和真实 DeepSeek 走完整业务链。
func TestRealSpeechToMinutesWorkflow(t *testing.T) {
	base, fixture, key := os.Getenv("COMEET_TEST_STT_URL"), os.Getenv("COMEET_TEST_WAV"), os.Getenv("DEEPSEEK_API_KEY")
	if base == "" || fixture == "" || key == "" {
		t.Skip("需配置真实 STT、合成 WAV 与 DeepSeek 密钥")
	}
	audio, err := os.ReadFile(fixture)
	if err != nil {
		t.Fatal(err)
	}
	if _, ok := validateSpeechWAV(audio); !ok {
		t.Fatal("测试 WAV 不符合客户端 PCM 协议")
	}
	a := setup(t)
	host := a.register(t, "live_host")
	guest := a.register(t, "live_guest")
	m := a.meeting(t, host)
	path := "/api/meetings/" + m.ID
	a.request(t, "POST", path+"/join", guest.Token, nil, 200, nil)
	a.server.cfg.STTURL = base
	a.server.intelligence.STTURL = base
	a.server.intelligence.STTModel = "tiny"
	a.server.cfg.DeepSeekKey = key
	a.server.cfg.DeepSeekModel = "deepseek-flash"
	a.server.intelligence.DeepSeekKey = key
	a.server.intelligence.DeepSeekModel = "deepseek-flash"
	a.server.intelligence.DeepSeekURL = os.Getenv("DEEPSEEK_BASE_URL")
	if a.server.intelligence.DeepSeekURL == "" {
		a.server.intelligence.DeepSeekURL = "https://api.deepseek.com"
	}
	c := a.connect(t, m, host)
	ready := readEvent(t, c, "ready")
	var data struct {
		SessionID string `json:"sessionId"`
	}
	_ = json.Unmarshal(ready.Data, &data)
	waitMembers(t, c, 1)
	_ = c.WriteJSON(incoming{Type: "state", Mic: true, Captioning: true})
	waitMembers(t, c, 1)
	query := url.Values{"clientId": {"real-clip-0001"}, "sessionId": {data.SessionID}, "startedAt": {time.Now().UTC().Format(time.RFC3339Nano)}, "language": {"zh"}}
	req, _ := http.NewRequest("POST", a.http.URL+path+"/transcribe?"+query.Encode(), bytes.NewReader(audio))
	req.Header.Set("Authorization", "Bearer "+host.Token)
	req.Header.Set("Content-Type", "audio/wav")
	response, err := http.DefaultClient.Do(req)
	if err != nil {
		t.Fatal(err)
	}
	defer response.Body.Close()
	if response.StatusCode != 201 {
		body, _ := io.ReadAll(response.Body)
		t.Fatalf("真实字幕保存失败 %d: %s", response.StatusCode, body)
	}
	readEvent(t, c, "caption")
	var transcript []store.Caption
	a.request(t, "GET", path+"/captions", guest.Token, nil, 200, &transcript)
	if len(transcript) != 1 || transcript[0].Text == "" {
		t.Fatal("参会者无法查看真实转写")
	}
	// 清晰的补充资料供模型与 ASR 结果交叉参考；全部为固定测试数据。
	_, err = a.db.AddMessage(context.Background(), m.ID, host.User, "synthetic-chat", "测试会议：决定周五验收项目，小王负责补充测试，截止本周四。")
	if err != nil {
		t.Fatal(err)
	}
	a.request(t, "POST", path+"/minutes", host.Token, nil, 200, nil)
	a.request(t, "POST", path+"/end", host.Token, nil, 200, nil)
	var saved struct {
		Minutes store.Minutes `json:"minutes"`
		Stale   bool          `json:"stale"`
	}
	a.request(t, "GET", path+"/minutes", guest.Token, nil, 200, &saved)
	if saved.Minutes.Model != "deepseek-flash" || saved.Stale || len(saved.Minutes.Content) == 0 {
		t.Fatal("会后纪要未正确保留")
	}
	t.Logf("真实 STT → 字幕写库/广播 → DeepSeek → 会后鉴权读取通过，字幕字节数=%d", len(transcript[0].Text))
}
