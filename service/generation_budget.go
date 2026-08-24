package service

import (
	"context"
	"strings"
	"sync"

	"github.com/tigerowo/infinite-canvas/repository"
)

const maxActiveGenerationTasksPerUser = 8

var (
	generationReservationMu    sync.Mutex
	generationReservations     = map[string]int{}
	countActiveGenerationTasks = repository.CountActiveGenerationTasks
)

func ReserveGenerationTaskSlot(ctx context.Context, userID string) (func(), error) {
	userID = strings.TrimSpace(userID)
	if userID == "" {
		return nil, safeMessageError{message: "请先登录"}
	}
	generationReservationMu.Lock()
	defer generationReservationMu.Unlock()
	active, err := countActiveGenerationTasks(ctx, userID)
	if err != nil {
		return nil, err
	}
	if active+int64(generationReservations[userID]) >= maxActiveGenerationTasksPerUser {
		return nil, safeMessageError{message: "当前运行中的生成任务已达到 8 个，请等待任务完成后重试"}
	}
	generationReservations[userID]++
	var once sync.Once
	return func() {
		once.Do(func() {
			generationReservationMu.Lock()
			generationReservations[userID]--
			if generationReservations[userID] <= 0 {
				delete(generationReservations, userID)
			}
			generationReservationMu.Unlock()
		})
	}, nil
}
