package server

import (
	"comeet/internal/config"
	"comeet/internal/store"
	"log/slog"
	"net/http"
	"os"
	"path/filepath"
	"strings"
)

type Server struct {
	store   *store.Store
	cfg     config.Config
	hub     *Hub
	limiter *rateLimiter
}
type userKey struct{}
type envelope struct {
	Data  any       `json:"data,omitempty"`
	Error *apiError `json:"error,omitempty"`
}
type apiError struct {
	Code    string `json:"code"`
	Message string `json:"message"`
}

func New(db *store.Store, cfg config.Config) *Server {
	s := &Server{store: db, cfg: cfg, limiter: &rateLimiter{hits: map[string]hit{}}}
	s.hub = newHub(db)
	return s
}
func (s *Server) Close() { s.hub.close() }

func (s *Server) Handler() http.Handler {
	mux := http.NewServeMux()
	mux.HandleFunc("GET /api/health", func(w http.ResponseWriter, r *http.Request) { respond(w, 200, map[string]string{"status": "ok"}) })
	mux.HandleFunc("POST /api/auth/register", s.register)
	mux.HandleFunc("POST /api/auth/login", s.login)
	mux.Handle("GET /api/me", s.auth(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) { respond(w, 200, currentUser(r)) })))
	mux.Handle("GET /api/meetings", s.auth(http.HandlerFunc(s.listMeetings)))
	mux.Handle("POST /api/meetings", s.auth(http.HandlerFunc(s.createMeeting)))
	mux.Handle("POST /api/meetings/{id}/join", s.auth(http.HandlerFunc(s.joinMeeting)))
	mux.Handle("POST /api/meetings/{id}/leave", s.auth(http.HandlerFunc(s.leaveMeeting)))
	mux.Handle("POST /api/meetings/{id}/end", s.auth(http.HandlerFunc(s.endMeeting)))
	mux.Handle("GET /api/meetings/{id}", s.auth(http.HandlerFunc(s.meetingDetail)))
	mux.Handle("GET /api/meetings/{id}/messages", s.auth(http.HandlerFunc(s.messages)))
	mux.HandleFunc("GET /ws", s.websocket)
	mux.HandleFunc("/api/", func(w http.ResponseWriter, r *http.Request) { fail(w, 404, "NOT_FOUND", "接口不存在") })
	mux.HandleFunc("/", serveWeb)
	return s.middleware(mux)
}

func (s *Server) middleware(next http.Handler) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("X-Content-Type-Options", "nosniff")
		w.Header().Set("Referrer-Policy", "same-origin")
		if strings.HasPrefix(r.URL.Path, "/api/") {
			w.Header().Set("Cache-Control", "no-store")
		}
		if origin := r.Header.Get("Origin"); origin != "" {
			if !s.cfg.AllowedOrigins[origin] {
				fail(w, 403, "ORIGIN_DENIED", "请求来源不受信任")
				return
			}
			w.Header().Set("Access-Control-Allow-Origin", origin)
			w.Header().Add("Vary", "Origin")
			w.Header().Set("Access-Control-Allow-Headers", "Authorization, Content-Type")
			w.Header().Set("Access-Control-Allow-Methods", "GET, POST, OPTIONS")
		}
		if r.Method == http.MethodOptions {
			w.WriteHeader(204)
			return
		}
		defer func() {
			if err := recover(); err != nil {
				slog.Error("请求发生异常", "path", r.URL.Path, "error", err)
				fail(w, 500, "INTERNAL_ERROR", "服务暂时不可用")
			}
		}()
		next.ServeHTTP(w, r)
	})
}

// 仅对无扩展名的页面路由返回 SPA 入口；丢失的静态资源仍返回 404。
func serveWeb(w http.ResponseWriter, r *http.Request) {
	if r.Method != "GET" && r.Method != "HEAD" {
		fail(w, 405, "METHOD_NOT_ALLOWED", "不支持的请求方法")
		return
	}
	root := "web/dist"
	path := filepath.Join(root, filepath.Clean("/"+r.URL.Path))
	if info, err := os.Stat(path); err == nil && !info.IsDir() {
		http.ServeFile(w, r, path)
		return
	}
	if filepath.Ext(r.URL.Path) != "" {
		http.NotFound(w, r)
		return
	}
	if _, err := os.Stat(filepath.Join(root, "index.html")); err != nil {
		fail(w, 404, "WEB_NOT_BUILT", "前端尚未构建，请在 web 中运行 npm run build，或使用开发服务器")
		return
	}
	w.Header().Set("Cache-Control", "no-cache")
	http.ServeFile(w, r, filepath.Join(root, "index.html"))
}
