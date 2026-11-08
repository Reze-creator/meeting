package server

import (
	"encoding/json"
	"io"
	"log/slog"
	"net/http"
)

func respond(w http.ResponseWriter, status int, data any) {
	w.Header().Set("Content-Type", "application/json; charset=utf-8")
	w.WriteHeader(status)
	_ = json.NewEncoder(w).Encode(envelope{Data: data})
}
func fail(w http.ResponseWriter, status int, code, message string) {
	w.Header().Set("Content-Type", "application/json; charset=utf-8")
	w.WriteHeader(status)
	_ = json.NewEncoder(w).Encode(envelope{Error: &apiError{Code: code, Message: message}})
}
func decode(w http.ResponseWriter, r *http.Request, v any) bool {
	r.Body = http.MaxBytesReader(w, r.Body, 16<<10)
	d := json.NewDecoder(r.Body)
	d.DisallowUnknownFields()
	if err := d.Decode(v); err != nil {
		fail(w, 400, "INVALID_REQUEST", "请求内容无效或过长")
		return false
	}
	if err := d.Decode(new(any)); err != io.EOF {
		fail(w, 400, "INVALID_REQUEST", "只允许一个 JSON 对象")
		return false
	}
	return true
}
func (s *Server) internal(w http.ResponseWriter, err error) {
	slog.Error("处理请求失败", "error", err)
	fail(w, 500, "INTERNAL_ERROR", "服务暂时不可用，请稍后重试")
}
