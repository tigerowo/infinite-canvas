package service

import (
	"errors"
	"io"
	"net/http"
	"net/http/httptest"
	"reflect"
	"sort"
	"strings"
	"testing"

	"github.com/tigerowo/infinite-canvas/model"
)

func TestModelProtocolAuthContract(t *testing.T) {
	for _, protocol := range []string{"", "openai", " GEMINI ", "grok2api", "metaso", "apimart", "kie", "mimo", "88api", " AUTODL ", "unknown"} {
		request := httptest.NewRequest(http.MethodPost, "https://upstream.invalid", nil)
		request.Header.Set("Authorization", "existing authorization")
		request.Header.Set("x-goog-api-key", "existing google key")
		channel := model.ModelChannel{Protocol: protocol, APIKey: "test-key", BaseURL: "https://api.kie.ai"}
		SetModelChannelAuthHeader(request, channel)
		wantAuthorization, wantGoogle := "Bearer test-key", "existing google key"
		if protocol == " GEMINI " {
			wantAuthorization, wantGoogle = "existing authorization", "test-key"
		}
		if protocol == " AUTODL " {
			wantAuthorization = "test-key"
		}
		if request.Header.Get("Authorization") != wantAuthorization || request.Header.Get("x-goog-api-key") != wantGoogle {
			t.Errorf("%q auth changed: %v", protocol, request.Header)
		}
	}
}

func TestModelProtocolStaticDiscoveryPrecedence(t *testing.T) {
	stubProtocolAdminHTTP(t, func(*http.Request) (*http.Response, error) {
		t.Error("static model discovery performed network I/O")
		return nil, errors.New("network forbidden")
	})
	mimo := MiMoModels()
	kie := kieMarketModels()
	sort.Strings(mimo)
	sort.Strings(kie)
	tests := []struct {
		name, protocol, baseURL string
		want                    []string
	}{
		{"metaso before URL inference", "metaso", "https://xiaomimimo.com/kie.ai", []string{"MiniMax-H3"}},
		{"mimo URL before explicit kie", "kie", "https://xiaomimimo.com", mimo},
		{"mimo before kie URL", "mimo", "https://api.kie.ai", mimo},
		{"kie URL inference", "openai", "https://api.kie.ai", kie},
	}
	for _, test := range tests {
		t.Run(test.name, func(t *testing.T) {
			got, err := AdminChannelModels(nil, model.ModelChannel{Protocol: test.protocol, BaseURL: test.baseURL, APIKey: "test-key"})
			if err != nil || !reflect.DeepEqual(got, test.want) {
				t.Fatalf("got %v, %v; want %v", got, err, test.want)
			}
		})
	}
}

func TestModelProtocolGeminiDiscoveryContract(t *testing.T) {
	calls := 0
	stubProtocolAdminHTTP(t, func(request *http.Request) (*http.Response, error) {
		calls++
		if request.URL.Path != "/v1beta/models" || request.Header.Get("x-goog-api-key") != "test-key" || request.Header.Get("Authorization") != "" {
			t.Errorf("unexpected Gemini request: %s %v", request.URL, request.Header)
		}
		if calls == 1 {
			if request.URL.RawQuery != "" {
				t.Errorf("first page query: %s", request.URL.RawQuery)
			}
			return protocolAdminResponse(`{"models":[{"name":"models/z","supportedGenerationMethods":["generateContent"]},{"name":"models/embed-text","supportedGenerationMethods":["generateContent"]},{"name":"models/no-method"},{"name":"models/veo-a"}],"nextPageToken":"a+b x"}`), nil
		}
		if calls != 2 || request.URL.RawQuery != "pageToken=a%2Bb+x" {
			t.Errorf("unexpected continuation: %s", request.URL)
		}
		return protocolAdminResponse(`{"models":[{"name":"models/a","supportedGenerationMethods":["predictLongRunning"]},{"name":"models/z","supportedGenerationMethods":["generateContent"]},{"name":"models/imagen-b"}]}`), nil
	})
	// Gemini must win even when the URL also looks like a KIE channel.
	got, err := AdminChannelModels(nil, model.ModelChannel{Protocol: "gemini", BaseURL: "https://api.kie.ai/v1beta", APIKey: "test-key"})
	want := []string{"a", "imagen-b", "veo-a", "z"}
	if err != nil || !reflect.DeepEqual(got, want) || calls != 2 {
		t.Fatalf("Gemini discovery got %v, %v, %d calls; want %v, 2 calls", got, err, calls, want)
	}
}

