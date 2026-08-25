package handler

import (
	"encoding/json"
	"net"
	"net/http"
	"net/url"
	"strings"

	"github.com/tigerowo/infinite-canvas/service"
)

const runningHubRequestBodyLimit = int64(2 * 1024 * 1024)

func SubmitRunningHubTask(w http.ResponseWriter, r *http.Request, providerID string) {
	var input service.RunningHubSubmitInput
	r.Body = http.MaxBytesReader(w, r.Body, runningHubRequestBodyLimit)
	decoder := json.NewDecoder(r.Body)
	decoder.UseNumber()
	if err := decoder.Decode(&input); err != nil {
		Fail(w, "RunningHub 参数格式错误或内容过大")
		return
	}
	result, err := service.SubmitCurrentUserRunningHubTask(r.Context(), providerID, input)
	if err != nil {
		FailError(w, err)
		return
	}
	OK(w, result)
}

func QueryRunningHubTask(w http.ResponseWriter, r *http.Request, providerID string, taskID string) {
	result, err := service.QueryCurrentUserRunningHubTask(r.Context(), providerID, taskID)
	if err != nil {
		FailError(w, err)
		return
	}
	OK(w, result)
}

func CancelRunningHubTask(w http.ResponseWriter, r *http.Request, providerID string, taskID string) {
	result, err := service.CancelCurrentUserRunningHubTask(r.Context(), providerID, taskID)
	if err != nil {
		FailError(w, err)
		return
	}
	OK(w, result)
}

func DetectUserCLIProvider(w http.ResponseWriter, r *http.Request, providerID string) {
	if !isLoopbackWebRequest(r) {
		Fail(w, "CLI helper 只接受本机回环请求")
		return
	}
	result, err := service.DetectCurrentUserCLIProvider(r.Context(), providerID)
	if err != nil {
		FailError(w, err)
		return
	}
	OK(w, result)
}

func CheckUserCLIProviderAuth(w http.ResponseWriter, r *http.Request, providerID string) {
	if !isLoopbackWebRequest(r) {
		Fail(w, "CLI helper 只接受本机回环请求")
		return
	}
	result, err := service.CheckCurrentUserCLIProviderAuth(r.Context(), providerID)
	if err != nil {
		FailError(w, err)
		return
	}
	OK(w, result)
}

func isLoopbackWebRequest(r *http.Request) bool {
	remoteHost, _, err := net.SplitHostPort(strings.TrimSpace(r.RemoteAddr))
	if err != nil {
		remoteHost = strings.Trim(strings.TrimSpace(r.RemoteAddr), "[]")
	}
	if !isLoopbackHostname(remoteHost) {
		return false
	}
	for _, value := range []string{r.Host, r.Header.Get("X-Forwarded-Host"), r.Header.Get("Origin")} {
		value = strings.TrimSpace(value)
		if value == "" {
			continue
		}
		if parsed, parseErr := url.Parse(value); parseErr == nil && parsed.Hostname() != "" {
			value = parsed.Hostname()
		} else if host, _, splitErr := net.SplitHostPort(value); splitErr == nil {
			value = host
		}
		if !isLoopbackHostname(strings.Trim(value, "[]")) {
			return false
		}
	}
	if forwarded := strings.TrimSpace(r.Header.Get("X-Forwarded-For")); forwarded != "" {
		for _, item := range strings.Split(forwarded, ",") {
			if !isLoopbackHostname(strings.Trim(strings.TrimSpace(item), "[]")) {
				return false
			}
		}
	}
	return true
}

func isLoopbackHostname(host string) bool {
	host = strings.ToLower(strings.TrimSpace(host))
	if host == "localhost" {
		return true
	}
	ip := net.ParseIP(strings.Trim(host, "[]"))
	return ip != nil && ip.IsLoopback()
}
