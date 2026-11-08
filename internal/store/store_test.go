package store

import (
	"context"
	"path/filepath"
	"strconv"
	"testing"
)

func TestPersistenceHistoryPaginationAndEnd(t *testing.T) {
	path := filepath.Join(t.TempDir(), "comeet.db")
	s, err := Open(path)
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { s.Close() })
	ctx := context.Background()
	u, err := s.CreateUser(ctx, "alice", "爱丽丝", "hash")
	if err != nil {
		t.Fatal(err)
	}
	m, err := s.CreateMeeting(ctx, "持久化验收", u)
	if err != nil {
		t.Fatal(err)
	}
	for i := 0; i < 205; i++ {
		if _, err := s.AddMessage(ctx, m.ID, u, strconv.Itoa(i), "消息 "+strconv.Itoa(i)); err != nil {
			t.Fatal(err)
		}
	}
	latest, err := s.Messages(ctx, m.ID, 0, 0)
	if err != nil {
		t.Fatal(err)
	}
	if len(latest) != 100 || latest[0].Content != "消息 105" || latest[99].Content != "消息 204" {
		t.Fatal("初始历史应返回最近 100 条且正序")
	}
	older, err := s.Messages(ctx, m.ID, 0, latest[0].ID)
	if err != nil || len(older) != 100 || older[0].Content != "消息 5" {
		t.Fatalf("旧消息分页错误: %v", err)
	}
	missing, err := s.Messages(ctx, m.ID, older[0].ID, 0)
	if err != nil || len(missing) != 100 || missing[0].Content != "消息 6" {
		t.Fatalf("重连游标分页错误: %v", err)
	}
	if err = s.SetOnline(ctx, m.ID, u.ID, true); err != nil {
		t.Fatal(err)
	}
	if err = s.Close(); err != nil {
		t.Fatal(err)
	}
	s, err = Open(path)
	if err != nil {
		t.Fatal(err)
	}
	meetings, err := s.Meetings(ctx, u.ID)
	if err != nil || len(meetings) != 1 {
		t.Fatalf("重启后会议丢失: %v", err)
	}
	var leftAt *string
	if err = s.db.QueryRow("SELECT left_at FROM participants WHERE meeting_id=?", m.ID).Scan(&leftAt); err != nil || leftAt == nil {
		t.Fatal("重启后应清理残留在线状态")
	}
	latest, err = s.Messages(ctx, m.ID, 0, 0)
	if err != nil || len(latest) != 100 {
		t.Fatal("重启后消息丢失")
	}
	if err = s.EndMeeting(ctx, m.ID); err != nil {
		t.Fatal(err)
	}
	if err = s.Join(ctx, m.ID, u.ID); err != ErrEnded {
		t.Fatalf("已结束会议仍可加入: %v", err)
	}
}
