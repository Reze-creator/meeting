// Package store 封装 SQLite 持久化，HTTP 与信令层不直接执行 SQL。
package store

import (
	"context"
	"crypto/rand"
	"database/sql"
	"errors"
	"fmt"
	"math/big"
	"os"
	"path/filepath"
	"time"

	_ "modernc.org/sqlite"
)

var ErrConflict = errors.New("conflict")
var ErrEnded = errors.New("meeting ended")

type Store struct{ db *sql.DB }
type User struct {
	ID           int64  `json:"id"`
	Username     string `json:"username"`
	Name         string `json:"name"`
	PasswordHash string `json:"-"`
}
type Meeting struct {
	ID        string  `json:"id"`
	Title     string  `json:"title"`
	HostID    int64   `json:"hostId"`
	HostName  string  `json:"hostName"`
	CreatedAt string  `json:"createdAt"`
	EndedAt   *string `json:"endedAt"`
}
type Message struct {
	ID        int64  `json:"id"`
	MeetingID string `json:"meetingId"`
	UserID    int64  `json:"userId"`
	Name      string `json:"name"`
	Content   string `json:"content"`
	ClientID  string `json:"clientId"`
	CreatedAt string `json:"createdAt"`
}

func Open(path string) (*Store, error) {
	if path != ":memory:" {
		if err := os.MkdirAll(filepath.Dir(path), 0700); err != nil {
			return nil, err
		}
	}
	db, err := sql.Open("sqlite", path)
	if err != nil {
		return nil, err
	}
	// 单连接使写入顺序可预测，并保证连接级 PRAGMA 对所有查询有效。
	db.SetMaxOpenConns(1)
	_, err = db.Exec(`PRAGMA foreign_keys=ON; PRAGMA journal_mode=WAL; PRAGMA busy_timeout=5000;
CREATE TABLE IF NOT EXISTS users (
 id INTEGER PRIMARY KEY, username TEXT NOT NULL UNIQUE, name TEXT NOT NULL, password_hash TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS meetings (
 id TEXT PRIMARY KEY, title TEXT NOT NULL, host_id INTEGER NOT NULL REFERENCES users(id),
 created_at TEXT NOT NULL, ended_at TEXT
);
CREATE TABLE IF NOT EXISTS participants (
 meeting_id TEXT NOT NULL REFERENCES meetings(id), user_id INTEGER NOT NULL REFERENCES users(id),
 joined_at TEXT NOT NULL, left_at TEXT, PRIMARY KEY(meeting_id,user_id)
);
CREATE TABLE IF NOT EXISTS messages (
 id INTEGER PRIMARY KEY AUTOINCREMENT, meeting_id TEXT NOT NULL REFERENCES meetings(id),
 user_id INTEGER NOT NULL REFERENCES users(id), name TEXT NOT NULL, content TEXT NOT NULL,
 client_id TEXT NOT NULL, created_at TEXT NOT NULL, UNIQUE(meeting_id,user_id,client_id)
);
CREATE INDEX IF NOT EXISTS idx_messages_meeting ON messages(meeting_id,id);
CREATE INDEX IF NOT EXISTS idx_participants_user ON participants(user_id,meeting_id);
PRAGMA user_version=1;`)
	if err != nil {
		db.Close()
		return nil, err
	}
	// 进程重启后旧连接已失效；保留参会关系，同时清理残留在线状态。
	if _, err = db.Exec("UPDATE participants SET left_at=? WHERE left_at IS NULL", now()); err != nil {
		db.Close()
		return nil, err
	}
	return &Store{db: db}, nil
}
func (s *Store) Close() error { return s.db.Close() }
func now() string             { return time.Now().UTC().Format(time.RFC3339Nano) }

func (s *Store) CreateUser(ctx context.Context, username, name, hash string) (User, error) {
	r, err := s.db.ExecContext(ctx, `INSERT INTO users(username,name,password_hash) VALUES(?,?,?) ON CONFLICT(username) DO NOTHING`, username, name, hash)
	if err != nil {
		return User{}, err
	}
	n, err := r.RowsAffected()
	if err != nil {
		return User{}, err
	}
	if n == 0 {
		return User{}, ErrConflict
	}
	id, err := r.LastInsertId()
	return User{ID: id, Username: username, Name: name}, err
}
func (s *Store) User(ctx context.Context, username string) (User, error) {
	var u User
	err := s.db.QueryRowContext(ctx, "SELECT id,username,name,password_hash FROM users WHERE username=?", username).Scan(&u.ID, &u.Username, &u.Name, &u.PasswordHash)
	return u, err
}
func (s *Store) UserByID(ctx context.Context, id int64) (User, error) {
	var u User
	err := s.db.QueryRowContext(ctx, "SELECT id,username,name FROM users WHERE id=?", id).Scan(&u.ID, &u.Username, &u.Name)
	return u, err
}

