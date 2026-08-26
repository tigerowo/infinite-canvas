package router

import (
	"net/http"

	"github.com/gin-gonic/gin"
	"github.com/tigerowo/infinite-canvas/handler"
	"github.com/tigerowo/infinite-canvas/middleware"
)

func New() *gin.Engine {
	router := gin.Default()
	router.RedirectTrailingSlash = false
	_ = router.SetTrustedProxies(nil)
	api := router.Group("/api", middleware.APIRequestBodyBudget)
	api.GET("/health", func(c *gin.Context) {
		c.String(http.StatusOK, "ok")
	})
	api.POST("/auth/register", middleware.AuthRequestBudget, gin.WrapF(handler.Register))
	api.POST("/auth/login", middleware.AuthRequestBudget, gin.WrapF(handler.Login))
	api.POST("/auth/exchange", middleware.AuthRequestBudget, gin.WrapF(handler.ExchangeLogin))
	api.GET("/auth/linux-do/authorize", middleware.AuthRequestBudget, gin.WrapF(handler.LinuxDoAuthorize))
	api.GET("/auth/linux-do/callback", middleware.AuthRequestBudget, gin.WrapF(handler.LinuxDoCallback))
	api.GET("/auth/me", middleware.OptionalAuth, gin.WrapF(handler.CurrentUser))
	api.GET("/settings", gin.WrapF(handler.Settings))
	api.GET("/storage/config", gin.WrapF(handler.StorageConfig))
	api.GET("/media/references/:id", middleware.DownloadRequestBudget, func(c *gin.Context) {
		handler.ReferenceMedia(c.Writer, c.Request, c.Param("id"))
	})
	api.HEAD("/media/references/:id", middleware.DownloadRequestBudget, func(c *gin.Context) {
		handler.ReferenceMedia(c.Writer, c.Request, c.Param("id"))
	})
	api.GET("/files/:id", middleware.DownloadRequestBudget, func(c *gin.Context) {
		handler.FileInfo(c.Writer, c.Request, c.Param("id"))
	})
	api.GET("/files/:id/content", middleware.DownloadRequestBudget, func(c *gin.Context) {
		handler.FileContent(c.Writer, c.Request, c.Param("id"))
	})
	api.POST("/ai/direct-request", middleware.GenerationRequestBudget, gin.WrapF(handler.PrepareDirectAIRequest))
	anonymousFiles := api.Group("/anonymous/files", middleware.AnonymousStorage)
	anonymousFiles.POST("/session", func(c *gin.Context) { c.Status(http.StatusNoContent) })
	anonymousFiles.POST("", middleware.UploadRequestBudget, gin.WrapF(handler.UploadFile))
	anonymousFiles.DELETE("/:id", func(c *gin.Context) {
		handler.DeleteFile(c.Writer, c.Request, c.Param("id"))
	})
	v1 := api.Group("/v1", middleware.UserAuth)
	v1.POST("/images/generations", middleware.GenerationRequestBudget, gin.WrapF(handler.AIImagesGenerations))
	v1.POST("/images/edits", middleware.GenerationRequestBudget, gin.WrapF(handler.AIImagesEdits))
	v1.POST("/responses", middleware.GenerationRequestBudget, gin.WrapF(handler.AIResponses))
	v1.POST("/chat/completions", middleware.GenerationRequestBudget, gin.WrapF(handler.AIChatCompletions))
	v1.POST("/audio/speech", middleware.GenerationRequestBudget, gin.WrapF(handler.AIAudioSpeech))
	v1.GET("/tts/voices", middleware.GenerationRequestBudget, gin.WrapF(handler.AITTSVoices))
	v1.POST("/canvas/tasks/delete", gin.WrapF(handler.DeleteUserCanvasTasks))
	v1.POST("/canvas/image-tasks", middleware.GenerationRequestBudget, gin.WrapF(handler.CreateCanvasImageTask))
	v1.GET("/canvas/image-tasks", gin.WrapF(handler.UserCanvasImageTasks))
	v1.POST("/canvas/image-tasks/status", gin.WrapF(handler.BatchCanvasImageTasks))
	v1.GET("/canvas/image-tasks/:id", func(c *gin.Context) {
		handler.GetCanvasImageTask(c.Writer, c.Request, c.Param("id"))
	})
	v1.POST("/canvas/image-tasks/:id/cancel", func(c *gin.Context) {
		handler.CancelUserCanvasImageTask(c.Writer, c.Request, c.Param("id"))
	})
	v1.DELETE("/canvas/image-tasks/:id", func(c *gin.Context) {
		handler.DeleteUserCanvasImageTask(c.Writer, c.Request, c.Param("id"))
	})
	v1.POST("/canvas/audio-tasks", middleware.GenerationRequestBudget, gin.WrapF(handler.CreateCanvasAudioTask))
	v1.GET("/canvas/audio-tasks/:id", func(c *gin.Context) {
		handler.GetCanvasAudioTask(c.Writer, c.Request, c.Param("id"))
	})
	v1.POST("/canvas/audio-tasks/:id/cancel", func(c *gin.Context) {
		handler.CancelUserCanvasAudioTask(c.Writer, c.Request, c.Param("id"))
	})
	v1.POST("/ai-logs", gin.WrapF(handler.ClientAICallLog))
	v1.POST("/videos", middleware.GenerationRequestBudget, gin.WrapF(handler.AIVideos))
	v1.GET("/video-tasks", gin.WrapF(handler.UserVideoTasks))
	v1.POST("/video-tasks/:id/cancel", func(c *gin.Context) {
		handler.CancelUserVideoTask(c.Writer, c.Request, c.Param("id"))
	})
	v1.DELETE("/video-tasks/:id", func(c *gin.Context) {
		handler.DeleteUserVideoTask(c.Writer, c.Request, c.Param("id"))
	})
	v1.POST("/media/references", middleware.UploadRequestBudget, gin.WrapF(handler.UploadReferenceMedia))
	v1.GET("/videos/:id", func(c *gin.Context) {
		handler.AIVideo(c.Writer, c.Request, c.Param("id"))
	})
	v1.GET("/videos/:id/content", middleware.DownloadRequestBudget, func(c *gin.Context) {
		handler.AIVideoContent(c.Writer, c.Request, c.Param("id"))
	})
	v1.GET("/workflows", gin.WrapF(handler.UserWorkflows))
	v1.POST("/workflows", gin.WrapF(handler.SaveUserWorkflow))
	v1.POST("/workflows/agent-draft", middleware.GenerationRequestBudget, gin.WrapF(handler.DraftUserWorkflow))
	v1.DELETE("/workflows/:id", func(c *gin.Context) {
		handler.DeleteUserWorkflow(c.Writer, c.Request, c.Param("id"))
	})
	v1.POST("/storage/measure", middleware.HeavyRequestBudget, gin.WrapF(handler.MeasureUserStorageProvider))
	v1.POST("/files", middleware.UploadRequestBudget, gin.WrapF(handler.UploadFile))
	v1.POST("/files/direct", gin.WrapF(handler.RegisterDirectFile))
	v1.DELETE("/files/:id", func(c *gin.Context) {
		handler.DeleteFile(c.Writer, c.Request, c.Param("id"))
	})
	v1.DELETE("/files/:id/record", func(c *gin.Context) {
		handler.DeleteDirectFileRecord(c.Writer, c.Request, c.Param("id"))
	})
	v1.GET("/user-config", gin.WrapF(handler.UserConfig))
	v1.GET("/providers", gin.WrapF(handler.UserProviders))
	v1.GET("/providers/migration-preview", gin.WrapF(handler.UserProviderMigrationPreview))
	v1.POST("/providers", gin.WrapF(handler.SaveUserProvider))
	v1.POST("/providers/migrate", gin.WrapF(handler.MigrateUserProviders))
	v1.POST("/providers/:id/default", func(c *gin.Context) {
		handler.SetDefaultUserProvider(c.Writer, c.Request, c.Param("id"))
	})
	v1.POST("/providers/:id/test", middleware.HeavyRequestBudget, func(c *gin.Context) {
		handler.TestUserProvider(c.Writer, c.Request, c.Param("id"))
	})
	v1.POST("/providers/:id/runninghub/tasks", middleware.GenerationRequestBudget, func(c *gin.Context) {
		handler.SubmitRunningHubTask(c.Writer, c.Request, c.Param("id"))
	})
	v1.GET("/providers/:id/runninghub/tasks/:taskId", middleware.GenerationRequestBudget, func(c *gin.Context) {
		handler.QueryRunningHubTask(c.Writer, c.Request, c.Param("id"), c.Param("taskId"))
	})
	v1.POST("/providers/:id/runninghub/tasks/:taskId/cancel", middleware.GenerationRequestBudget, func(c *gin.Context) {
		handler.CancelRunningHubTask(c.Writer, c.Request, c.Param("id"), c.Param("taskId"))
	})
	v1.POST("/providers/:id/cli/detect", middleware.HeavyRequestBudget, func(c *gin.Context) {
		handler.DetectUserCLIProvider(c.Writer, c.Request, c.Param("id"))
	})
	v1.POST("/providers/:id/cli/auth-status", middleware.HeavyRequestBudget, func(c *gin.Context) {
		handler.CheckUserCLIProviderAuth(c.Writer, c.Request, c.Param("id"))
	})
	v1.POST("/providers/:id/cli/login", middleware.HeavyRequestBudget, func(c *gin.Context) {
		handler.StartUserCLIProviderLogin(c.Writer, c.Request, c.Param("id"))
	})
	v1.DELETE("/providers/:id", func(c *gin.Context) {
		handler.DeleteUserProvider(c.Writer, c.Request, c.Param("id"))
	})
	v1.POST("/user-config/model", gin.WrapF(handler.SaveUserModelConfig))
	v1.POST("/user-config/storage", gin.WrapF(handler.SaveUserStorageProvider))
	v1.GET("/canvas/projects", gin.WrapF(handler.UserCanvasProjects))
	v1.POST("/canvas/projects", gin.WrapF(handler.SaveUserCanvasProject))
	v1.POST("/canvas/projects/sync", gin.WrapF(handler.SyncUserCanvasProjects))
	v1.POST("/canvas/projects/delete", gin.WrapF(handler.DeleteUserCanvasProjects))
	v1.GET("/user-data/image-history", gin.WrapF(handler.UserImageHistory))
	v1.POST("/user-data/image-history", gin.WrapF(handler.SaveUserImageHistory))
	v1.GET("/generation-logs/videos", gin.WrapF(handler.UserVideoGenerationLogs))
	v1.POST("/generation-logs/videos", gin.WrapF(handler.SaveUserVideoGenerationLogs))
	v1.POST("/generation-logs/videos/delete", gin.WrapF(handler.DeleteUserVideoGenerationLogs))
	v1.DELETE("/generation-logs/videos/:id", func(c *gin.Context) {
		handler.DeleteUserVideoGenerationLog(c.Writer, c.Request, c.Param("id"))
	})
	v1.GET("/generation-logs/images", gin.WrapF(handler.UserImageGenerationLogs))
	v1.POST("/generation-logs/images", gin.WrapF(handler.SaveUserImageGenerationLogs))
	v1.POST("/generation-logs/images/delete", gin.WrapF(handler.DeleteUserImageGenerationLogs))
	v1.DELETE("/generation-logs/images/:id", func(c *gin.Context) {
		handler.DeleteUserImageGenerationLog(c.Writer, c.Request, c.Param("id"))
	})
	v1.GET("/user-data/assets", gin.WrapF(handler.UserAssetData))
	v1.POST("/user-data/assets", gin.WrapF(handler.SaveUserAssetData))
	api.GET("/proxy-image", middleware.ProxyRequestBudget, gin.WrapF(handler.ProxyImage))
	api.GET("/prompts", middleware.OptionalAuth, gin.WrapF(handler.Prompts))
	api.GET("/assets", middleware.OptionalAuth, gin.WrapF(handler.Assets))
	api.POST("/admin/login", middleware.AuthRequestBudget, gin.WrapF(handler.AdminLogin))

	admin := api.Group("/admin", middleware.AdminAuth)
	admin.GET("/users", gin.WrapF(handler.AdminUsers))
	admin.POST("/users", gin.WrapF(handler.AdminSaveUser))
	admin.POST("/users/:id/credits", func(c *gin.Context) {
		handler.AdminAdjustUserCredits(c.Writer, c.Request, c.Param("id"))
	})
	admin.DELETE("/users/:id", func(c *gin.Context) {
		handler.AdminDeleteUser(c.Writer, c.Request, c.Param("id"))
	})
	admin.GET("/credit-logs", gin.WrapF(handler.AdminCreditLogs))
	admin.POST("/credit-logs", gin.WrapF(handler.AdminSaveCreditLog))
	admin.DELETE("/credit-logs/:id", func(c *gin.Context) {
		handler.AdminDeleteCreditLog(c.Writer, c.Request, c.Param("id"))
	})
	admin.GET("/ai-logs", gin.WrapF(handler.AdminAICallLogs))
	admin.DELETE("/ai-logs", gin.WrapF(handler.AdminDeleteAICallLogs))
	admin.GET("/settings", gin.WrapF(handler.AdminSettings))
	admin.POST("/settings", gin.WrapF(handler.AdminSaveSettings))
	admin.POST("/settings/channel-models", middleware.HeavyRequestBudget, gin.WrapF(handler.AdminChannelModels))
	admin.POST("/settings/channel-test", middleware.HeavyRequestBudget, gin.WrapF(handler.AdminTestChannelModel))
	admin.POST("/storage/measure", middleware.HeavyRequestBudget, gin.WrapF(handler.AdminMeasureStorageProvider))
	admin.GET("/prompt-categories", gin.WrapF(handler.AdminPromptCategories))
	admin.POST("/prompt-categories/sync", middleware.HeavyRequestBudget, gin.WrapF(handler.AdminSyncPromptCategories))
	admin.POST("/prompt-categories/sync-all", middleware.HeavyRequestBudget, gin.WrapF(handler.AdminSyncAllPromptCategories))
	admin.GET("/prompts", gin.WrapF(handler.AdminPrompts))
	admin.POST("/prompts", gin.WrapF(handler.AdminSavePrompt))
	admin.POST("/prompts/batch-delete", gin.WrapF(handler.AdminDeletePrompts))
	admin.DELETE("/prompts/:id", func(c *gin.Context) {
		handler.AdminDeletePrompt(c.Writer, c.Request, c.Param("id"))
	})
	admin.GET("/assets", gin.WrapF(handler.AdminAssets))
	admin.POST("/assets", gin.WrapF(handler.AdminSaveAsset))
	admin.DELETE("/assets/:id", func(c *gin.Context) {
		handler.AdminDeleteAsset(c.Writer, c.Request, c.Param("id"))
	})

	router.NoRoute(middleware.NotFoundJSON)

	return router
}
