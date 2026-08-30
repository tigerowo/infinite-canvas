package service

import (
	"encoding/json"
	"errors"
	"reflect"
	"strings"
	"testing"
)

func TestJimengGenerationRequestAllowsPublicModelProfiles(t *testing.T) {
	for _, request := range []cliCompanionActionRequest{
		{Action: cliCompanionActionGenerationStart, UserID: "user-1", ProviderID: "provider-1", Protocol: "jimeng", GenerationType: "image", Model: "jimeng-image-3.0", Prompt: "纸艺老虎", Ratio: "1:1", Resolution: "1k"},
		{Action: cliCompanionActionGenerationStart, UserID: "user-1", ProviderID: "provider-1", Protocol: "jimeng", GenerationType: "image", Model: "jimeng-image-5.0Pro", Prompt: "纸艺老虎", Ratio: "3:2", Resolution: "4k"},
		{Action: cliCompanionActionGenerationStart, UserID: "user-1", ProviderID: "provider-1", Protocol: "jimeng", GenerationType: "video", Model: "jimeng-video-seedance2.0_vip", Prompt: "海边日落", Ratio: "16:9", Resolution: "4k", Duration: 15},
		{Action: cliCompanionActionGenerationStart, UserID: "user-1", ProviderID: "provider-1", Protocol: "jimeng", GenerationType: "video", Model: "jimeng-video-seedance2.5", Prompt: "海边日落", Ratio: "21:9", Resolution: "480p", Duration: 30},
	} {
		if !validCLICompanionActionRequest(request) {
			t.Fatalf("public profile should be accepted: %#v", request)
		}
	}
	video := cliCompanionActionRequest{Action: cliCompanionActionGenerationStart, UserID: "user-1", ProviderID: "provider-1", Protocol: "jimeng", GenerationType: "video", Model: jimengVideoModel, Prompt: "海边日落", Ratio: "16:9", Resolution: "720p", Duration: 4}
	for name, mutate := range map[string]func(*cliCompanionActionRequest){
		"model":       func(value *cliCompanionActionRequest) { value.Model = "seedance2.0_vip" },
		"resolution":  func(value *cliCompanionActionRequest) { value.Resolution = "4k" },
		"duration":    func(value *cliCompanionActionRequest) { value.Duration = 16 },
		"ratio":       func(value *cliCompanionActionRequest) { value.Ratio = "custom" },
		"video ratio": func(value *cliCompanionActionRequest) { value.Ratio = "3:2" },
		"nul":         func(value *cliCompanionActionRequest) { value.Prompt = "unsafe\x00prompt" },
	} {
		t.Run(name, func(t *testing.T) {
			candidate := video
			mutate(&candidate)
			if validCLICompanionActionRequest(candidate) {
				t.Fatalf("unsafe request accepted: %#v", candidate)
			}
		})
	}
}

func TestSubscriptionImageGenerationRequestKeepsQuotaRoutesSeparate(t *testing.T) {
	primary := cliCompanionActionRequest{Action: cliCompanionActionGenerationStart, UserID: "user-1", ProviderID: "provider-primary", Protocol: "gpt-image-2", GenerationType: "image", Model: cliGPTImage2Model, Prompt: "纸艺老虎", Ratio: "1:1", Resolution: "low"}
	emergency := cliCompanionActionRequest{Action: cliCompanionActionGenerationStart, UserID: "user-1", ProviderID: "provider-emergency", Protocol: "codex-image-emergency", GenerationType: "image", Model: cliCodexEmergencyImageModel, Prompt: "纸艺老虎", Ratio: "16:9", Resolution: "medium"}
	if !validCLICompanionActionRequest(primary) || !validCLICompanionActionRequest(emergency) {
		t.Fatal("controlled subscription image routes should be accepted")
	}
	for name, value := range map[string]cliCompanionActionRequest{
		"paid API fallback model":          func() cliCompanionActionRequest { item := primary; item.Model = "gpt-5.4"; return item }(),
		"primary model on emergency route": func() cliCompanionActionRequest { item := emergency; item.Model = cliGPTImage2Model; return item }(),
		"unsupported ratio":                func() cliCompanionActionRequest { item := primary; item.Ratio = "21:9"; return item }(),
		"reference-like extra duration":    func() cliCompanionActionRequest { item := primary; item.Duration = 1; return item }(),
	} {
		t.Run(name, func(t *testing.T) {
			if validCLICompanionActionRequest(value) {
				t.Fatalf("unsafe request accepted: %#v", value)
			}
		})
	}
}

