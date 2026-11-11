package server

import (
	"sync"
	"time"
)

type hit struct {
	count int
	reset time.Time
}
type rateLimiter struct {
	mu   sync.Mutex
	hits map[string]hit
}

func (l *rateLimiter) allow(key string) bool {
	return l.allowLimit("auth:"+key, 30)
}
func (l *rateLimiter) allowLimit(key string, limit int) bool {
	l.mu.Lock()
	defer l.mu.Unlock()
	t := time.Now()
	if len(l.hits) > 10000 {
		for k, v := range l.hits {
			if t.After(v.reset) {
				delete(l.hits, k)
			}
		}
		if len(l.hits) > 10000 {
			return false
		}
	}
	v := l.hits[key]
	if t.After(v.reset) {
		v = hit{reset: t.Add(time.Minute)}
	}
	v.count++
	l.hits[key] = v
	return v.count <= limit
}
