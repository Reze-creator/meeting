package server

import (
	"comeet/internal/store"
	"context"
	"database/sql"
	"errors"
	"github.com/golang-jwt/jwt/v5"
	"golang.org/x/crypto/bcrypt"
	"net"
	"net/http"
	"regexp"
	"strconv"
	"strings"
	"time"
	"unicode/utf8"
)

func currentUser(r *http.Request) store.User { return r.Context().Value(userKey{}).(store.User) }

func (s *Server) token(u store.User) (string, error) {
	t := time.Now()
	return jwt.NewWithClaims(jwt.SigningMethodHS256, jwt.RegisteredClaims{Subject: strconv.FormatInt(u.ID, 10), Issuer: "comeet", IssuedAt: jwt.NewNumericDate(t), ExpiresAt: jwt.NewNumericDate(t.Add(24 * time.Hour))}).SignedString([]byte(s.cfg.JWTSecret))
}
func (s *Server) parseToken(raw string) (store.User, time.Time, error) {
	claims := &jwt.RegisteredClaims{}
	_, err := jwt.ParseWithClaims(raw, claims, func(t *jwt.Token) (any, error) { return []byte(s.cfg.JWTSecret), nil }, jwt.WithValidMethods([]string{"HS256"}), jwt.WithIssuer("comeet"), jwt.WithExpirationRequired())
	if err != nil {
		return store.User{}, time.Time{}, err
	}
	id, err := strconv.ParseInt(claims.Subject, 10, 64)
	if err != nil {
		return store.User{}, time.Time{}, err
	}
	ctx, cancel := context.WithTimeout(context.Background(), 3*time.Second)
	defer cancel()
	user, err := s.store.UserByID(ctx, id)
	return user, claims.ExpiresAt.Time, err
}
func (s *Server) auth(next http.Handler) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		raw, ok := strings.CutPrefix(r.Header.Get("Authorization"), "Bearer ")
		if !ok {
			fail(w, 401, "UNAUTHORIZED", "请先登录")
			return
		}
		u, _, err := s.parseToken(raw)
		if err != nil {
			fail(w, 401, "UNAUTHORIZED", "登录已过期，请重新登录")
			return
		}
		if !s.limiter.allowLimit("user:"+strconv.FormatInt(u.ID, 10), 180) {
			fail(w, 429, "RATE_LIMITED", "操作过于频繁，请稍后重试")
			return
		}
		next.ServeHTTP(w, r.WithContext(context.WithValue(r.Context(), userKey{}, u)))
	})
}

var usernamePattern = regexp.MustCompile(`^[a-z0-9_]{3,24}$`)

type credentials struct {
	Username string `json:"username"`
	Name     string `json:"name"`
	Password string `json:"password"`
}

func (s *Server) authRate(w http.ResponseWriter, r *http.Request) bool {
	ip, _, _ := net.SplitHostPort(r.RemoteAddr)
	if !s.limiter.allow(ip) {
		w.Header().Set("Retry-After", "60")
		fail(w, 429, "RATE_LIMITED", "尝试次数过多，请稍后再试")
		return false
	}
	return true
}
func (s *Server) register(w http.ResponseWriter, r *http.Request) {
	if !s.authRate(w, r) {
		return
	}
	var in credentials
	if !decode(w, r, &in) {
		return
	}
	in.Username = strings.ToLower(strings.TrimSpace(in.Username))
	in.Name = strings.TrimSpace(in.Name)
	if !usernamePattern.MatchString(in.Username) || utf8.RuneCountInString(in.Name) < 1 || utf8.RuneCountInString(in.Name) > 24 || len(in.Password) < 8 || len(in.Password) > 72 {
		fail(w, 400, "INVALID_CREDENTIALS", "账号需为 3–24 位小写字母、数字或下划线，昵称 1–24 字，密码 8–72 字节")
		return
	}
	hash, err := bcrypt.GenerateFromPassword([]byte(in.Password), bcrypt.DefaultCost)
	if err != nil {
		s.internal(w, err)
		return
	}
	u, err := s.store.CreateUser(r.Context(), in.Username, in.Name, string(hash))
	if errors.Is(err, store.ErrConflict) {
		fail(w, 409, "USERNAME_EXISTS", "账号已存在")
		return
	}
	if err != nil {
		s.internal(w, err)
		return
	}
	s.authResult(w, u, 201)
}
func (s *Server) login(w http.ResponseWriter, r *http.Request) {
	if !s.authRate(w, r) {
		return
	}
	var in credentials
	if !decode(w, r, &in) {
		return
	}
	if len(in.Password) > 72 || len(in.Username) > 24 {
		fail(w, 401, "INVALID_CREDENTIALS", "账号或密码错误")
		return
	}
	u, err := s.store.User(r.Context(), strings.ToLower(strings.TrimSpace(in.Username)))
	if err != nil && !errors.Is(err, sql.ErrNoRows) {
		s.internal(w, err)
		return
	}
	// 账号不存在时仍进行 bcrypt 运算，避免明显的响应耗时差异。
	hash := u.PasswordHash
	if err != nil {
		hash = "$2a$10$N9qo8uLOickgx2ZMRZoMyeIjZAgcfl7p92ldGxad68LJZdL17lhWy"
	}
	if bcrypt.CompareHashAndPassword([]byte(hash), []byte(in.Password)) != nil || err != nil {
		fail(w, 401, "INVALID_CREDENTIALS", "账号或密码错误")
		return
	}
	s.authResult(w, u, 200)
}
func (s *Server) authResult(w http.ResponseWriter, u store.User, status int) {
	token, err := s.token(u)
	if err != nil {
		s.internal(w, err)
		return
	}
	respond(w, status, map[string]any{"token": token, "user": u})
}
