package server

import (
	"comeet/internal/store"
	"database/sql"
	"errors"
	"fmt"
	"net/http"
	"regexp"
	"strconv"
	"strings"
	"unicode/utf8"
)

var meetingPattern = regexp.MustCompile(`^[0-9]{9}$`)

func (s *Server) listMeetings(w http.ResponseWriter, r *http.Request) {
	m, err := s.store.Meetings(r.Context(), currentUser(r).ID)
	if err != nil {
		s.internal(w, err)
		return
	}
	respond(w, 200, m)
}
func (s *Server) createMeeting(w http.ResponseWriter, r *http.Request) {
	var in struct {
		Title string `json:"title"`
	}
	if !decode(w, r, &in) {
		return
	}
	in.Title = strings.TrimSpace(in.Title)
	if utf8.RuneCountInString(in.Title) < 1 || utf8.RuneCountInString(in.Title) > 60 {
		fail(w, 400, "INVALID_TITLE", "会议主题需为 1–60 字")
		return
	}
	m, err := s.store.CreateMeeting(r.Context(), in.Title, currentUser(r))
	if err != nil {
		s.internal(w, err)
		return
	}
	respond(w, 201, m)
}
func (s *Server) findMeeting(w http.ResponseWriter, r *http.Request, requireMembership bool) (store.Meeting, bool) {
	id := r.PathValue("id")
	if !meetingPattern.MatchString(id) {
		fail(w, 400, "INVALID_MEETING_ID", "会议号应为 9 位数字")
		return store.Meeting{}, false
	}
	m, err := s.store.Meeting(r.Context(), id)
	if errors.Is(err, sql.ErrNoRows) {
		fail(w, 404, "MEETING_NOT_FOUND", "会议不存在，请检查会议号")
		return m, false
	}
	if err != nil {
		s.internal(w, err)
		return m, false
	}
	if requireMembership && !s.store.HasParticipant(r.Context(), id, currentUser(r).ID) {
		fail(w, 403, "FORBIDDEN", "请先加入会议")
		return m, false
	}
	return m, true
}
func (s *Server) joinMeeting(w http.ResponseWriter, r *http.Request) {
	// 结束和加入会议共享房间锁，避免会议结束的同时又有成员进入。
	s.hub.mu.Lock()
	defer s.hub.mu.Unlock()
	m, ok := s.findMeeting(w, r, false)
	if !ok {
		return
	}
	if m.EndedAt != nil {
		fail(w, 409, "MEETING_ENDED", "会议已结束")
		return
	}
	if err := s.store.Join(r.Context(), m.ID, currentUser(r).ID); err != nil {
		s.internal(w, err)
		return
	}
	respond(w, 200, m)
}
func (s *Server) meetingDetail(w http.ResponseWriter, r *http.Request) {
	m, ok := s.findMeeting(w, r, true)
	if ok {
		respond(w, 200, m)
	}
}
func (s *Server) leaveMeeting(w http.ResponseWriter, r *http.Request) {
	m, ok := s.findMeeting(w, r, true)
	if !ok {
		return
	}
	s.hub.leave(m.ID, currentUser(r).ID)
	respond(w, 200, map[string]bool{"left": true})
}
func (s *Server) endMeeting(w http.ResponseWriter, r *http.Request) {
	s.hub.mu.Lock()
	defer s.hub.mu.Unlock()
	m, ok := s.findMeeting(w, r, true)
	if !ok {
		return
	}
	if m.HostID != currentUser(r).ID {
		fail(w, 403, "HOST_REQUIRED", "只有主持人可以结束会议")
		return
	}
	if err := s.store.EndMeeting(r.Context(), m.ID); err != nil {
		s.internal(w, err)
		return
	}
	s.hub.endLocked(m.ID)
	respond(w, 200, map[string]bool{"ended": true})
}
func (s *Server) messages(w http.ResponseWriter, r *http.Request) {
	m, ok := s.findMeeting(w, r, true)
	if !ok {
		return
	}
	parse := func(key string) (int64, error) {
		raw := r.URL.Query().Get(key)
		if raw == "" {
			return 0, nil
		}
		n, err := strconv.ParseInt(raw, 10, 64)
		if err != nil || n < 0 {
			return 0, fmt.Errorf("invalid cursor")
		}
		return n, nil
	}
	a, errA := parse("after")
	b, errB := parse("before")
	if errA != nil || errB != nil || a > 0 && b > 0 {
		fail(w, 400, "INVALID_CURSOR", "消息游标无效")
		return
	}
	items, err := s.store.Messages(r.Context(), m.ID, a, b)
	if err != nil {
		s.internal(w, err)
		return
	}
	respond(w, 200, items)
}
