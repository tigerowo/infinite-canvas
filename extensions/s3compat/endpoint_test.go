package s3compat

import "testing"

func TestQiniuAddressing(t *testing.T) {
	for _, item := range []struct{ endpoint, want string }{
		{"https://wxsh6.s3.cn-east-1.qiniucs.com", "https://wxsh6.s3.cn-east-1.qiniucs.com/canvas/a%20%2B.mp4"},
		{"https://s3.cn-east-1.qiniucs.com", "https://s3.cn-east-1.qiniucs.com/wxsh6/canvas/a%20%2B.mp4"},
	} {
		got, err := ObjectURL(item.endpoint, "wxsh6", "canvas/a +.mp4")
		if err != nil || got.String() != item.want {
			t.Fatalf("wrong Qiniu address: %v, %v", got, err)
		}
	}
}
