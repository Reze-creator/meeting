package store

import (
	"context"
	"encoding/json"
	"fmt"
)

type Caption struct {
	ID        int64   `json:"id"`
	MeetingID string  `json:"meetingId"`
	UserID    int64   `json:"userId"`
	Name      string  `json:"name"`
	ClientID  string  `json:"clientId"`
	Text      string  `json:"text"`
	StartedAt string  `json:"startedAt"`
	Duration  float64 `json:"duration"`
	CreatedAt string  `json:"createdAt"`
}
type Minutes struct {
	Content    json.RawMessage `json:"content"`
	Model      string          `json:"model"`
	SourceHash string          `json:"sourceHash"`
	CreatedAt  string          `json:"createdAt"`
}

func (s *Store) migrateIntelligence() error {
	_, err := s.db.Exec(`CREATE TABLE IF NOT EXISTS captions (
 id INTEGER PRIMARY KEY AUTOINCREMENT, meeting_id TEXT NOT NULL REFERENCES meetings(id),
 user_id INTEGER NOT NULL REFERENCES users(id), name TEXT NOT NULL, client_id TEXT NOT NULL,
 text TEXT NOT NULL, started_at TEXT NOT NULL, duration REAL NOT NULL, created_at TEXT NOT NULL,
 UNIQUE(meeting_id,user_id,client_id));
 CREATE INDEX IF NOT EXISTS idx_captions_meeting ON captions(meeting_id,id);
 CREATE TABLE IF NOT EXISTS minutes (
 meeting_id TEXT PRIMARY KEY REFERENCES meetings(id), content TEXT NOT NULL, model TEXT NOT NULL,
 source_hash TEXT NOT NULL, created_at TEXT NOT NULL);`)
	return err
}

const captionColumns = `id,meeting_id,user_id,name,client_id,text,started_at,duration,created_at`

func scanCaption(row interface{ Scan(...any) error }) (Caption, error) {
	var c Caption
	err := row.Scan(&c.ID, &c.MeetingID, &c.UserID, &c.Name, &c.ClientID, &c.Text, &c.StartedAt, &c.Duration, &c.CreatedAt)
	return c, err
}
func (s *Store) CaptionByClient(ctx context.Context, meetingID string, userID int64, clientID string) (Caption, error) {
	return scanCaption(s.db.QueryRowContext(ctx, `SELECT `+captionColumns+` FROM captions WHERE meeting_id=? AND user_id=? AND client_id=?`, meetingID, userID, clientID))
}
func (s *Store) AllCaptionPage(ctx context.Context, id string, after int64) ([]Caption, error) {
	rows, err := s.db.QueryContext(ctx, `SELECT `+captionColumns+` FROM captions WHERE meeting_id=? AND id>? ORDER BY id ASC LIMIT 100`, id, after)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	items := []Caption{}
	for rows.Next() {
		c, err := scanCaption(rows)
		if err != nil {
			return nil, err
		}
		items = append(items, c)
	}
	return items, rows.Err()
}
func (s *Store) AddCaption(ctx context.Context, c Caption) (Caption, error) {
	_, err := s.db.ExecContext(ctx, `INSERT INTO captions(meeting_id,user_id,name,client_id,text,started_at,duration,created_at)
 VALUES(?,?,?,?,?,?,?,?) ON CONFLICT(meeting_id,user_id,client_id) DO NOTHING`, c.MeetingID, c.UserID, c.Name, c.ClientID, c.Text, c.StartedAt, c.Duration, now())
	if err != nil {
		return c, err
	}
	return s.CaptionByClient(ctx, c.MeetingID, c.UserID, c.ClientID)
}

// 首屏和 before 按最近页返回，after 用于断线后连续补齐；结果始终以 ID 升序展示。
func (s *Store) Captions(ctx context.Context, id string, after, before int64) ([]Caption, error) {
	query, args := `SELECT `+captionColumns+` FROM captions WHERE meeting_id=?`, []any{id}
	if after > 0 {
		query += " AND id>?"
		args = append(args, after)
	}
	if before > 0 {
		query += " AND id<?"
		args = append(args, before)
	}
	if after > 0 {
		query += " ORDER BY id ASC LIMIT 100"
	} else {
		query += " ORDER BY id DESC LIMIT 100"
	}
	rows, err := s.db.QueryContext(ctx, query, args...)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	result := []Caption{}
	for rows.Next() {
		c, err := scanCaption(rows)
		if err != nil {
			return nil, err
		}
		result = append(result, c)
	}
	if after == 0 {
		for i, j := 0, len(result)-1; i < j; i, j = i+1, j-1 {
			result[i], result[j] = result[j], result[i]
		}
	}
	return result, rows.Err()
}
func (s *Store) SaveMinutes(ctx context.Context, id string, m Minutes) error {
	_, err := s.db.ExecContext(ctx, `INSERT INTO minutes(meeting_id,content,model,source_hash,created_at) VALUES(?,?,?,?,?)
 ON CONFLICT(meeting_id) DO UPDATE SET content=excluded.content,model=excluded.model,source_hash=excluded.source_hash,created_at=excluded.created_at`, id, string(m.Content), m.Model, m.SourceHash, now())
	return err
}
func (s *Store) Minutes(ctx context.Context, id string) (Minutes, error) {
	var result Minutes
	var content string
	err := s.db.QueryRowContext(ctx, `SELECT content,model,source_hash,created_at FROM minutes WHERE meeting_id=?`, id).Scan(&content, &result.Model, &result.SourceHash, &result.CreatedAt)
	result.Content = json.RawMessage(content)
	return result, err
}

// 在同一个只读事务中取得字幕、聊天快照，防止两次查询之间写入导致来源版本不一致。
// 显式限制资料大小，超限报错，绝不悄悄只总结最后一页。
func (s *Store) MinutesSource(ctx context.Context, id string) (string, error) {
	tx, err := s.db.BeginTx(ctx, nil)
	if err != nil {
		return "", err
	}
	defer tx.Rollback()
	rows, err := tx.QueryContext(ctx, `SELECT '字幕',name,text,started_at FROM captions WHERE meeting_id=?
 UNION ALL SELECT '聊天',name,content,created_at FROM messages WHERE meeting_id=? ORDER BY 4,1,2 LIMIT 5001`, id, id)
	if err != nil {
		return "", err
	}
	var lines []json.RawMessage
	size := 0
	for rows.Next() {
		var kind, name, text, at string
		if err = rows.Scan(&kind, &name, &text, &at); err != nil {
			rows.Close()
			return "", err
		}
		// JSON 编码保留数据边界，名字/正文中的换行也不能伪装成新的系统角色。
		entry, _ := json.Marshal(map[string]string{"type": kind, "speaker": name, "text": text, "at": at})
		size += len(entry)
		if len(lines) >= 5000 || size > 120000 {
			rows.Close()
			return "", fmt.Errorf("会议资料超过单次纪要上限（5000 条或 120 KB），请先导出分段整理")
		}
		lines = append(lines, entry)
	}
	err = rows.Err()
	rows.Close()
	if err != nil {
		return "", err
	}
	if err = tx.Commit(); err != nil {
		return "", err
	}
	encoded, _ := json.Marshal(lines)
	if len(lines) == 0 {
		return "", nil
	}
	return string(encoded), nil
}
