package s3compat

import (
	"net/url"
	"strings"
)

// ObjectURL uses virtual-host addressing for TOS and preserves path addressing elsewhere.
func ObjectURL(rawEndpoint, bucket, objectKey string) (*url.URL, error) {
	endpoint, err := url.Parse(strings.TrimRight(rawEndpoint, "/"))
	if err != nil {
		return nil, err
	}
	host := strings.ToLower(endpoint.Hostname())
	serviceHost := strings.TrimPrefix(host, strings.ToLower(bucket)+".")
	isTOS := strings.HasPrefix(serviceHost, "tos-s3-") && strings.HasSuffix(serviceHost, ".volces.com") && !strings.Contains(strings.TrimSuffix(serviceHost, ".volces.com"), ".")
	objectPath := strings.TrimLeft(objectKey, "/")
	if isTOS {
		if host == serviceHost {
			endpoint.Host = bucket + "." + endpoint.Host
		}
	} else {
		objectPath = bucket + "/" + objectPath
	}
	endpoint.Path = strings.TrimRight(endpoint.Path, "/") + "/" + objectPath
	// AWS URI encoding retains slashes but encodes spaces and literal plus signs.
	endpoint.RawPath = strings.ReplaceAll(strings.ReplaceAll(url.QueryEscape(endpoint.Path), "+", "%20"), "%2F", "/")
	return endpoint, nil
}