func TestSubscriptionImageSizeIsFixedByRatio(t *testing.T) {
	for ratio, want := range map[string]string{"1:1": "1024x1024", "16:9": "1536x1024", "9:16": "1024x1536", "3:2": "1536x1024", "2:3": "1024x1536"} {
		if got := subscriptionImageSize(ratio); got != want {
			t.Fatalf("ratio=%s size=%s want=%s", ratio, got, want)
		}
	}
}

func TestSubscriptionImageDiagnosticIsBoundedAndRedacted(t *testing.T) {
	prompt := "私密生图提示词"
	diagnostic := safeSubscriptionImageDiagnostic(
		`{"prompt":"私密生图提示词","token":"secret-token","message":"unauthorized"}`,
		`request failed https://example.test/path?code=secret-code eyJhbGciOiJIUzI1NiJ9.payload.signature`,
		prompt,
		errors.New("exit status 1"),
	)
	for _, secret := range []string{prompt, "secret-token", "secret-code", "eyJhbGciOiJIUzI1NiJ9"} {
		if strings.Contains(diagnostic, secret) {
			t.Fatalf("diagnostic leaked %q: %s", secret, diagnostic)
		}
	}
	if message := subscriptionImageFailureMessage(diagnostic); message != "GPT Image 2 订阅登录已失效，请重新登录 Codex" {
		t.Fatalf("message=%q diagnostic=%q", message, diagnostic)
	}
	if message := subscriptionImageFailureMessage("HTTP 429 too many requests"); message != "GPT Image 2 订阅请求频率受限，请稍后重试" {
		t.Fatalf("rate-limit message=%q", message)
	}
	if len([]rune(safeSubscriptionImageDiagnostic(strings.Repeat("x", 800), "", "", errors.New("exit status 1")))) != 512 {
		t.Fatal("diagnostic should be capped at 512 runes")
	}
}

func TestSubscriptionImageDoctorRequiresReachableCodexEndpoint(t *testing.T) {
	success := `{"ok":true,"provider_selection":{"resolved":"codex"},"providers":{"codex":{"auth":{"ready":true,"expired":false},"endpoint":{"reachable":true}}}}`
	if diagnostic, err := subscriptionImageDoctorResult(success, "", nil); err != nil || diagnostic != "" {
		t.Fatalf("diagnostic=%q error=%v", diagnostic, err)
	}
	unreachable := `{"ok":false,"provider_selection":{"resolved":"codex"},"providers":{"codex":{"auth":{"ready":true,"expired":false,"email":"private@example.test"},"endpoint":{"reachable":false,"error":"error sending request for url (https://chatgpt.com/backend-api/codex/responses?token=secret)"}}}}`
	diagnostic, err := subscriptionImageDoctorResult(unreachable, "", errors.New("exit status 1"))
	if err == nil || !strings.Contains(diagnostic, "network connection failed") {
		t.Fatalf("diagnostic=%q error=%v", diagnostic, err)
	}
	for _, secret := range []string{"private@example.test", "token=secret"} {
		if strings.Contains(diagnostic, secret) {
			t.Fatalf("doctor diagnostic leaked %q: %s", secret, diagnostic)
		}
	}
}

func TestSubscriptionImageTimeoutMessageUsesThreeMinuteBudget(t *testing.T) {
	if message := subscriptionImageTimeoutMessage(""); message != "订阅生图调用超时（3分钟）" {
		t.Fatalf("message=%q", message)
	}
	if message := subscriptionImageTimeoutMessage("network connection failed"); !strings.Contains(message, "3分钟") || !strings.Contains(message, "网络请求失败") {
		t.Fatalf("message=%q", message)
	}
}

