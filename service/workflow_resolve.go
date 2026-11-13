package service

import (
	"encoding/json"
	"errors"
	"slices"
	"strings"

	"github.com/tigerowo/infinite-canvas/model"
	"github.com/tigerowo/infinite-canvas/repository"
)

type ResolvedWorkflow struct {
	Channel    model.ModelChannel
	Entry      model.WorkflowEntry
	OwnerScope string
	OwnerID    string
}

func ResolveWorkflowForUser(user model.AuthUser, ref WorkflowRef) (ResolvedWorkflow, error) {
	return resolveWorkflowForUser(user, ref, true)
}

func resolveWorkflowForUser(user model.AuthUser, ref WorkflowRef, requireEntry bool) (ResolvedWorkflow, error) {
	if strings.TrimSpace(ref.ChannelID) == "" || strings.TrimSpace(ref.WorkflowID) == "" {
		return ResolvedWorkflow{}, errors.New("请选择有效工作流")
	}
	var channels []model.ModelChannel
	var personalWorkflows []struct {
		ChannelID string                `json:"channelId"`
		Protocol  string                `json:"protocol"`
		Workflows []model.WorkflowEntry `json:"workflows"`
	}
	ownerScope, ownerID := ref.Scope, user.ID
	switch ref.Scope {
	case "system":
		if requireEntry && !UserCanUseRemoteModelChannel(user) {
			return ResolvedWorkflow{}, errors.New("无权使用系统工作流渠道")
		}
		settings, err := repository.GetSettings()
		if err != nil {
			return ResolvedWorkflow{}, err
		}
		if requireEntry && user.Role != model.UserRoleAdmin && len(settings.Public.ModelChannel.AvailableWorkflows) > 0 && !slices.Contains(settings.Public.ModelChannel.AvailableWorkflows, workflowBillingName(ref)) {
			return ResolvedWorkflow{}, errors.New("这条工作流未公开")
		}
		channels = settings.Private.Channels
		ownerID = "system"
	case "personal":
		stored, exists, err := repository.GetUserConfig(user.ID)
		if err != nil {
			return ResolvedWorkflow{}, err
		}
		if !exists {
			return ResolvedWorkflow{}, errors.New("个人工作流配置未保存到账号")
		}
		var config struct {
			LocalChannels    []model.ModelChannel `json:"localChannels"`
			WorkflowChannels []struct {
				ChannelID string                `json:"channelId"`
				Protocol  string                `json:"protocol"`
				Workflows []model.WorkflowEntry `json:"workflows"`
			} `json:"workflowChannels"`
		}
		if err := json.Unmarshal([]byte(stored.ModelConfig), &config); err != nil {
			return ResolvedWorkflow{}, errors.New("个人工作流配置格式无效")
		}
		channels, personalWorkflows = config.LocalChannels, config.WorkflowChannels
	default:
		return ResolvedWorkflow{}, errors.New("工作流归属类型无效")
	}
	for _, channel := range channels {
		if channel.ID != ref.ChannelID {
			continue
		}
		if !isWorkflowChannelProtocol(channel.Protocol) {
			return ResolvedWorkflow{}, errors.New("目标渠道不是工作流渠道")
		}
		if ref.Scope == "personal" {
			for _, saved := range personalWorkflows {
				if saved.ChannelID == channel.ID && saved.Protocol == channel.Protocol {
					channel.Workflows = saved.Workflows
					break
				}
			}
		}
		if !requireEntry {
			return ResolvedWorkflow{Channel: channel, OwnerScope: ownerScope, OwnerID: ownerID}, nil
		}
		for _, entry := range channel.Workflows {
			if entry.Kind != ref.Kind || entry.WorkflowID != ref.WorkflowID {
				continue
			}
			if entry.Provider != channel.Protocol {
				return ResolvedWorkflow{}, errors.New("工作流来源与渠道协议不匹配")
			}
			if !entry.Enabled {
				return ResolvedWorkflow{}, errors.New("这条工作流已停用")
			}
			if entry.Capability != "image" && entry.Capability != "video" && entry.Capability != "audio" {
				return ResolvedWorkflow{}, errors.New("工作流用途无效")
			}
			if channel.Protocol == "comfyui" {
				if entry.Kind != "workflow" {
					return ResolvedWorkflow{}, errors.New("ComfyUI 只支持 Workflow 类型")
				}
				if strings.TrimSpace(channel.BridgeID) != "" {
					bridge, err := repository.GetComfyBridge(channel.BridgeID)
					if err != nil || !bridge.Enabled || bridge.OwnerScope != ownerScope || bridge.OwnerID != ownerID {
						return ResolvedWorkflow{}, errors.New("ComfyUI Bridge 不存在或无权使用")
					}
				} else if _, ok := comfyTargetForEntry(entry); !ok {
					return ResolvedWorkflow{}, errors.New("ComfyUI 服务地址未配置，请先在系统设置里填写默认地址")
				}
			}
			return ResolvedWorkflow{Channel: channel, Entry: entry, OwnerScope: ownerScope, OwnerID: ownerID}, nil
		}
		return ResolvedWorkflow{}, errors.New("工作流不存在或已删除")
	}
	return ResolvedWorkflow{}, errors.New("工作流渠道不存在或已删除")
}
