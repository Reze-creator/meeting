package server

import (
	"bytes"
	"context"
	"crypto/sha256"
	"database/sql"
	"encoding/binary"
	"encoding/hex"
	"encoding/json"
	"errors"
	"io"
	"net/http"
	"regexp"
	"strconv"
	"time"

	"comeet/internal/store"
)

var clipIDPattern = regexp.MustCompile(`^[a-zA-Z0-9_-]{8,64}$`)

func (s *Server) intelligenceStatus(w http.ResponseWriter, r *http.Request) {
	respond(w, 200, map[string]any{"captions": s.cfg.STTURL != "", "minutes": s.cfg.DeepSeekKey != "", "minutesModel": s.cfg.DeepSeekModel})
}
func (s *Server) captions(w http.ResponseWriter, r *http.Request) {
	m, ok := s.findMeeting(w, r, true)
	if !ok {
		return
	}
	after, _ := strconv.ParseInt(r.URL.Query().Get("after"), 10, 64)
	before, _ := strconv.ParseInt(r.URL.Query().Get("before"), 10, 64)
	items, err := s.store.Captions(r.Context(), m.ID, after, before)
	if err != nil {
		s.internal(w, err)
		return
	}
	respond(w, 200, items)
}

// 仅接收客户端自己的单声道 PCM WAV；从真实容器推导时长，不相信查询参数。
func validateSpeechWAV(audio []byte) (float64, bool) {
	if len(audio) < 44 || string(audio[:4]) != "RIFF" || string(audio[8:12]) != "WAVE" || string(audio[12:16]) != "fmt " || string(audio[36:40]) != "data" {
		return 0, false
	}
	rate := binary.LittleEndian.Uint32(audio[24:28])
	length := binary.LittleEndian.Uint32(audio[40:44])
	// 格式字段分别校验：PCM 编码、单声道、16 位采样与一致的字节速率。
	pcm16Mono := binary.LittleEndian.Uint32(audio[16:20]) == 16 &&
		binary.LittleEndian.Uint16(audio[20:22]) == 1 &&
		binary.LittleEndian.Uint16(audio[22:24]) == 1 &&
		binary.LittleEndian.Uint16(audio[34:36]) == 16
	validRate := rate >= 8000 && rate <= 96000 &&
		binary.LittleEndian.Uint32(audio[28:32]) == rate*2 &&
		binary.LittleEndian.Uint16(audio[32:34]) == 2
	validLength := binary.LittleEndian.Uint32(audio[4:8]) == uint32(len(audio)-8) &&
		int(length) == len(audio)-44 && length%2 == 0
	if !pcm16Mono || !validRate || !validLength {
		return 0, false
	}
	duration := float64(length) / float64(rate*2)
	return duration, duration >= 0.2 && duration <= 8
}

