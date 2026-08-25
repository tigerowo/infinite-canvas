package handler

import (
	"bytes"
	"context"
	"strings"
	"testing"
	"time"

	"github.com/tigerowo/infinite-canvas/model"
)

func TestUpstreamResponseBudgetRejectsCumulativeBytes(t *testing.T) {
	budget := newUpstreamResponseBudget(context.Background(), "test", 3, 6, time.Minute)
	defer budget.Close()
	for _, value := range []string{"abc", "def"} {
		if err := budget.NextRequest(); err != nil {
			t.Fatal(err)
		}
		if _, err := budget.ReadAll(strings.NewReader(value), 4); err != nil {
			t.Fatal(err)
		}
	}
	if err := budget.NextRequest(); err != nil {
		t.Fatal(err)
	}
	if _, err := budget.ReadAll(strings.NewReader("x"), 4); err == nil || !strings.Contains(err.Error(), "累计响应体") {
		t.Fatalf("expected cumulative byte error, got %v", err)
	}
}

func TestUpstreamResponseBudgetRejectsRequestCount(t *testing.T) {
	budget := newUpstreamResponseBudget(context.Background(), "test", 1, 10, time.Minute)
	defer budget.Close()
	if err := budget.NextRequest(); err != nil {
		t.Fatal(err)
	}
	if err := budget.NextRequest(); err == nil || !strings.Contains(err.Error(), "总请求数") {
		t.Fatalf("expected request count error, got %v", err)
	}
}

func TestUpstreamResponseBudgetRejectsDeadline(t *testing.T) {
	budget := newUpstreamResponseBudget(context.Background(), "test", 1, 10, time.Nanosecond)
	defer budget.Close()
	time.Sleep(time.Millisecond)
	if err := budget.NextRequest(); err == nil || !strings.Contains(err.Error(), "deadline") {
		t.Fatalf("expected deadline error, got %v", err)
	}
}

func TestReadLimitedUpstreamResponseRejectsOversize(t *testing.T) {
	if _, err := readLimitedUpstreamResponse(strings.NewReader("12345"), "test", 4); err == nil || !strings.Contains(err.Error(), "响应体") {
		t.Fatalf("expected response limit error, got %v", err)
	}
}

func TestCopyLimitedUpstreamResponseStopsAtLimit(t *testing.T) {
	var output bytes.Buffer
	written, exceeded, err := copyLimitedUpstreamResponse(&output, strings.NewReader("12345"), 4)
	if err != nil || !exceeded || written != 4 || output.String() != "1234" {
		t.Fatalf("written=%d exceeded=%v output=%q err=%v", written, exceeded, output.String(), err)
	}
}

func TestLimitedResponseRecorderStopsAtLimit(t *testing.T) {
	recorder := newLimitedResponseRecorder(4)
	written, err := recorder.Write([]byte("12345"))
	if written != 4 || err == nil || !recorder.exceeded || recorder.Body.String() != "1234" {
		t.Fatalf("written=%d exceeded=%v body=%q err=%v", written, recorder.exceeded, recorder.Body.String(), err)
	}
}

func TestVideoTaskPollBudgetError(t *testing.T) {
	current := time.Now()
	tests := []struct {
		name string
		task model.VideoTask
		want string
	}{
		{name: "poll count", task: model.VideoTask{PollCount: videoTaskPollCountLimit, CreatedAt: current.Format(time.RFC3339Nano)}, want: "360 次"},
		{name: "bytes", task: model.VideoTask{ResponseBytes: videoTaskResponseByteLimit, CreatedAt: current.Format(time.RFC3339Nano)}, want: "32 MiB"},
		{name: "deadline", task: model.VideoTask{CreatedAt: current.Add(-videoTaskDeadline).Format(time.RFC3339Nano)}, want: "30 分钟"},
		{name: "invalid timestamp", task: model.VideoTask{CreatedAt: "invalid"}, want: "创建时间无效"},
	}
	for _, test := range tests {
		t.Run(test.name, func(t *testing.T) {
			if got := videoTaskPollBudgetError(test.task, current); !strings.Contains(got, test.want) {
				t.Fatalf("got %q, want substring %q", got, test.want)
			}
		})
	}
	if got := videoTaskPollBudgetError(model.VideoTask{CreatedAt: current.Format(time.RFC3339Nano)}, current); got != "" {
		t.Fatalf("unexpected budget error: %s", got)
	}
}
