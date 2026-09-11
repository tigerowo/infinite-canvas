package mediaarchive

import (
	"bufio"
	"errors"
	"io"
	"net/http"
	"strings"
)

func readMediaBody(response *http.Response) ([]byte, string, error) {
	reader := bufio.NewReader(response.Body)
	mime := strings.ToLower(strings.TrimSpace(strings.Split(response.Header.Get("Content-Type"), ";")[0]))
	if mime == "" || mime == "application/octet-stream" {
		prefix, _ := reader.Peek(512)
		mime = http.DetectContentType(prefix)
	}
	audio := strings.HasPrefix(mime, "audio/")
	if !audio && !strings.HasPrefix(mime, "image/") && !strings.HasPrefix(mime, "video/") {
		return nil, "", errors.New("来源不是图片、视频或音频文件")
	}
	var body io.Reader = reader
	if !audio {
		if response.ContentLength > maxMediaBytes {
			return nil, "", errors.New("媒体文件超过 256 MiB 限制")
		}
		body = io.LimitReader(reader, maxMediaBytes+1)
	}
	data, err := io.ReadAll(body)
	if err != nil || len(data) == 0 || (!audio && len(data) > maxMediaBytes) {
		return nil, "", errors.New("媒体文件为空、过大或下载中断")
	}
	return data, mime, nil
}
