package newapi

import "strings"

const Protocol = "newapi"

func IsProtocol(protocol string) bool {
	return strings.EqualFold(strings.TrimSpace(protocol), Protocol)
}
