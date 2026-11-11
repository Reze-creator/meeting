package server

import (
	"comeet/internal/config"
	"comeet/internal/intelligence"
	"comeet/internal/media"
	"comeet/internal/store"
	"context"
	"log/slog"
	"net/http"
	"os"
	"path/filepath"
	"strings"
	"sync"
	"time"
)

type Server struct {
	store                     *store.Store
	cfg                       config.Config
	hub                       *Hub
	limiter                   *rateLimiter
	media                     *media.Client
	cancel                    context.CancelFunc
	worker                    sync.WaitGroup
	cleanup                   map[string]bool
	intelligence              *intelligence.Client
	transcribing, summarizing sync.Map
	sttSlots                  chan struct{}
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
	if cfg.RecordingDir == "" {
		cfg.RecordingDir = "data/recordings"
	}
	s := &Server{store: db, cfg: cfg, limiter: &rateLimiter{hits: map[string]hit{}}, media: media.New(cfg), cleanup: map[string]bool{}}
	s.hub = newHub(db)
	s.sttSlots = make(chan struct{}, 4)
	s.intelligence = &intelligence.Client{STTURL: cfg.STTURL, STTKey: cfg.STTKey, STTModel: cfg.STTModel, DeepSeekURL: cfg.DeepSeekURL, DeepSeekKey: cfg.DeepSeekKey, DeepSeekModel: cfg.DeepSeekModel, HTTP: &http.Client{Timeout: 125 * time.Second, CheckRedirect: func(_ *http.Request, _ []*http.Request) error { return http.ErrUseLastResponse }}}
	s.hub.media = s.media
	ctx, cancel := context.WithCancel(context.Background())
	s.cancel = cancel
	s.worker.Add(1)
	go s.schedule(ctx)
	return s
}
func (s *Server) Close() { s.cancel(); s.worker.Wait(); s.hub.close() }

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
	mux.Handle("GET /api/intelligence", s.auth(http.HandlerFunc(s.intelligenceStatus)))
	mux.Handle("GET /api/meetings/{id}/captions", s.auth(http.HandlerFunc(s.captions)))
	mux.Handle("POST /api/meetings/{id}/transcribe", s.auth(http.HandlerFunc(s.transcribe)))
	mux.Handle("GET /api/meetings/{id}/transcript", s.auth(http.HandlerFunc(s.exportCaptions)))
	mux.Handle("GET /api/meetings/{id}/minutes", s.auth(http.HandlerFunc(s.minutes)))
	mux.Handle("POST /api/meetings/{id}/minutes", s.auth(http.HandlerFunc(s.generateMinutes)))
	mux.Handle("POST /api/meetings/{id}/moderation", s.auth(http.HandlerFunc(s.moderate)))
	mux.Handle("POST /api/meetings/{id}/media-token", s.auth(http.HandlerFunc(s.mediaToken)))
	mux.Handle("GET /api/meetings/{id}/history", s.auth(http.HandlerFunc(s.history)))
	mux.Handle("POST /api/meetings/{id}/recordings", s.auth(http.HandlerFunc(s.uploadRecording)))
	mux.Handle("GET /api/recordings/{recording}", s.auth(http.HandlerFunc(s.downloadRecording)))
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
		started := time.Now()
		next.ServeHTTP(w, r)
		if strings.HasPrefix(r.URL.Path, "/api/") {
			slog.Info("http_request", "method", r.Method, "path", r.URL.Path, "duration_ms", time.Since(started).Milliseconds())
		}
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