func (s *Store) CreateMeeting(ctx context.Context, title string, host User) (Meeting, error) {
	for attempt := 0; attempt < 5; attempt++ {
		n, err := rand.Int(rand.Reader, big.NewInt(900000000))
		if err != nil {
			return Meeting{}, err
		}
		m := Meeting{ID: fmt.Sprint(n.Int64() + 100000000), Title: title, HostID: host.ID, HostName: host.Name, CreatedAt: now()}
		tx, err := s.db.BeginTx(ctx, nil)
		if err != nil {
			return m, err
		}
		r, err := tx.ExecContext(ctx, `INSERT INTO meetings(id,title,host_id,created_at) VALUES(?,?,?,?) ON CONFLICT(id) DO NOTHING`, m.ID, m.Title, m.HostID, m.CreatedAt)
		if err != nil {
			tx.Rollback()
			return m, err
		}
		count, err := r.RowsAffected()
		if err != nil {
			tx.Rollback()
			return m, err
		}
		if count == 0 {
			tx.Rollback()
			continue
		}
		_, err = tx.ExecContext(ctx, `INSERT INTO participants(meeting_id,user_id,joined_at,left_at) VALUES(?,?,?,?)`, m.ID, host.ID, m.CreatedAt, m.CreatedAt)
		if err != nil {
			tx.Rollback()
			return m, err
		}
		return m, tx.Commit()
	}
	return Meeting{}, fmt.Errorf("会议号生成冲突，请重试")
}

const meetingSelect = `SELECT m.id,m.title,m.host_id,u.name,m.created_at,m.ended_at FROM meetings m JOIN users u ON u.id=m.host_id `

func scanMeeting(row interface{ Scan(...any) error }) (Meeting, error) {
	var m Meeting
	err := row.Scan(&m.ID, &m.Title, &m.HostID, &m.HostName, &m.CreatedAt, &m.EndedAt)
	return m, err
}
func (s *Store) Meeting(ctx context.Context, id string) (Meeting, error) {
	return scanMeeting(s.db.QueryRowContext(ctx, meetingSelect+"WHERE m.id=?", id))
}
func (s *Store) Meetings(ctx context.Context, userID int64) ([]Meeting, error) {
	rows, err := s.db.QueryContext(ctx, meetingSelect+`JOIN participants p ON p.meeting_id=m.id WHERE p.user_id=? ORDER BY m.created_at DESC LIMIT 100`, userID)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	items := []Meeting{}
	for rows.Next() {
		m, err := scanMeeting(rows)
		if err != nil {
			return nil, err
		}
		items = append(items, m)
	}
	return items, rows.Err()
}

// Join 保存参会关系；真正的在线时间由 WebSocket 连接和离线事件更新。
func (s *Store) Join(ctx context.Context, id string, userID int64) error {
	m, err := s.Meeting(ctx, id)
	if err != nil {
		return err
	}
	if m.EndedAt != nil {
		return ErrEnded
	}
	t := now()
	_, err = s.db.ExecContext(ctx, `INSERT INTO participants(meeting_id,user_id,joined_at,left_at) VALUES(?,?,?,?) ON CONFLICT(meeting_id,user_id) DO NOTHING`, id, userID, t, t)
	return err
}
func (s *Store) HasParticipant(ctx context.Context, id string, userID int64) bool {
	var found int
	return s.db.QueryRowContext(ctx, "SELECT 1 FROM participants WHERE meeting_id=? AND user_id=?", id, userID).Scan(&found) == nil
}
func (s *Store) SetOnline(ctx context.Context, id string, userID int64, online bool) error {
	if online {
		_, err := s.db.ExecContext(ctx, "UPDATE participants SET joined_at=?,left_at=NULL WHERE meeting_id=? AND user_id=?", now(), id, userID)
		return err
	}
	_, err := s.db.ExecContext(ctx, "UPDATE participants SET left_at=? WHERE meeting_id=? AND user_id=?", now(), id, userID)
	return err
}
func (s *Store) EndMeeting(ctx context.Context, id string) error {
	tx, err := s.db.BeginTx(ctx, nil)
	if err != nil {
		return err
	}
	defer tx.Rollback()
	t := now()
	if _, err = tx.ExecContext(ctx, "UPDATE meetings SET ended_at=? WHERE id=? AND ended_at IS NULL", t, id); err != nil {
		return err
	}
	if _, err = tx.ExecContext(ctx, "UPDATE participants SET left_at=? WHERE meeting_id=? AND left_at IS NULL", t, id); err != nil {
		return err
	}
	return tx.Commit()
}

func (s *Store) AddMessage(ctx context.Context, meetingID string, u User, clientID, content string) (Message, error) {
	_, err := s.db.ExecContext(ctx, `INSERT INTO messages(meeting_id,user_id,name,content,client_id,created_at) VALUES(?,?,?,?,?,?) ON CONFLICT(meeting_id,user_id,client_id) DO NOTHING`, meetingID, u.ID, u.Name, content, clientID, now())
	if err != nil {
		return Message{}, err
	}
	var m Message
	err = s.db.QueryRowContext(ctx, `SELECT id,meeting_id,user_id,name,content,client_id,created_at FROM messages WHERE meeting_id=? AND user_id=? AND client_id=?`, meetingID, u.ID, clientID).Scan(&m.ID, &m.MeetingID, &m.UserID, &m.Name, &m.Content, &m.ClientID, &m.CreatedAt)
	return m, err
}

// before 用于向前翻页；after 用于重连后按顺序补齐遗漏消息。
func (s *Store) Messages(ctx context.Context, id string, after, before int64) ([]Message, error) {
	query := `SELECT id,meeting_id,user_id,name,content,client_id,created_at FROM messages WHERE meeting_id=?`
	args := []any{id}
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
	items := []Message{}
	for rows.Next() {
		var m Message
		if err := rows.Scan(&m.ID, &m.MeetingID, &m.UserID, &m.Name, &m.Content, &m.ClientID, &m.CreatedAt); err != nil {
			return nil, err
		}
		items = append(items, m)
	}
	if after == 0 {
		for i, j := 0, len(items)-1; i < j; i, j = i+1, j-1 {
			items[i], items[j] = items[j], items[i]
		}
	}
	return items, rows.Err()
}
