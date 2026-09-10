package handler

import (
	"context"
	"github.com/tigerowo/infinite-canvas/config"
	"github.com/tigerowo/infinite-canvas/extensions/taskidentity"
	"github.com/tigerowo/infinite-canvas/model"
	"github.com/tigerowo/infinite-canvas/repository"
	"os"
	"os/exec"
	"testing"
	"time"
)

func TestVideoTaskUsesOwnerCredential(t *testing.T) {
	const marker = "VIDEO_IDENTITY_TEST_CHILD"
	if os.Getenv(marker) != "1" {
		ctx, cancel := context.WithTimeout(context.Background(), 40*time.Second)
		defer cancel()
		cmd := exec.CommandContext(ctx, os.Args[0], "-test.run=^TestVideoTaskUsesOwnerCredential$", "-test.timeout=30s")
		cmd.Env = append(os.Environ(), marker+"=1")
		if output, err := cmd.CombinedOutput(); err != nil {
			t.Fatalf("%v\n%s", err, output)
		}
		return
	}
	config.Cfg = config.Config{StorageDriver: "sqlite", DatabaseDSN: ":memory:", AILogDir: t.TempDir()}
	db, err := repository.DB()
	if err != nil {
		t.Fatal(err)
	}
	sqlDB, _ := db.DB()
	sqlDB.SetMaxOpenConns(1)
	defer sqlDB.Close()
	blockProtocolNetwork(t)
	yes := true
	settings := model.Settings{Public: model.PublicSetting{ModelChannel: model.PublicModelChannelSetting{APIKeyMode: "user", AllowUserRemoteChannel: &yes}}, Private: model.PrivateSetting{Channels: []model.ModelChannel{{ID: "relay", Enabled: true, Weight: 1, Protocol: "newapi", BaseURL: "https://fixture.invalid", APIKey: "admin-fixture", Models: []string{"sora-2"}}}}}
	if _, err = repository.SaveSettings(settings, "fixture"); err != nil {
		t.Fatal(err)
	}
	for _, id := range []string{"a", "b"} {
		if err = db.Create(&model.User{ID: id, Username: id, AffCode: id, Role: model.UserRoleUser, Status: model.UserStatusActive}).Error; err != nil {
			t.Fatal(err)
		}
		if err = db.Save(&model.UserConfig{UserID: id, ModelConfig: `{"remoteChannelKeys":{"relay":"` + id + `-fixture"}}`}).Error; err != nil {
			t.Fatal(err)
		}
		if err = taskidentity.Save(db, "job-"+id, id, "user"); err != nil {
			t.Fatal(err)
		}
		channel, err := selectVideoTaskChannel(model.VideoTask{ID: "job-" + id, UserID: id, Model: "sora-2", ChannelID: "relay"})
		if err != nil || channel.APIKey != id+"-fixture" {
			t.Fatalf("wrong owner credentials for %s: %v", id, err)
		}
	}
	settings.Public.ModelChannel.APIKeyMode = "admin"
	if _, err = repository.SaveSettings(settings, "fixture"); err != nil {
		t.Fatal(err)
	}
	if _, err = selectVideoTaskChannel(model.VideoTask{ID: "job-a", UserID: "a", Model: "sora-2", ChannelID: "relay"}); err == nil {
		t.Fatal("silently changed to administrator key")
	}
	if err = taskidentity.Save(db, "job-a", "a", "admin"); err != nil {
		t.Fatal(err)
	}
	if source, _ := taskidentity.Load(db, "job-a", "a"); source != "user" {
		t.Fatal("original credential source overwritten")
	}
}
