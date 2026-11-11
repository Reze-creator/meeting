package server

import (
	"context"
	"log/slog"
	"net/http"
	"time"
)

// moderate 先验证主持人身份，再保存持久化限制，最后同步媒体服务与房间快照。
// 解除静音只撤销限制，不替成员打开麦克风，避免未经用户操作采集声音。
func (s *Server) moderate(w http.ResponseWriter, r *http.Request) {
	var in struct {
		Target int64  `json:"target"`
		Action string `json:"action"`
	}
	if !decode(w, r, &in) {
		return
	}
	s.hub.mu.Lock()
	defer s.hub.mu.Unlock()
	m, ok := s.findMeeting(w, r, true)
	if !ok {
		return
	}
	if currentUser(r).ID != m.HostID {
		fail(w, 403, "HOST_REQUIRED", "只有主持人可以操作成员")
		return
	}
	if m.EndedAt != nil {
		fail(w, 409, "MEETING_ENDED", "会议已结束")
		return
	}
	if in.Target == m.HostID || !s.store.HasParticipant(r.Context(), m.ID, in.Target) {
		fail(w, 400, "INVALID_TARGET", "不能操作主持人或非参会成员")
		return
	}
	state, err := s.store.Moderation(r.Context(), m.ID, in.Target)
	if err != nil {
		s.internal(w, err)
		return
	}
	switch in.Action {
	case "mute":
		state.Muted = true
	case "allow-mic":
		state.Muted = false
	case "remove":
		state.Removed = true
	default:
		fail(w, 400, "INVALID_ACTION", "未知会控操作")
		return
	}
	if err = s.store.SetModeration(r.Context(), m.ID, in.Target, state.Muted, state.Removed); err != nil {
		s.internal(w, err)
		return
	}
	ctx, cancel := context.WithTimeout(r.Context(), 5*time.Second)
	defer cancel()
	if state.Removed {
		err = s.media.Remove(ctx, m.ID, in.Target)
	} else {
		err = s.media.Mute(ctx, m.ID, in.Target, state.Muted)
	}
	if c := s.hub.rooms[m.ID][in.Target]; c != nil {
		if state.Removed {
			s.hub.enqueue(c, event{Type: "removed"})
			close(c.send)
			delete(s.hub.rooms[m.ID], in.Target)
			_ = s.store.SetOnline(ctx, m.ID, in.Target, false)
		} else {
			c.member.MutedByHost = state.Muted
			if state.Muted {
				c.member.Mic = false
			}
			s.hub.enqueue(c, event{Type: "moderation", Data: state})
		}
	}
	s.hub.membersLocked(m.ID)
	if err != nil {
		slog.Error("媒体会控同步失败", "meeting", m.ID, "error", err)
		fail(w, 503, "MEDIA_CONTROL_FAILED", "限制已保存；媒体服务同步失败，请重试本次操作")
		return
	}
	respond(w, 200, state)
}

func (s *Server) mediaToken(w http.ResponseWriter, r *http.Request) {
	s.hub.mu.Lock()
	defer s.hub.mu.Unlock()
	m, ok := s.findMeeting(w, r, true)
	if !ok {
		return
	}
	if m.EndedAt != nil {
		fail(w, 409, "MEETING_ENDED", "会议已结束")
		return
	}
	u := currentUser(r)
	mod, err := s.store.Moderation(r.Context(), m.ID, u.ID)
	if err != nil {
		s.internal(w, err)
		return
	}
	if mod.Removed {
		fail(w, 403, "REMOVED", "你已被移出本场会议")
		return
	}
	if s.hub.rooms[m.ID][u.ID] == nil {
		fail(w, 409, "ROOM_NOT_READY", "请先连接会议信令")
		return
	}
	if !s.media.Enabled() {
		respond(w, 200, map[string]string{"mode": "p2p"})
		return
	}
	token, err := s.media.JoinToken(m.ID, u.ID, u.Name, mod.Muted)
	if err != nil {
		s.internal(w, err)
		return
	}
	respond(w, 200, map[string]string{"mode": "livekit", "url": s.media.URL, "token": token})
}
func (s *Server) history(w http.ResponseWriter, r *http.Request) {
	m, ok := s.findMeeting(w, r, true)
	if !ok {
		return
	}
	participants, err := s.store.Participants(r.Context(), m.ID)
	if err != nil {
		s.internal(w, err)
		return
	}
	recordings, err := s.store.Recordings(r.Context(), m.ID)
	if err != nil {
		s.internal(w, err)
		return
	}
	respond(w, 200, map[string]any{"meeting": m, "participants": participants, "recordings": recordings})
}
func (s *Server) schedule(ctx context.Context) {
	defer s.worker.Done()
	ticker := time.NewTicker(5 * time.Second)
	defer ticker.Stop()
	for {
		select {
		case <-ctx.Done():
			return
		case <-ticker.C:
			s.expireMeetings(ctx)
		}
	}
}
func (s *Server) expireMeetings(parent context.Context) {
	ctx, cancel := context.WithTimeout(parent, 10*time.Second)
	defer cancel()
	s.hub.mu.Lock()
	defer s.hub.mu.Unlock()
	if s.cfg.MaxMeetingDuration > 0 {
		ids, err := s.store.ExpiredMeetings(ctx, s.cfg.MaxMeetingDuration)
		if err != nil {
			slog.Error("查询超时会议失败", "error", err)
			return
		}
		for _, id := range ids {
			if err := s.store.EndMeeting(ctx, id); err != nil {
				slog.Error("结束超时会议失败", "error", err)
				continue
			}
			s.hub.endLocked(id)
			s.cleanup[id] = true
			slog.Info("会议达到时长上限", "meeting", id)
		}
	}
	for id := range s.cleanup {
		if err := s.media.End(ctx, id); err == nil {
			delete(s.cleanup, id)
		} else {
			slog.Warn("重试媒体房间清理失败", "meeting", id, "error", err)
		}
	}
}
