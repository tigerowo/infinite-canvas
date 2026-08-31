package service

import (
	"crypto/sha256"
	"embed"
	"fmt"
	"io/fs"
	"path"
	"sort"
	"strings"
	"unicode/utf8"

	"github.com/goccy/go-yaml"
	"github.com/tigerowo/infinite-canvas/model"
	"github.com/tigerowo/infinite-canvas/repository"
)

//go:embed skills
var defaultAgentSkillFS embed.FS

type defaultAgentSkillMetadata struct {
	Name        string `yaml:"name"`
	Description string `yaml:"description"`
}

type defaultAgentSkillPackage struct {
	Root        string
	Name        string
	Description string
	Content     string
	Files       []model.AgentSkillFile
}

// EnsureDefaultAgentSkills 只在数据库首次初始化时导入 service/skills 中的默认 Skill 包。
func EnsureDefaultAgentSkills() error {
	initialized, err := repository.AgentSkillsInitialized()
	if err != nil || initialized {
		return err
	}
	existing, err := repository.ListSystemAgentSkills()
	if err != nil {
		return err
	}
	current := now()
	if len(existing) > 0 {
		return repository.MarkAgentSkillsInitialized(current)
	}
	packages, err := readDefaultAgentSkillPackages()
	if err != nil {
		return err
	}
	items := make([]model.AgentSkill, 0, len(packages))
	fileGroups := make([][]model.AgentSkillFile, 0, len(packages))
	for index, item := range packages {
		id := defaultAgentSkillID(item.Root)
		files, err := normalizeAgentSkillFiles(id, item.Files, current)
		if err != nil {
			return err
		}
		items = append(items, model.AgentSkill{
			ID: id, Source: model.AgentSkillSourceSystem, Name: item.Name, Description: item.Description,
			Content: item.Content, Enabled: true, Sort: index, CreatedAt: current, UpdatedAt: current,
		})
		fileGroups = append(fileGroups, files)
	}
	return repository.InitializeAgentSkills(items, fileGroups, current)
}

func readDefaultAgentSkillPackages() ([]defaultAgentSkillPackage, error) {
	var entries []string
	var roots []string
	err := fs.WalkDir(defaultAgentSkillFS, "skills", func(filePath string, entry fs.DirEntry, err error) error {
		if err != nil {
			return err
		}
		entries = append(entries, filePath)
		if !entry.IsDir() {
			if path.Dir(filePath) == "skills" && strings.EqualFold(path.Ext(filePath), ".md") {
				roots = append(roots, filePath)
			} else if strings.EqualFold(path.Base(filePath), "SKILL.md") {
				roots = append(roots, path.Dir(filePath))
			}
		}
		return nil
	})
	if err != nil {
		return nil, err
	}
	sort.Strings(roots)
	packages := make([]defaultAgentSkillPackage, 0, len(roots))
	for _, root := range roots {
		rootEntry, err := fs.Stat(defaultAgentSkillFS, root)
		if err != nil {
			return nil, err
		}
		skillPath := root
		if rootEntry.IsDir() {
			skillPath = path.Join(root, "SKILL.md")
		}
		data, err := defaultAgentSkillFS.ReadFile(skillPath)
		if err != nil {
			return nil, err
		}
		content := string(data)
		metadata := parseDefaultAgentSkillMetadata(content)
		name := strings.TrimSpace(metadata.Name)
		if name == "" {
			name = path.Base(root)
			if !rootEntry.IsDir() {
				name = strings.TrimSuffix(name, path.Ext(name))
			}
		}
		if strings.TrimSpace(content) == "" || utf8.RuneCountInString(content) > maxAgentSkillContentLength {
			return nil, fmt.Errorf("默认 Skill %s 的 SKILL.md 为空或超过 20000 字", root)
		}
		item := defaultAgentSkillPackage{Root: root, Name: name, Description: strings.TrimSpace(metadata.Description), Content: content}
		if !rootEntry.IsDir() {
			packages = append(packages, item)
			continue
		}
		for _, filePath := range entries {
			if filePath == root || filePath == skillPath || defaultAgentSkillRoot(filePath, roots) != root {
				continue
			}
			entry, err := fs.Stat(defaultAgentSkillFS, filePath)
			if err != nil {
				return nil, err
			}
			relativePath := strings.TrimPrefix(strings.TrimPrefix(filePath, root), "/")
			file := model.AgentSkillFile{Path: relativePath, Kind: model.AgentSkillFileKindFolder, Sort: len(item.Files)}
			if !entry.IsDir() {
				data, err := defaultAgentSkillFS.ReadFile(filePath)
				if err != nil {
					return nil, err
				}
				file.Kind = model.AgentSkillFileKindFile
				file.Content = string(data)
			}
			item.Files = append(item.Files, file)
		}
		packages = append(packages, item)
	}
	return packages, nil
}

func defaultAgentSkillRoot(filePath string, roots []string) string {
	result := ""
	for _, root := range roots {
		if (filePath == root || strings.HasPrefix(filePath, root+"/")) && len(root) > len(result) {
			result = root
		}
	}
	return result
}

func parseDefaultAgentSkillMetadata(content string) defaultAgentSkillMetadata {
	normalized := strings.ReplaceAll(content, "\r\n", "\n")
	if !strings.HasPrefix(normalized, "---\n") {
		return defaultAgentSkillMetadata{}
	}
	rest := strings.TrimPrefix(normalized, "---\n")
	end := strings.Index(rest, "\n---")
	if end < 0 {
		return defaultAgentSkillMetadata{}
	}
	var metadata defaultAgentSkillMetadata
	_ = yaml.Unmarshal([]byte(rest[:end]), &metadata)
	return metadata
}

func defaultAgentSkillID(root string) string {
	sum := sha256.Sum256([]byte(root))
	return fmt.Sprintf("agent-skill-default-%x", sum[:8])
}
