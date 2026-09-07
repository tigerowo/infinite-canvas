package service

import (
	"encoding/hex"
	"net/http"
	"net/url"
	"strings"
	"testing"

	"github.com/tigerowo/infinite-canvas/model"
)

func TestS3AddressingAndSignature(t *testing.T) {
	for _, tc := range []struct {
		name, endpoint, key, host, path string
	}{
		{"tos", "https://tos-s3-cn-shanghai.volces.com", "canvas/image.png", "media.tos-s3-cn-shanghai.volces.com", "/canvas/image.png"},
		{"tos bucket endpoint", "https://media.tos-s3-cn-shanghai.volces.com", "canvas/image.png", "media.tos-s3-cn-shanghai.volces.com", "/canvas/image.png"},
		{"tos list", "https://tos-s3-cn-shanghai.volces.com", "", "media.tos-s3-cn-shanghai.volces.com", "/"},
		{"r2", "https://account.r2.cloudflarestorage.com", "canvas/image.png", "account.r2.cloudflarestorage.com", "/media/canvas/image.png"},
		{"minio", "http://localhost:9000", "canvas/image.png", "localhost:9000", "/media/canvas/image.png"},
		{"prefix", "https://storage.example.com/s3", "canvas/image.png", "storage.example.com", "/s3/media/canvas/image.png"},
		{"escaped key", "https://tos-s3-cn-shanghai.volces.com", "folder/a +%?#.png", "media.tos-s3-cn-shanghai.volces.com", "/folder/a%20%2B%25%3F%23.png"},
		{"unrelated host", "https://tos-s3-cn-shanghai.volces.com.example.org", "image.png", "tos-s3-cn-shanghai.volces.com.example.org", "/media/image.png"},
	} {
		t.Run(tc.name, func(t *testing.T) {
			provider := model.StorageProvider{Endpoint: tc.endpoint, Bucket: "media", Region: "cn-shanghai", AccessKeyID: "test-key", SecretAccessKey: "test-secret"}
			for _, method := range []string{http.MethodPut, http.MethodGet, http.MethodDelete} {
				query := url.Values{"list-type": {"2"}, "continuation-token": {"a+/="}}
				request, err := newS3RequestWithQuery(method, provider, tc.key, query, nil, 0)
				if err != nil {
					t.Fatal(err)
				}
				if request.URL.Host != tc.host || request.URL.EscapedPath() != tc.path {
					t.Fatalf("got %s%s, want %s%s", request.URL.Host, request.URL.EscapedPath(), tc.host, tc.path)
				}
				if request.URL.RawQuery != query.Encode() {
					t.Fatal("query was changed")
				}
				date := request.Header.Get("X-Amz-Date")
				scope := date[:8] + "/cn-shanghai/s3/aws4_request"
				canonical := method + "\n" + tc.path + "\n" + query.Encode() + "\nhost:" + tc.host + "\nx-amz-content-sha256:UNSIGNED-PAYLOAD\nx-amz-date:" + date + "\n\nhost;x-amz-content-sha256;x-amz-date\nUNSIGNED-PAYLOAD"
				toSign := "AWS4-HMAC-SHA256\n" + date + "\n" + scope + "\n" + sha256Hex([]byte(canonical))
				expected := hex.EncodeToString(hmacSHA256(signingKey(provider.SecretAccessKey, date[:8], provider.Region), []byte(toSign)))
				if !strings.HasSuffix(request.Header.Get("Authorization"), "Signature="+expected) {
					t.Fatal("signature does not match the transmitted host and path")
				}
			}
		})
	}
}
