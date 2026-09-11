package medialifecycle

import (
	"encoding/json"
	"strings"
)

func AssetCollectionSnapshot(raw string) (json.RawMessage, error) {
	data, err := assetCollection(raw)
	if err != nil {
		return nil, err
	}
	canonical, err := json.Marshal(data)
	if err != nil {
		return nil, err
	}
	revision, _ := json.Marshal(Key(string(canonical)))
	data["revision"] = revision
	return json.Marshal(data)
}

func assetCollection(raw string) (map[string]json.RawMessage, error) {
	if strings.TrimSpace(raw) == "" {
		raw = `{"assets":[]}`
	}
	var data map[string]json.RawMessage
	if json.Unmarshal([]byte(raw), &data) != nil || data == nil {
		return nil, Error("素材集合格式无效")
	}
	var entries []map[string]json.RawMessage
	if json.Unmarshal(data["assets"], &entries) != nil {
		return nil, Error("素材集合缺少有效数组")
	}
	seen := map[string]bool{}
	for _, entry := range entries {
		var id string
		if json.Unmarshal(entry["id"], &id) != nil || id == "" || seen[id] {
			return nil, Error("素材 ID 无效或重复")
		}
		seen[id] = true
	}
	delete(data, "revision")
	return data, nil
}

func compareAssetCollection(current, incoming string) (string, error) {
	var proposed map[string]json.RawMessage
	if json.Unmarshal([]byte(incoming), &proposed) != nil {
		return "", Error("素材集合格式无效")
	}
	var revision string
	if json.Unmarshal(proposed["revision"], &revision) != nil || revision == "" {
		return "", Error("素材同步版本缺失，请刷新后重试；本机修改仍保留")
	}
	previous, err := assetCollection(current)
	if err != nil {
		return "", err
	}
	canonical, err := json.Marshal(previous)
	if err != nil {
		return "", err
	}
	if revision != Key(string(canonical)) {
		return "", ErrConflict
	}
	data, err := assetCollection(incoming)
	if err != nil {
		return "", err
	}
	encoded, err := json.Marshal(data)
	return string(encoded), err
}