func TestModelProtocolConfigTestsDoNotGenerate(t *testing.T) {
	stubProtocolAdminHTTP(t, func(*http.Request) (*http.Response, error) {
		t.Error("configuration-only test performed an upstream generation")
		return nil, errors.New("network forbidden")
	})
	tests := []struct{ protocol, baseURL, model, want string }{
		{"metaso", "https://api.example/api/plan/v3", "seedance", "MiniMax-H3 是异步视频模型，请在视频创作台测试生成。"},
		{"88api", "https://api.example/api/plan/v3", "seedance", "88API 渠道不会调用聊天接口测试，请在对应创作台验证模型。"},
		{"openai", "https://api.example/api/plan/v3", "deployment", "Agent Plan / Seedance 视频模型配置格式已通过。后台测试不会调用视频生成接口，因此未验证 API Key、套餐额度或模型权限；请在画布中使用视频生成验证。"},
		{"gemini", "https://api.example", "seedance", "Seedance 视频模型不会发送 /chat/completions 文本测试。已检查 Base URL、API Key 和模型名非空；未调用视频生成接口，因此未验证套餐额度或模型权限。"},
		{"gemini", "https://api.example", "veo-3", "模型列表与渠道配置有效；图片、视频和语音模型未执行付费生成测试。"},
		{"gemini", "https://api.example", "gemini-image", "模型列表与渠道配置有效；图片、视频和语音模型未执行付费生成测试。"},
		{"gemini", "https://api.example", "mimo-v2.5-tts-voiceclone", "MiMo VoiceClone 需要画布连接 MP3/WAV 参考音频，后台不发送克隆样本，因此未执行上游生成测试。"},
	}
	for _, test := range tests {
		channel := model.ModelChannel{Protocol: test.protocol, BaseURL: test.baseURL, APIKey: "test-key"}
		got, err := AdminTestChannelModel(nil, channel, test.model)
		if err != nil || got != test.want {
			t.Errorf("%s/%s: got %q, %v; want %q", test.protocol, test.model, got, err, test.want)
		}
	}
}

func TestModelProtocolGenerationTestPrecedence(t *testing.T) {
	tests := []struct {
		name, protocol, model, path, authorization, googleKey, response string
	}{
		{"GLM before Gemini", "gemini", "glm-tts", "/audio/speech", "Bearer test-key", "", "audio"},
		{"MiMo before Gemini", "gemini", "mimo-v2.5-tts", "/chat/completions", "Bearer test-key", "", `{"choices":[{"message":{"audio":{"data":"AAAA"}}}]}`},
		{"Gemini text", "gemini", "gemini-text", "/v1beta/models/gemini-text:generateContent", "", "test-key", `{"candidates":[{"content":{"parts":[{"text":"ok"}]}}]}`},
		{"compatible text", "openai", "text-model", "/v1/chat/completions", "Bearer test-key", "", `{"choices":[{"message":{"content":"ok"}}]}`},
	}
	for _, test := range tests {
		t.Run(test.name, func(t *testing.T) {
			calls := 0
			stubProtocolAdminHTTP(t, func(request *http.Request) (*http.Response, error) {
				calls++
				if request.URL.Path != test.path || request.Header.Get("Authorization") != test.authorization || request.Header.Get("x-goog-api-key") != test.googleKey {
					t.Errorf("generation test route changed: %s %v", request.URL, request.Header)
				}
				return protocolAdminResponse(test.response), nil
			})
			got, err := AdminTestChannelModel(nil, model.ModelChannel{Protocol: test.protocol, BaseURL: "https://upstream.invalid", APIKey: "test-key"}, test.model)
			if calls != 1 {
				t.Fatalf("got %q, %v, %d calls", got, err, calls)
			}
			if err != nil || got != "ok" {
				t.Fatalf("got %q, %v; want ok", got, err)
			}
		})
	}
}

type protocolAdminTransport func(*http.Request) (*http.Response, error)

func (transport protocolAdminTransport) RoundTrip(request *http.Request) (*http.Response, error) {
	return transport(request)
}

func stubProtocolAdminHTTP(t *testing.T, transport protocolAdminTransport) {
	t.Helper()
	previous := adminModelHTTPClient
	adminModelHTTPClient = &http.Client{Transport: transport}
	t.Cleanup(func() { adminModelHTTPClient = previous })
}

func protocolAdminResponse(body string) *http.Response {
	return &http.Response{StatusCode: http.StatusOK, Header: http.Header{"Content-Type": []string{"application/json"}}, Body: io.NopCloser(strings.NewReader(body))}
}
