// Package config 读取明确约定的环境配置与本地 .env 文件。
package config

import (
	"bufio"
	"crypto/rand"
	"encoding/hex"
	"fmt"
	"log/slog"
	"os"
	"strings"
)

type Config struct {
	Addr, DBPath, JWTSecret string
	AllowedOrigins          map[string]bool
}

func Load() (Config, error) {
	// 系统环境变量优先于 .env，便于 CI 和部署环境覆盖本地配置。
	if f, err := os.Open(".env"); err == nil {
		defer f.Close()
		s := bufio.NewScanner(f)
		for s.Scan() {
			line := strings.TrimSpace(s.Text())
			if line == "" || strings.HasPrefix(line, "#") {
				continue
			}
			key, value, ok := strings.Cut(line, "=")
			if !ok {
				return Config{}, fmt.Errorf(".env 配置必须使用 KEY=VALUE")
			}
			key = strings.TrimSpace(key)
			if _, exists := os.LookupEnv(key); !exists {
				if err := os.Setenv(key, strings.Trim(strings.TrimSpace(value), "\"'")); err != nil {
					return Config{}, err
				}
			}
		}
		if err := s.Err(); err != nil {
			return Config{}, err
		}
	} else if !os.IsNotExist(err) {
		return Config{}, err
	}
	c := Config{Addr: value("ADDR", "127.0.0.1:8080"), DBPath: value("DB_PATH", "data/comeet.db"), JWTSecret: os.Getenv("JWT_SECRET"), AllowedOrigins: map[string]bool{}}
	if c.JWTSecret == "" {
		b := make([]byte, 32)
		if _, err := rand.Read(b); err != nil {
			return c, err
		}
		c.JWTSecret = hex.EncodeToString(b)
		slog.Warn("未配置 JWT_SECRET，使用临时开发密钥；重启后需要重新登录")
	}
	if len(c.JWTSecret) < 32 {
		return c, fmt.Errorf("JWT_SECRET 至少需要 32 个字节")
	}
	for _, origin := range strings.Split(value("ALLOWED_ORIGINS", "http://localhost:5173,http://127.0.0.1:5173,http://localhost:8080,http://127.0.0.1:8080"), ",") {
		c.AllowedOrigins[strings.TrimSpace(origin)] = true
	}
	return c, nil
}

func value(key, fallback string) string {
	if v := os.Getenv(key); v != "" {
		return v
	}
	return fallback
}
