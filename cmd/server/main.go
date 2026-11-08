// Command server 启动 Comeet API，并托管已构建的前端页面。
package main

import (
	"context"
	"fmt"
	"log/slog"
	"net"
	"net/http"
	"os"
	"os/signal"
	"syscall"
	"time"

	"comeet/internal/config"
	"comeet/internal/server"
	"comeet/internal/store"
)

func main() {
	if err := run(); err != nil {
		slog.Error("服务退出", "error", err)
		os.Exit(1)
	}
}

func run() error {
	cfg, err := config.Load()
	if err != nil {
		return fmt.Errorf("读取配置: %w", err)
	}
	db, err := store.Open(cfg.DBPath)
	if err != nil {
		return fmt.Errorf("打开数据库: %w", err)
	}
	defer db.Close()
	listener, err := net.Listen("tcp", cfg.Addr)
	if err != nil {
		return fmt.Errorf("监听 %s: %w", cfg.Addr, err)
	}
	app := server.New(db, cfg)
	httpServer := &http.Server{
		Handler: app.Handler(), ReadHeaderTimeout: 5 * time.Second,
		ReadTimeout: 15 * time.Second, IdleTimeout: 60 * time.Second, MaxHeaderBytes: 16 << 10,
	}
	ctx, stop := signal.NotifyContext(context.Background(), os.Interrupt, syscall.SIGTERM)
	defer stop()
	serveResult := make(chan error, 1)
	go func() { serveResult <- httpServer.Serve(listener) }()
	slog.Info("Comeet 已启动", "address", "http://"+listener.Addr().String())
	var serveErr error
	select {
	case <-ctx.Done():
	case err := <-serveResult:
		if err != http.ErrServerClosed {
			serveErr = err
		}
	}
	// HTTP Shutdown 不关闭升级后的 WebSocket；先等房间协程退出，再关闭数据库。
	app.Close()
	shutdownCtx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()
	if err := httpServer.Shutdown(shutdownCtx); err != nil {
		return fmt.Errorf("关闭 HTTP: %w", err)
	}
	return serveErr
}
