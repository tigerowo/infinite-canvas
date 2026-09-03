package service

import (
	"context"
	"strings"
	"testing"
)

func TestReserveGenerationTaskSlotIncludesReservations(t *testing.T) {
	previousCounter := countActiveGenerationTasks
	countActiveGenerationTasks = func(context.Context, string) (int64, error) { return 7, nil }
	generationReservationMu.Lock()
	generationReservations = map[string]int{}
	generationReservationMu.Unlock()
	t.Cleanup(func() {
		countActiveGenerationTasks = previousCounter
		generationReservationMu.Lock()
		generationReservations = map[string]int{}
		generationReservationMu.Unlock()
	})

	release, err := ReserveGenerationTaskSlot(context.Background(), "user-1")
	if err != nil {
		t.Fatal(err)
	}
	if _, err := ReserveGenerationTaskSlot(context.Background(), "user-1"); err == nil || !strings.Contains(err.Error(), "8 个") {
		t.Fatalf("expected active task limit, got %v", err)
	}
	release()
	secondRelease, err := ReserveGenerationTaskSlot(context.Background(), "user-1")
	if err != nil {
		t.Fatalf("reserve after release: %v", err)
	}
	secondRelease()
}
