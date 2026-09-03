package service

import "regexp"

var (
	bearerSecretPattern   = regexp.MustCompile(`(?i)\bbearer\s+[^\s,"';&}]+`)
	assignedSecretPattern = regexp.MustCompile(`(?i)((?:authorization|proxy-authorization|api[-_]?key|x-goog-api-key|access[-_]?token|refresh[-_]?token|token|secret)["']?\s*[:=]\s*["']?)([^"'\s,&;}\]]+)`)
	querySecretPattern    = regexp.MustCompile(`(?i)([?&](?:key|api_key|api-key|token|access_token|secret)=)[^&#\s]+`)
	providerSecretPattern = regexp.MustCompile(`\b(?:sk-[A-Za-z0-9_-]{8,}|AIza[A-Za-z0-9_-]{8,})\b`)
)

func RedactSensitiveText(value string) string {
	value = bearerSecretPattern.ReplaceAllString(value, "Bearer [redacted]")
	value = assignedSecretPattern.ReplaceAllString(value, "${1}[redacted]")
	value = querySecretPattern.ReplaceAllString(value, "${1}[redacted]")
	return providerSecretPattern.ReplaceAllString(value, "[redacted]")
}