func (s *Server) transcribe(w http.ResponseWriter, r *http.Request) {
	if s.cfg.STTURL == "" {
		fail(w, 503, "STT_NOT_CONFIGURED", "字幕服务未配置，请按挑战档文档启动本地 STT")
		return
	}
	m, ok := s.findMeeting(w, r, true)
	if !ok {
		return
	}
	id, sessionID := r.URL.Query().Get("clientId"), r.URL.Query().Get("sessionId")
	language := r.URL.Query().Get("language")
	if language == "" {
		language = "zh"
	}
	if !clipIDPattern.MatchString(id) || (language != "zh" && language != "en") {
		fail(w, 400, "INVALID_CLIP", "音频编号或语言无效")
		return
	}
	started, err := time.Parse(time.RFC3339Nano, r.URL.Query().Get("startedAt"))
	if err != nil || time.Since(started) > 2*time.Minute || time.Until(started) > 5*time.Second {
		fail(w, 400, "INVALID_CLIP_TIME", "音频时间无效或片段积压过久")
		return
	}
	// 每人同一时刻只识别一个片段，全局最多四个；不创建无界排队协程。
	key := m.ID + ":" + strconv.FormatInt(currentUser(r).ID, 10)
	if _, loaded := s.transcribing.LoadOrStore(key, true); loaded {
		fail(w, 429, "STT_BUSY", "上一段字幕仍在识别，请稍后重试")
		return
	}
	defer s.transcribing.Delete(key)
	select {
	case s.sttSlots <- struct{}{}:
		defer func() { <-s.sttSlots }()
	default:
		fail(w, 429, "STT_BUSY", "字幕服务繁忙，请稍后重试")
		return
	}
	allowed := func() bool {
		c := s.hub.rooms[m.ID][currentUser(r).ID]
		return c != nil && c.member.SessionID == sessionID && c.member.Mic && c.member.Captioning && !c.member.MutedByHost
	}
	s.hub.mu.Lock()
	valid := m.EndedAt == nil && allowed()
	s.hub.mu.Unlock()
	if !valid {
		fail(w, 403, "CAPTION_NOT_ALLOWED", "请在当前会议连接中开启麦克风和本人字幕")
		return
	}
	if old, err := s.store.CaptionByClient(r.Context(), m.ID, currentUser(r).ID, id); err == nil {
		respond(w, 200, old)
		return
	} else if !errors.Is(err, sql.ErrNoRows) {
		s.internal(w, err)
		return
	}
	if r.Header.Get("Content-Type") != "audio/wav" {
		fail(w, 415, "INVALID_AUDIO", "请上传单声道 PCM WAV")
		return
	}
	audio, err := io.ReadAll(http.MaxBytesReader(w, r.Body, 2<<20))
	if err != nil {
		fail(w, 413, "AUDIO_TOO_LARGE", "音频片段不能超过 2 MiB")
		return
	}
	duration, valid := validateSpeechWAV(audio)
	if !valid {
		fail(w, 400, "INVALID_AUDIO", "音频需为 0.2–8 秒单声道 16 位 PCM WAV")
		return
	}
	ctx, cancel := context.WithTimeout(r.Context(), 30*time.Second)
	defer cancel()
	text, err := s.intelligence.Transcribe(ctx, audio, language)
	if err != nil {
		fail(w, 502, "STT_FAILED", err.Error())
		return
	}
	if text == "" {
		respond(w, 200, map[string]bool{"empty": true})
		return
	}
	// 网络调用期间可能静音、离会、结束或替换连接。重新检查后才允许写库与广播。
	s.hub.mu.Lock()
	defer s.hub.mu.Unlock()
	if !allowed() {
		fail(w, 409, "CAPTION_SESSION_ENDED", "当前字幕会话已结束，丢弃迟到结果")
		return
	}
	caption, err := s.store.AddCaption(r.Context(), store.Caption{
		MeetingID: m.ID, UserID: currentUser(r).ID, Name: currentUser(r).Name,
		ClientID: id, Text: text, StartedAt: started.UTC().Format(time.RFC3339Nano), Duration: duration,
	})
	if err != nil {
		s.internal(w, err)
		return
	}
	s.hub.broadcastLocked(m.ID, event{Type: "caption", Data: caption})
	respond(w, 201, caption)
}
func sourceHash(source string) string {
	sum := sha256.Sum256([]byte(source))
	return hex.EncodeToString(sum[:])
}
func (s *Server) minutes(w http.ResponseWriter, r *http.Request) {
	m, ok := s.findMeeting(w, r, true)
	if !ok {
		return
	}
	result, err := s.store.Minutes(r.Context(), m.ID)
	if errors.Is(err, sql.ErrNoRows) {
		respond(w, 200, map[string]any{"minutes": nil, "stale": false})
		return
	}
	if err != nil {
		s.internal(w, err)
		return
	}
	source, sourceErr := s.store.MinutesSource(r.Context(), m.ID)
	respond(w, 200, map[string]any{"minutes": result, "stale": sourceErr != nil || sourceHash(source) != result.SourceHash})
}
func (s *Server) generateMinutes(w http.ResponseWriter, r *http.Request) {
	m, ok := s.findMeeting(w, r, true)
	if !ok {
		return
	}
	if currentUser(r).ID != m.HostID {
		fail(w, 403, "HOST_REQUIRED", "只有主持人可以生成或更新纪要")
		return
	}
	if s.cfg.DeepSeekKey == "" {
		fail(w, 503, "DEEPSEEK_NOT_CONFIGURED", "请在后端 .env 配置 DEEPSEEK_API_KEY")
		return
	}
	if _, busy := s.summarizing.LoadOrStore(m.ID, true); busy {
		fail(w, 409, "MINUTES_BUSY", "本场会议正在生成纪要，请稍候")
		return
	}
	defer s.summarizing.Delete(m.ID)
	source, err := s.store.MinutesSource(r.Context(), m.ID)
	if err != nil {
		fail(w, 422, "MINUTES_SOURCE_LIMIT", "会议资料超过单次上限或暂时不可读，请先导出转写分段整理")
		return
	}
	if source == "" {
		fail(w, 422, "NO_MINUTES_SOURCE", "没有字幕或聊天记录，无法生成纪要")
		return
	}
	ctx, cancel := context.WithTimeout(r.Context(), 120*time.Second)
	defer cancel()
	content, err := s.intelligence.Summarize(ctx, source)
	if err != nil {
		fail(w, 502, "DEEPSEEK_FAILED", err.Error())
		return
	}
	encoded, err := json.Marshal(content)
	if err != nil {
		s.internal(w, err)
		return
	}
	// 成功生成后才替换旧版；失败不会覆盖已保存纪要，来源哈希用于提示资料有新增。
	result := store.Minutes{Content: encoded, Model: s.cfg.DeepSeekModel, SourceHash: sourceHash(source)}
	if err = s.store.SaveMinutes(ctx, m.ID, result); err != nil {
		s.internal(w, err)
		return
	}
	s.minutes(w, r)
}

// 按服务端已经保存的转写导出，字幕文件不包含音频或登录令牌。
func (s *Server) exportCaptions(w http.ResponseWriter, r *http.Request) {
	m, ok := s.findMeeting(w, r, true)
	if !ok {
		return
	}
	var output bytes.Buffer
	after := int64(0)
	for {
		items, err := s.store.AllCaptionPage(r.Context(), m.ID, after)
		if err != nil {
			s.internal(w, err)
			return
		}
		for _, c := range items {
			output.WriteString(c.StartedAt + " " + c.Name + "：" + c.Text + "\n")
			after = c.ID
		}
		if output.Len() > 16<<20 {
			fail(w, 413, "EXPORT_TOO_LARGE", "转写超过导出上限")
			return
		}
		if len(items) < 100 {
			break
		}
	}
	w.Header().Set("Content-Type", "text/plain; charset=utf-8")
	w.Header().Set("Content-Disposition", `attachment; filename="`+m.ID+`-transcript.txt"`)
	_, _ = w.Write(output.Bytes())
}
