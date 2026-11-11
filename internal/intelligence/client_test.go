package intelligence

import (
	"context"
	"io"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
)

func TestRejectsInvalidAndIncompleteMinutes(t *testing.T) {
	cases := []string{
		`{"choices":[]}`,
		`{"choices":[{"finish_reason":"length","message":{"content":"{}"}}]}`,
		`{"choices":[{"finish_reason":"stop","message":{"content":"not-json"}}]}`,
		`{"choices":[{"finish_reason":"stop","message":{"content":"{\"overview\":\"\",\"decisions\":[]}"}}]}`,
		`{"choices":[{"finish_reason":"stop","message":{"content":"{\"overview\":\"摘要\",\"actions\":\"错误类型\"}"}}]}`,
	}
	for _, body := range cases {
		t.Run(body, func(t *testing.T) {
			upstream := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) { _, _ = io.WriteString(w, body) }))
			defer upstream.Close()
			client := Client{DeepSeekURL: upstream.URL, DeepSeekModel: "deepseek-flash", HTTP: upstream.Client()}
			if _, err := client.Summarize(context.Background(), "固定测试资料"); err == nil {
				t.Fatal("接受了无效纪要")
			}
		})
	}
}
func TestProviderErrorDoesNotDiscloseBody(t *testing.T) {
	upstream := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
		w.WriteHeader(401)
		_, _ = io.WriteString(w, "sensitive-provider-body")
	}))
	defer upstream.Close()
	client := Client{STTURL: upstream.URL, HTTP: upstream.Client()}
	_, err := client.Transcribe(context.Background(), []byte("test"), "zh")
	if err == nil || strings.Contains(err.Error(), "sensitive-provider-body") {
		t.Fatal("错误处理泄露了上游正文")
	}
}
