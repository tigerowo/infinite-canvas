package service

import (
	"context"
	"errors"
	"path"
	"strings"
	"unicode/utf8"

	"github.com/tigerowo/infinite-canvas/model"
	"github.com/tigerowo/infinite-canvas/repository"
)

const (
	maxAgentSkillContentLength = 20000
	maxAgentSkillPathLength    = 191
)

func ListEnabledSystemAgentSkills() ([]model.AgentSkill, error) {
	return repository.ListEnabledSystemAgentSkills()
}

func ListSystemAgentSkills() ([]model.AgentSkill, error) {
	return repository.ListSystemAgentSkills()
}

func ListSystemAgentSkillFiles(id string) ([]model.AgentSkillFile, error) {
	item, found, err := repository.GetAgentSkill(strings.TrimSpace(id))
	if err != nil {
		return nil, err
	}
	if !found || item.Source != model.AgentSkillSourceSystem {
		return nil, errors.New("Skill 不存在")
	}
	return repository.ListAgentSkillFiles(item.ID)
}

func ReadEnabledSystemAgentSkillFile(id string, filePath string) (model.AgentSkillFile, error) {
	item, found, err := repository.GetAgentSkill(strings.TrimSpace(id))
	if err != nil {
		return model.AgentSkillFile{}, err
	}
	if !found || item.Source != model.AgentSkillSourceSystem || !item.Enabled {
		return model.AgentSkillFile{}, errors.New("Skill 不存在或未启用")
	}
	cleanPath, err := normalizeAgentSkillPath(filePath)
	if err != nil {
		return model.AgentSkillFile{}, err
	}
	if strings.EqualFold(cleanPath, "SKILL.md") {
		return model.AgentSkillFile{SkillID: item.ID, Path: "SKILL.md", Kind: model.AgentSkillFileKindFile, Content: item.Content}, nil
	}
	file, found, err := repository.GetAgentSkillFile(item.ID, cleanPath)
	if err != nil {
		return model.AgentSkillFile{}, err
	}
	if !found {
		return model.AgentSkillFile{}, errors.New("Skill 文件不存在")
	}
	return file, nil
}

func ListCurrentUserAgentSkills(ctx context.Context) ([]model.AgentSkill, error) {
	user, ok := UserFromContext(ctx)
	if !ok || user.ID == "" {
		return nil, errors.New("请先登录")
	}
	return repository.ListUserAgentSkills(user.ID)
}

func SaveCurrentUserAgentSkill(ctx context.Context, input model.AgentSkill) (model.AgentSkill, error) {
	user, ok := UserFromContext(ctx)
	if !ok || user.ID == "" {
		return model.AgentSkill{}, errors.New("请先登录")
	}
	return saveAgentSkill(input, model.AgentSkillSourceUser, user.ID)
}

func SaveSystemAgentSkill(input model.AgentSkill) (model.AgentSkill, error) {
	return saveAgentSkill(input, model.AgentSkillSourceSystem, "")
}

func DeleteCurrentUserAgentSkill(ctx context.Context, id string) error {
	user, ok := UserFromContext(ctx)
	if !ok || user.ID == "" {
		return errors.New("请先登录")
	}
	return repository.DeleteUserAgentSkill(strings.TrimSpace(id), user.ID)
}

func DeleteSystemAgentSkill(id string) error {
	return repository.DeleteSystemAgentSkill(strings.TrimSpace(id))
}

func saveAgentSkill(input model.AgentSkill, source string, ownerUserID string) (model.AgentSkill, error) {
	name := strings.TrimSpace(input.Name)
	content := strings.TrimSpace(input.Content)
	if name == "" {
		return model.AgentSkill{}, errors.New("请输入 Skill 名称")
	}
	if content == "" {
		return model.AgentSkill{}, errors.New("请输入 Skill 内容")
	}
	if utf8.RuneCountInString(content) > maxAgentSkillContentLength {
		return model.AgentSkill{}, errors.New("Skill 内容不能超过 20000 字")
	}

	current := now()
	id := strings.TrimSpace(input.ID)
	createdAt := ""
	if id != "" {
		existing, found, err := repository.GetAgentSkill(id)
		if err != nil {
			return model.AgentSkill{}, err
		}
		if !found || existing.Source != source || existing.OwnerUserID != ownerUserID {
			return model.AgentSkill{}, errors.New("Skill 不存在或无权修改")
		}
		createdAt = existing.CreatedAt
	} else {
		id = newID("agent-skill")
		createdAt = current
	}

	item := model.AgentSkill{
		ID:              id,
		OwnerUserID:     ownerUserID,
		Source:          source,
		Name:            name,
		Description:     strings.TrimSpace(input.Description),
		CoverURL:        strings.TrimSpace(input.CoverURL),
		CoverStorageKey: strings.TrimSpace(input.CoverStorageKey),
		Content:         content,
		Enabled:         source == model.AgentSkillSourceUser || input.Enabled,
		Sort:            input.Sort,
		CreatedAt:       createdAt,
		UpdatedAt:       current,
	}
	if source == model.AgentSkillSourceSystem {
		files, err := normalizeAgentSkillFiles(id, input.Files, current)
		if err != nil {
			return model.AgentSkill{}, err
		}
		return repository.SaveAgentSkillPackage(item, files)
	}
	return repository.SaveAgentSkill(item)
}

func normalizeAgentSkillFiles(skillID string, files []model.AgentSkillFile, current string) ([]model.AgentSkillFile, error) {
	result := make([]model.AgentSkillFile, 0, len(files))
	seen := make(map[string]struct{}, len(files))
	for _, input := range files {
		filePath, err := normalizeAgentSkillPath(input.Path)
		if err != nil {
			return nil, err
		}
		if strings.EqualFold(filePath, "SKILL.md") {
			return nil, errors.New("根 SKILL.md 请使用 Skill 内容编辑")
		}
		pathKey := strings.ToLower(filePath)
		if _, exists := seen[pathKey]; exists {
			return nil, errors.New("Skill 文件路径重复：" + filePath)
		}
		seen[pathKey] = struct{}{}
		kind := strings.TrimSpace(input.Kind)
		if kind != model.AgentSkillFileKindFolder && kind != model.AgentSkillFileKindFile {
			return nil, errors.New("Skill 文件类型无效")
		}
		content := input.Content
		if kind == model.AgentSkillFileKindFolder {
			content = ""
		} else {
			ext := strings.ToLower(path.Ext(filePath))
			if ext != ".md" && ext != ".markdown" && ext != ".txt" {
				return nil, errors.New("Skill 只支持 Markdown 或文本文件")
			}
			if utf8.RuneCountInString(content) > maxAgentSkillContentLength {
				return nil, errors.New("Skill 文件不能超过 20000 字：" + filePath)
			}
		}
		result = append(result, model.AgentSkillFile{SkillID: skillID, Path: filePath, Kind: kind, Content: content, Sort: input.Sort, CreatedAt: current, UpdatedAt: current})
	}
	return result, nil
}

func normalizeAgentSkillPath(value string) (string, error) {
	value = strings.TrimSpace(strings.ReplaceAll(value, "\\", "/"))
	clean := path.Clean(value)
	if value == "" || clean == "." || strings.ContainsAny(clean, ":\x00") || strings.HasPrefix(clean, "/") || clean == ".." || strings.HasPrefix(clean, "../") {
		return "", errors.New("Skill 文件路径无效")
	}
	if utf8.RuneCountInString(clean) > maxAgentSkillPathLength {
		return "", errors.New("Skill 文件路径不能超过 191 字符")
	}
	return clean, nil
}
