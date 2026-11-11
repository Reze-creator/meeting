// Package media 封装 LiveKit 的令牌与房间管理 API，业务层不直接拼接媒体协议。
package media

import (
	"bytes"
	"context"
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"strconv"
	"strings"
	"time"

	"comeet/internal/config"
	"github.com/golang-jwt/jwt/v5"
)

type Client struct {
	URL, InternalURL, Key, Secret string
	HTTP                          *http.Client
}

func New(c config.Config) *Client {
	return &Client{URL: c.MediaURL, InternalURL: c.MediaInternalURL, Key: c.MediaKey, Secret: c.MediaSecret, HTTP: &http.Client{Timeout: 5 * time.Second}}
}
func (c *Client) Enabled() bool { return c.URL != "" }
func (c *Client) sign(identity, name string, grant map[string]any) (string, error) {
	now := time.Now()
	return jwt.NewWithClaims(jwt.SigningMethodHS256, jwt.MapClaims{"iss": c.Key, "sub": identity, "name": name, "nbf": now.Add(-5 * time.Second).Unix(), "exp": now.Add(2 * time.Minute).Unix(), "video": grant}).SignedString([]byte(c.Secret))
}

// JoinToken 仅开放指定房间与允许的媒体源，管理员密钥始终留在 Go 服务中。
func (c *Client) JoinToken(room string, id int64, name string, muted bool) (string, error) {
	sources := []string{"camera", "screen_share", "screen_share_audio"}
	if !muted {
		sources = append(sources, "microphone")
	}
	return c.sign(strconv.FormatInt(id, 10), name, map[string]any{"room": room, "roomJoin": true, "canPublish": true, "canSubscribe": true, "canPublishData": false, "canPublishSources": sources})
}
func (c *Client) call(ctx context.Context, room, method string, input, output any) error {
	if !c.Enabled() {
		return nil
	}
	token, err := c.sign("comeet-server", "", map[string]any{"room": room, "roomAdmin": true, "roomCreate": true})
	if err != nil {
		return err
	}
	body, err := json.Marshal(input)
	if err != nil {
		return err
	}
	base := strings.Replace(strings.Replace(c.InternalURL, "wss://", "https://", 1), "ws://", "http://", 1)
	req, err := http.NewRequestWithContext(ctx, "POST", strings.TrimRight(base, "/")+"/twirp/livekit.RoomService/"+method, bytes.NewReader(body))
	if err != nil {
		return err
	}
	req.Header.Set("Authorization", "Bearer "+token)
	req.Header.Set("Content-Type", "application/json")
	resp, err := c.HTTP.Do(req)
	if err != nil {
		return err
	}
	defer resp.Body.Close()
	if resp.StatusCode == 404 {
		return nil
	} // 不存在的房间/成员已经达到清理目标。
	if resp.StatusCode < 200 || resp.StatusCode >= 300 {
		return fmt.Errorf("LiveKit %s 返回 %d", method, resp.StatusCode)
	}
	if output != nil {
		return json.NewDecoder(io.LimitReader(resp.Body, 1<<20)).Decode(output)
	}
	return nil
}
func (c *Client) Remove(ctx context.Context, room string, id int64) error {
	return c.call(ctx, room, "RemoveParticipant", map[string]any{"room": room, "identity": strconv.FormatInt(id, 10)}, nil)
}
func (c *Client) End(ctx context.Context, room string) error {
	return c.call(ctx, room, "DeleteRoom", map[string]string{"room": room}, nil)
}
func (c *Client) Mute(ctx context.Context, room string, id int64, muted bool) error {
	identity := strconv.FormatInt(id, 10)
	// 修改发布源权限，阻止被静音用户绕过页面重新发布麦克风。
	sources := []string{"CAMERA", "SCREEN_SHARE", "SCREEN_SHARE_AUDIO"}
	if !muted {
		sources = append(sources, "MICROPHONE")
	}
	if err := c.call(ctx, room, "UpdateParticipant", map[string]any{"room": room, "identity": identity, "permission": map[string]any{"canPublish": true, "canSubscribe": true, "canPublishSources": sources}}, nil); err != nil {
		return err
	}
	if !muted {
		return nil
	} // 解除限制不替用户打开设备。
	var participant struct {
		Tracks []struct {
			SID    string `json:"sid"`
			Source string `json:"source"`
		} `json:"tracks"`
	}
	if err := c.call(ctx, room, "GetParticipant", map[string]string{"room": room, "identity": identity}, &participant); err != nil {
		return err
	}
	for _, t := range participant.Tracks {
		if t.Source == "MICROPHONE" {
			if err := c.call(ctx, room, "MutePublishedTrack", map[string]any{"room": room, "identity": identity, "trackSid": t.SID, "muted": true}, nil); err != nil {
				return err
			}
		}
	}
	return nil
}
