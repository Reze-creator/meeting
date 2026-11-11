package server

import (
	"comeet/internal/store"
	"context"
	"database/sql"
	"errors"
	"io"
	"math"
	"net/http"
	"os"
	"path/filepath"
	"regexp"
	"strconv"
	"time"
)

const maxRecordingBytes = 96 << 20

var recordingPattern = regexp.MustCompile(`^[A-Za-z0-9_-]{16,64}$`)

// 只允许主持人上传；文件名由服务器生成。会议结束后仍可保存最后一段录制。
func (s *Server) uploadRecording(w http.ResponseWriter, r *http.Request) {
	m, ok := s.findMeeting(w, r, true)
	if !ok {
		return
	}
	if m.HostID != currentUser(r).ID {
		fail(w, 403, "HOST_REQUIRED", "只有主持人可以保存会议录制")
		return
	}
	duration, err := strconv.ParseFloat(r.URL.Query().Get("duration"), 64)
	if err != nil || math.IsNaN(duration) || math.IsInf(duration, 0) || duration <= 0 || duration > 7200 {
		fail(w, 400, "INVALID_DURATION", "录制时长应在 0–7200 秒之间")
		return
	}
	if r.Header.Get("Content-Type") != "video/webm" {
		fail(w, 415, "INVALID_RECORDING", "仅支持 WebM 录制")
		return
	}
	if err = os.MkdirAll(s.cfg.RecordingDir, 0700); err != nil {
		s.internal(w, err)
		return
	}
	f, err := os.CreateTemp(s.cfg.RecordingDir, "upload-*.tmp")
	if err != nil {
		s.internal(w, err)
		return
	}
	defer os.Remove(f.Name())
	_ = http.NewResponseController(w).SetReadDeadline(time.Now().Add(2 * time.Minute))
	r.Body = http.MaxBytesReader(w, r.Body, maxRecordingBytes)
	header := make([]byte, 4)
	if _, err = io.ReadFull(r.Body, header); err != nil || string(header) != "\x1a\x45\xdf\xa3" {
		f.Close()
		fail(w, 400, "INVALID_RECORDING", "文件不是 WebM 容器")
		return
	}
	if _, err = f.Write(header); err != nil {
		f.Close()
		s.internal(w, err)
		return
	}
	n, err := io.Copy(f, r.Body)
	closeErr := f.Close()
	if err != nil {
		fail(w, 413, "RECORDING_TOO_LARGE", "录制过大或上传中断，请下载本地备份")
		return
	}
	if closeErr != nil {
		s.internal(w, closeErr)
		return
	}
	id := randomID()
	path := filepath.Join(s.cfg.RecordingDir, id+".webm")
	if err = os.Rename(f.Name(), path); err != nil {
		s.internal(w, err)
		return
	}
	rec := store.Recording{ID: id, MeetingID: m.ID, UserID: currentUser(r).ID, Size: n + 4, Duration: duration}
	// 请求读完后使用独立短超时，避免客户端断开导致文件与元数据脱节。
	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()
	if err = s.store.SaveRecording(ctx, rec); err != nil {
		_ = os.Remove(path)
		s.internal(w, err)
		return
	}
	respond(w, 201, rec)
}
func (s *Server) downloadRecording(w http.ResponseWriter, r *http.Request) {
	id := r.PathValue("recording")
	if !recordingPattern.MatchString(id) {
		fail(w, 404, "NOT_FOUND", "录制不存在")
		return
	}
	rec, err := s.store.Recording(r.Context(), id)
	if errors.Is(err, sql.ErrNoRows) {
		fail(w, 404, "NOT_FOUND", "录制不存在")
		return
	}
	if err != nil {
		s.internal(w, err)
		return
	}
	if !s.store.HasParticipant(r.Context(), rec.MeetingID, currentUser(r).ID) {
		fail(w, 403, "FORBIDDEN", "仅参会者可以观看回放")
		return
	}
	f, err := os.Open(filepath.Join(s.cfg.RecordingDir, id+".webm"))
	if os.IsNotExist(err) {
		fail(w, 404, "NOT_FOUND", "录制文件不存在")
		return
	}
	if err != nil {
		s.internal(w, err)
		return
	}
	defer f.Close()
	info, err := f.Stat()
	if err != nil {
		s.internal(w, err)
		return
	}
	w.Header().Set("Content-Type", "video/webm")
	http.ServeContent(w, r, id+".webm", info.ModTime(), f)
}
