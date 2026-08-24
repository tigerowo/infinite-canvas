package service

import (
	"testing"
	"time"

	"github.com/tigerowo/infinite-canvas/config"
	"github.com/tigerowo/infinite-canvas/model"
)

func TestSafeRedirectPath(t *testing.T) {
	cases := map[string]string{
		"/":                   "/",
		"/canvas/abc":         "/canvas/abc",
		"/login?redirect=/x":  "/login?redirect=/x",
		"":                    "/",
		"//evil.com":          "/",
		"/\\evil.com":         "/",
		"https://evil.com":    "/",
		"http://evil.com":     "/",
		"javascript:alert(1)": "/",
		"evil.com":            "/",
		"/\t/evil.com":        "/", // browsers strip the tab → //evil.com
		"/normal\tpath":       "/normalpath",
	}
	for in, want := range cases {
		if got := safeRedirectPath(in); got != want {
			t.Errorf("safeRedirectPath(%q) = %q, want %q", in, got, want)
		}
	}
}

func TestDecodeStateRejectsOpenRedirect(t *testing.T) {
	previous := config.Cfg.JWTSecret
	config.Cfg.JWTSecret = "oauth-state-test-secret"
	t.Cleanup(func() { config.Cfg.JWTSecret = previous })
	for _, in := range []string{"//evil.com", "/\\evil.com", "https://evil.com"} {
		state, err := newOAuthState(in)
		if err != nil {
			t.Fatal(err)
		}
		if got, err := decodeState(state); err != nil || got != "/" {
			t.Errorf("decodeState(state(%q)) = %q, want \"/\"", in, got)
		}
	}
	state, err := newOAuthState("/canvas/1")
	if err != nil {
		t.Fatal(err)
	}
	if got, err := decodeState(state); err != nil || got != "/canvas/1" {
		t.Errorf("decodeState(state(/canvas/1)) = %q, want /canvas/1", got)
	}
	if _, err := decodeState(state + "tampered"); err == nil {
		t.Fatal("篡改后的 OAuth state 应被拒绝")
	}
}

func TestLoginExchangeIsOneTime(t *testing.T) {
	session := model.AuthSession{Token: "token", User: model.AuthUser{ID: "user-1"}}
	code, err := CreateLoginExchange(session)
	if err != nil {
		t.Fatal(err)
	}
	got, err := ConsumeLoginExchange(code)
	if err != nil || got.Token != session.Token {
		t.Fatalf("ConsumeLoginExchange() = %#v, %v", got, err)
	}
	if _, err := ConsumeLoginExchange(code); err == nil {
		t.Fatal("登录交换码只能使用一次")
	}
	loginExchanges.Store("expired", loginExchange{Session: session, ExpiresAt: time.Now().Add(-time.Second)})
	if _, err := ConsumeLoginExchange("expired"); err == nil {
		t.Fatal("过期登录交换码应被拒绝")
	}
}
