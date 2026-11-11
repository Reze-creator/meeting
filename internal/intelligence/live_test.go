//go:build intelligence_integration

package intelligence

import (
	"context"
	"net/http"
	"os"
	"testing"
	"time"
)

// 仅发送固定合成会议资料，不读取用户真实会议。需要 DEEPSEEK_API_KEY，通常产生少量调用费用。
func TestRealDeepSeekMinutes(t *testing.T) {
	key := os.Getenv("DEEPSEEK_API_KEY")
	if key == "" {
		t.Skip("缺少 DEEPSEEK_API_KEY")
	}
	base := os.Getenv("DEEPSEEK_BASE_URL")
	if base == "" {
		base = "https://api.deepseek.com"
	}
	model := os.Getenv("DEEPSEEK_MODEL")
	if model == "" {
		model = "deepseek-flash"
	}
	c := Client{DeepSeekURL: base, DeepSeekKey: key, DeepSeekModel: model, HTTP: &http.Client{Timeout: 125 * time.Second}}
	ctx, cancel := context.WithTimeout(context.Background(), 120*time.Second)
	defer cancel()
	result, err := c.Summarize(ctx, `[{"type":"字幕","speaker":"测试主持人","text":"本次测试会议决定周五验收。测试成员小王负责补充登录测试，截止本周四。预算尚未确认。"}]`)
	if err != nil {
		t.Fatal(err)
	}
	if result.Overview == "" || len(result.Decisions) == 0 || len(result.Actions) == 0 {
		t.Fatal("真实模型未返回有效纪要")
	}
	t.Logf("真实 DeepSeek 结构化纪要通过，model=%s，决定=%d，行动项=%d", model, len(result.Decisions), len(result.Actions))
}
