//go:build integration

package media

import (
	"context"
	"os"
	"testing"
	"time"

	"comeet/internal/config"
	"github.com/livekit/protocol/livekit"
	lksdk "github.com/livekit/server-sdk-go/v2"
	"github.com/pion/webrtc/v4"
	pmedia "github.com/pion/webrtc/v4/pkg/media"
)

// 此测试使用真实 LiveKit 和真实 WebRTC 传输，不访问用户的麦克风或摄像头。
func TestLiveKitRealMediaAndModeration(t *testing.T) {
	url := os.Getenv("LIVEKIT_TEST_URL")
	if url == "" {
		t.Skip("设置 LIVEKIT_TEST_URL 后运行真实 SFU 集成测试")
	}
	key := os.Getenv("LIVEKIT_TEST_KEY")
	secret := os.Getenv("LIVEKIT_TEST_SECRET")
	if key == "" {
		key = "devkey"
	}
	if secret == "" {
		secret = "secret"
	}
	client := New(config.Config{MediaURL: url, MediaInternalURL: url, MediaKey: key, MediaSecret: secret})
	roomName := "comeet-integration-" + time.Now().Format("150405.000")
	defer client.End(context.Background(), roomName)
	hostToken, err := client.JoinToken(roomName, 1, "主持人", false)
	if err != nil {
		t.Fatal(err)
	}
	guestToken, err := client.JoinToken(roomName, 2, "参会者", false)
	if err != nil {
		t.Fatal(err)
	}
	received := make(chan bool, 1)
	removed := make(chan bool, 1)
	callback := lksdk.NewRoomCallback()
	callback.OnTrackSubscribed = func(track *webrtc.TrackRemote, _ *lksdk.RemoteTrackPublication, _ *lksdk.RemoteParticipant) {
		go func() {
			if _, _, err := track.ReadRTP(); err == nil {
				select {
				case received <- true:
				default:
				}
			}
		}()
	}
	callback.OnDisconnected = func() {
		select {
		case removed <- true:
		default:
		}
	}
	guest, err := lksdk.ConnectToRoomWithToken(url, guestToken, callback)
	if err != nil {
		t.Fatal(err)
	}
	defer guest.Disconnect()
	host, err := lksdk.ConnectToRoomWithToken(url, hostToken, lksdk.NewRoomCallback())
	if err != nil {
		t.Fatal(err)
	}
	defer host.Disconnect()
	track, err := lksdk.NewLocalSampleTrack(webrtc.RTPCodecCapability{MimeType: webrtc.MimeTypeOpus, ClockRate: 48000, Channels: 2})
	if err != nil {
		t.Fatal(err)
	}
	publication, err := host.LocalParticipant.PublishTrack(track, &lksdk.TrackPublicationOptions{Name: "test-mic", Source: livekit.TrackSource_MICROPHONE})
	if err != nil {
		t.Fatal(err)
	}
	stop := make(chan struct{})
	defer close(stop)
	go func() {
		ticker := time.NewTicker(20 * time.Millisecond)
		defer ticker.Stop()
		for {
			select {
			case <-stop:
				return
			case <-ticker.C:
				_ = track.WriteSample(pmedia.Sample{Data: []byte{0xf8, 0xff, 0xfe}, Duration: 20 * time.Millisecond}, nil)
			}
		}
	}()
	select {
	case <-received:
	case <-time.After(15 * time.Second):
		t.Fatal("SFU 未向第二个客户端转发音频 RTP")
	}
	if err := client.Mute(context.Background(), roomName, 1, true); err != nil {
		t.Fatal(err)
	}
	admin := lksdk.NewRoomServiceClient(url, key, secret)
	participant, err := admin.GetParticipant(context.Background(), &livekit.RoomParticipantIdentity{Room: roomName, Identity: "1"})
	if err != nil {
		t.Fatal(err)
	}
	for _, source := range participant.Permission.CanPublishSources {
		if source == livekit.TrackSource_MICROPHONE {
			t.Fatal("媒体服务仍允许麦克风发布")
		}
	}
	for _, info := range participant.Tracks {
		if info.Sid == publication.SID() && !info.Muted {
			t.Fatal("媒体服务没有静音现有轨道")
		}
	}
	if err := client.Remove(context.Background(), roomName, 2); err != nil {
		t.Fatal(err)
	}
	select {
	case <-removed:
	case <-time.After(5 * time.Second):
		t.Fatal("移出后媒体客户端仍未断开")
	}
	if err := client.End(context.Background(), roomName); err != nil {
		t.Fatal(err)
	}
}
