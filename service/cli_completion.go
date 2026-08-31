package service

import (
	"context"
	"strings"

	"github.com/tigerowo/infinite-canvas/config"
	"github.com/tigerowo/infinite-canvas/model"
)

type CLICompletionInput struct {
	Model  string `json:"model"`
	Prompt string `json:"prompt"`
}

func StartCurrentUserCLICompletion(ctx context.Context, providerID string, input CLICompletionInput) (CLIHelperResult, error) {
	_, item, err := currentUserProvider(ctx, providerID)
	if err != nil {
		return CLIHelperResult{}, err
	}
	input.Model = strings.TrimSpace(input.Model)
	input.Prompt = strings.TrimSpace(input.Prompt)
	if item.Kind != model.ProviderKindCLI || item.Protocol != "codex" && item.Protocol != "gemini-cli" || !item.Enabled || item.ConnectionStatus != model.ProviderStatusConnected {
		return CLIHelperResult{}, safeMessageError{message: "受控 CLI 渠道不可用"}
	}
	if !cliModelNamePattern.MatchString(input.Model) || item.Protocol == "codex" && input.Model != cliCodexDefaultModel || item.Protocol == "gemini-cli" && (input.Model == cliAntigravityImageModel || !userLocalChannelHasModel(item.Models, input.Model)) {
		return CLIHelperResult{}, safeMessageError{message: "受控 CLI 模型不可用"}
	}
	if input.Prompt == "" || len(input.Prompt) > cliCompletionPromptLimit || strings.ContainsRune(input.Prompt, '\x00') {
		return CLIHelperResult{}, safeMessageError{message: "画布助手请求为空或内容过大"}
	}
	if !config.Cfg.CLIHelperEnabled {
		return CLIHelperResult{}, safeMessageError{message: "Mac CLI helper 未启用"}
	}
	result, _, err := requestCLICompanionInput(ctx, cliCompanionActionRequest{
		Action: cliCompanionActionCompletionStart, UserID: item.OwnerUserID, ProviderID: item.ID,
		Protocol: item.Protocol, Model: input.Model, Prompt: input.Prompt,
	})
	if err != nil {
		return CLIHelperResult{Protocol: item.Protocol, Message: "CLI 伴随进程未连接或授权失败"}, nil
	}
	return result, nil
}