func TestDreaminaGenerationArgumentsUseSelectedProfile(t *testing.T) {
	image := dreaminaGenerationArguments(cliCompanionActionRequest{GenerationType: "image", Model: "jimeng-image-5.0Pro", Prompt: "含 空格 的提示词", Ratio: "3:4", Resolution: "1.5k"})
	wantImage := []string{"text2image", "--prompt=含 空格 的提示词", "--ratio", "3:4", "--resolution_type", "1.5k", "--model_version", "5.0Pro", "--generate_num", "1", "--poll", "0"}
	if !reflect.DeepEqual(image, wantImage) {
		t.Fatalf("image args=%q", image)
	}
	video := dreaminaGenerationArguments(cliCompanionActionRequest{GenerationType: "video", Model: "jimeng-video-seedance2.5", Prompt: "slow pan", Ratio: "16:9", Resolution: "1080p", Duration: 12})
	if strings.Join(video, " ") != "text2video --prompt=slow pan --duration 12 --ratio 16:9 --video_resolution 1080p --model_version seedance2.5 --poll 0" {
		t.Fatalf("video args=%q", video)
	}
}

func TestJimengImageTaskKeepsOnlyOneResultURL(t *testing.T) {
	urls := []string{"https://cdn.example.test/a.png", "https://cdn.example.test/b.png"}
	if got := jimengResultURLsForRequest("image", urls); !reflect.DeepEqual(got, urls[:1]) {
		t.Fatalf("image urls=%q", got)
	}
	if got := jimengResultURLsForRequest("video", urls); !reflect.DeepEqual(got, urls) {
		t.Fatalf("video urls=%q", got)
	}
}

func TestParseDreaminaTaskResponseKeepsOnlyHTTPSResults(t *testing.T) {
	running, err := parseDreaminaTaskResponse(`log\n{"data":{"submit_id":"123456","gen_status":"querying"}}`)
	if err != nil || running.SubmitID != "123456" || running.Status != "running" {
		t.Fatalf("running=%#v err=%v", running, err)
	}
	done, err := parseDreaminaTaskResponse(`{"data":{"submit_id":123456,"gen_status":"success","image_url":["https://cdn.example.test/a.png","http://unsafe.test/b.png"],"callback_url":"https://ignored.example.test"}}`)
	if err != nil || done.Status != "succeeded" || !reflect.DeepEqual(done.URLs, []string{"https://cdn.example.test/a.png"}) {
		t.Fatalf("done=%#v err=%v", done, err)
	}
	body, err := json.Marshal(jimengGenerationOutput{SubmitID: done.SubmitID, URLs: done.URLs})
	if err != nil || strings.Contains(string(body), "unsafe") || strings.Contains(string(body), "ignored") {
		t.Fatalf("output=%s err=%v", body, err)
	}
}

func TestDreaminaCommandDiagnosticIsRedactedAndCategorized(t *testing.T) {
	diagnostic := safeDreaminaCommandDiagnostic(
		`{"token":"secret-token","status":"failed"}`,
		`request failed: unauthorized https://example.test/path?access_token=secret-query`,
		errors.New("exit status 1"),
	)
	for _, secret := range []string{"secret-token", "secret-query"} {
		if strings.Contains(diagnostic, secret) {
			t.Fatalf("diagnostic leaked %q: %s", secret, diagnostic)
		}
	}
	if message := dreaminaFailureMessage(dreaminaCommandError{diagnostic: diagnostic}); message != "即梦 CLI 登录已失效" {
		t.Fatalf("message=%q diagnostic=%q", message, diagnostic)
	}
	if message := dreaminaFailureMessage(errors.New("HTTP 429 too many requests")); message != "即梦请求频率受限" {
		t.Fatalf("rate-limit message=%q", message)
	}
	if message := dreaminaFailureMessage(errors.New("connection timeout")); message != "即梦 CLI 网络请求失败" {
		t.Fatalf("network message=%q", message)
	}
	if message := dreaminaFailureMessage(errors.New("当前账号没有 dreamina_cli 使用权限: 仅限高级或高级以上的会员等级")); message != "即梦 CLI 生成权限不足，需要高级或以上会员" {
		t.Fatalf("permission message=%q", message)
	}
}
