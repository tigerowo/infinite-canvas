package main

import (
	"context"
	"log"

	"github.com/tigerowo/infinite-canvas/config"
	"github.com/tigerowo/infinite-canvas/handler"
	"github.com/tigerowo/infinite-canvas/router"
	"github.com/tigerowo/infinite-canvas/service"
)

func main() {
	if err := config.Load(); err != nil {
		log.Fatal(err)
	}
	if err := service.EnsureDefaultAdmin(); err != nil {
		log.Fatal(err)
	}
	if err := service.EnsureDefaultAgentSkills(); err != nil {
		log.Fatal(err)
	}
	service.StartPromptSyncScheduler()
	service.StartCanvasProjectCleanupScheduler()
	handler.StartVideoTaskPoller()
	service.WakeComfyBridgePoller()
	go func() {
		if _, err := service.PrepareCanvasVideoFFmpeg(context.Background()); err != nil {
			log.Printf("准备视频分析 FFmpeg 失败: %v", err)
		}
	}()
	log.Fatal(router.New().Run(":" + config.Cfg.Port))
}
