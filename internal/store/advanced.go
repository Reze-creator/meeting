package store

import (
	"context"
	"database/sql"
	"time"
)

// migrateAdvanced 以增量表扩展旧数据库，保留基础档已经保存的账号、会议和消息。
func (s *Store) migrateAdvanced() error {
	_, err := s.db.Exec(`
CREATE TABLE IF NOT EXISTS moderation (
 meeting_id TEXT NOT NULL REFERENCES meetings(id), user_id INTEGER NOT NULL REFERENCES users(id),
 muted INTEGER NOT NULL DEFAULT 0, removed INTEGER NOT NULL DEFAULT 0,
 PRIMARY KEY(meeting_id,user_id)
);
CREATE TABLE IF NOT EXISTS recordings (
 id TEXT PRIMARY KEY, meeting_id TEXT NOT NULL REFERENCES meetings(id), user_id INTEGER NOT NULL REFERENCES users(id),
 size INTEGER NOT NULL, duration REAL NOT NULL, created_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_recordings_meeting ON recordings(meeting_id,created_at);
PRAGMA user_version=2;`)
	return err
}

type Participant struct {
	ID       int64   `json:"id"`
	Name     string  `json:"name"`
	JoinedAt string  `json:"joinedAt"`
	LeftAt   *string `json:"leftAt"`
}
type Moderation struct {
	Muted   bool `json:"muted"`
	Removed bool `json:"removed"`
}
type Recording struct {
	ID        string  `json:"id"`
	MeetingID string  `json:"meetingId"`
	UserID    int64   `json:"userId"`
	Size      int64   `json:"size"`
	Duration  float64 `json:"duration"`
	CreatedAt string  `json:"createdAt"`
}

func (s *Store) Moderation(ctx context.Context, id string, userID int64) (Moderation, error) {
	var m Moderation
	err := s.db.QueryRowContext(ctx, "SELECT muted,removed FROM moderation WHERE meeting_id=? AND user_id=?", id, userID).Scan(&m.Muted, &m.Removed)
	if err == sql.ErrNoRows {
		return m, nil
	}
	return m, err
}
func (s *Store) SetModeration(ctx context.Context, id string, userID int64, muted, removed bool) error {
	_, err := s.db.ExecContext(ctx, `INSERT INTO moderation(meeting_id,user_id,muted,removed) VALUES(?,?,?,?) ON CONFLICT(meeting_id,user_id) DO UPDATE SET muted=excluded.muted,removed=excluded.removed`, id, userID, muted, removed)
	return err
}
func (s *Store) Participants(ctx context.Context, id string) ([]Participant, error) {
	rows, err := s.db.QueryContext(ctx, `SELECT u.id,u.name,p.joined_at,p.left_at FROM participants p JOIN users u ON u.id=p.user_id WHERE p.meeting_id=? ORDER BY p.joined_at`, id)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	items := []Participant{}
	for rows.Next() {
		var p Participant
		if err = rows.Scan(&p.ID, &p.Name, &p.JoinedAt, &p.LeftAt); err != nil {
			return nil, err
		}
		items = append(items, p)
	}
	return items, rows.Err()
}
func (s *Store) Recordings(ctx context.Context, id string) ([]Recording, error) {
	rows, err := s.db.QueryContext(ctx, "SELECT id,meeting_id,user_id,size,duration,created_at FROM recordings WHERE meeting_id=? ORDER BY created_at DESC", id)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	items := []Recording{}
	for rows.Next() {
		var r Recording
		if err = rows.Scan(&r.ID, &r.MeetingID, &r.UserID, &r.Size, &r.Duration, &r.CreatedAt); err != nil {
			return nil, err
		}
		items = append(items, r)
	}
	return items, rows.Err()
}
func (s *Store) Recording(ctx context.Context, id string) (Recording, error) {
	var r Recording
	err := s.db.QueryRowContext(ctx, "SELECT id,meeting_id,user_id,size,duration,created_at FROM recordings WHERE id=?", id).Scan(&r.ID, &r.MeetingID, &r.UserID, &r.Size, &r.Duration, &r.CreatedAt)
	return r, err
}
func (s *Store) SaveRecording(ctx context.Context, r Recording) error {
	_, err := s.db.ExecContext(ctx, "INSERT INTO recordings(id,meeting_id,user_id,size,duration,created_at) VALUES(?,?,?,?,?,?)", r.ID, r.MeetingID, r.UserID, r.Size, r.Duration, now())
	return err
}
func (s *Store) ExpiredMeetings(ctx context.Context, maxAge time.Duration) ([]string, error) {
	rows, err := s.db.QueryContext(ctx, "SELECT id FROM meetings WHERE ended_at IS NULL AND julianday(created_at) <= julianday(?)", time.Now().UTC().Add(-maxAge).Format(time.RFC3339Nano))
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	ids := []string{}
	for rows.Next() {
		var id string
		if err = rows.Scan(&id); err != nil {
			return nil, err
		}
		ids = append(ids, id)
	}
	return ids, rows.Err()
}
