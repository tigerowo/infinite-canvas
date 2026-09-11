package medialifecycle

import (
	"encoding/json"
	"net/url"
	"sort"
	"strings"

	"github.com/tigerowo/infinite-canvas/model"
	"gorm.io/gorm"
	"gorm.io/gorm/clause"
)

type Use struct {
	Owner       string   `json:"-"`
	Kind        string   `json:"kind"`
	ID          string   `json:"id"`
	OperationID string   `json:"operationId"`
	Epoch       int64    `json:"epoch"`
	Version     *int64   `json:"version,omitempty"`
	Files       []string `json:"files"`
	Payload     string   `json:"-"`
	Protection  int64    `json:"-"`
	Content     string   `json:"content,omitempty"`
}
type UseResult struct {
	Entity    Entity   `json:"entity"`
	ExpiresAt int64    `json:"expiresAt"`
	Missing   []string `json:"missing"`
	Epoch     int64    `json:"epoch"`
	Replayed  bool     `json:"-"`
	Draft     *Entity  `json:"draft,omitempty"`
}

// ReadUse never registers an activity. Version zero represents a new draft.
func ReadUse(db *gorm.DB, owner, kind, id string) (UseResult, error) {
	var result UseResult
	err := WithLock(db, func(tx *gorm.DB, p *Policy) error {
		if p.Clearing {
			return ErrClearing
		}
		var entity Entity
		err := tx.First(&entity, "entity_key = ?", Key(owner, kind, id)).Error
		if notFound(err) {
			entity = Entity{Owner: owner, Kind: kind, ID: id, State: Active}
		} else if err != nil {
			return err
		}
		if entity.State != Active {
			return ErrConflict
		}
		result = UseResult{Entity: entity, ExpiresAt: expires(entity.Activity, *p), Epoch: p.Epoch}
		return nil
	})
	return result, err
}

func ensureFile(tx *gorm.DB, p Policy, id string) (File, error) {
	var f File
	err := tx.First(&f, "id = ?", id).Error
	if !notFound(err) {
		return f, err
	}
	var object model.StorageObject
	if err := tx.First(&object, "id = ? AND deleted_at = ?", id, "").Error; err != nil {
		if notFound(err) {
			return f, ErrUnavailable
		}
		return f, err
	}
	raw, err := json.Marshal(object)
	if err != nil {
		return f, err
	}
	// Legacy objects retain their owner and get a complete migration window.
	f = File{ID: id, Scope: Key("legacy", object.ProviderID, object.Bucket), Hash: object.SHA256, State: Active, Bytes: object.Bytes, Mime: object.MimeType, Activity: timestamp(), Created: timestamp(), Version: 1, Epoch: p.Epoch, ObjectJSON: string(raw)}
	if err := tx.Create(&f).Error; err != nil {
		return f, err
	}
	if object.CreatedBy != "" && object.CreatedBy != "anonymous" {
		_, err = material(tx, p, object.CreatedBy, f, "")
	}
	return f, err
}

func material(tx *gorm.DB, p Policy, owner string, f File, name string) (Material, error) {
	var m Material
	err := tx.Where("owner = ? AND file_id = ?", owner, f.ID).First(&m).Error
	if err == nil {
		return m, nil
	}
	if !notFound(err) {
		return m, err
	}
	if name == "" {
		name = "共享素材"
	}
	m = Material{ID: "media_" + strings.ReplaceAll(ID(), "-", ""), Owner: owner, FileID: f.ID, Name: name, State: Active, Activity: f.Activity, Epoch: p.Epoch}
	return m, tx.Create(&m).Error
}

func canUse(tx *gorm.DB, owner string, f File) error {
	if f.State != Active {
		return ErrUnavailable
	}
	var count int64
	if err := tx.Model(&Material{}).Where("owner = ? AND file_id = ? AND state = ?", owner, f.ID, Active).Count(&count).Error; err != nil {
		return err
	}
	if count > 0 {
		return nil
	}
	// Removing a personal-library item stops its share ID, but cannot break
	// references already saved in the same user's canvas or task.
	err := tx.Table("ext_media_lifecycle_references AS r").Joins("JOIN ext_media_lifecycle_entities AS e ON e.entity_key = r.entity_key").Where("e.owner = ? AND e.state = ? AND r.file_id = ?", owner, Active, f.ID).Count(&count).Error
	if err != nil {
		return err
	}
	if count > 0 {
		return nil
	}
	return ErrForbidden
}

func CheckAccess(db *gorm.DB, owner, id string) error {
	return WithLock(db, func(tx *gorm.DB, p *Policy) error {
		if p.Clearing {
			return ErrClearing
		}
		f, err := ensureFile(tx, *p, id)
		if err != nil {
			return err
		}
		return canUse(tx, owner, f)
	})
}

// ReadWindow validates lifecycle state even for an existing public URL. It does
// not register an activity or grant an owner-independent private permission.
func ReadWindow(db *gorm.DB, id string) (int64, error) {
	var until int64
	err := WithLock(db, func(tx *gorm.DB, p *Policy) error {
		if p.Clearing {
			return ErrClearing
		}
		file, err := ensureFile(tx, *p, id)
		if err != nil {
			return err
		}
		if file.State != Active {
			return ErrUnavailable
		}
		until = expires(file.Activity, *p)
		if until != 0 {
			until = max(until, file.Protection)
		}
		return nil
	})
	return until, err
}

// SaveUse joins business persistence and the reference graph in one transaction.
// Missing old files are reported; unauthorized/new locked dependencies fail closed.
func SaveUse(db *gorm.DB, input Use, save func(*gorm.DB) error) (UseResult, error) {
	var result UseResult
	err := WithLock(db, func(tx *gorm.DB, p *Policy) error {
		if err := guard(*p, input.Epoch); err != nil {
			return err
		}
		return saveUse(tx, *p, input, save, &result)
	})
	return result, err
}

// Promote protects the submitted references before releasing their draft edge.
// The durable request remains bounded by retention and the 24-hour task limit.
func Promote(db *gorm.DB, input Use, draftID string, draftVersion ...*int64) (UseResult, error) {
	var result UseResult
	err := WithLock(db, func(tx *gorm.DB, p *Policy) error {
		if err := guard(*p, input.Epoch); err != nil {
			return err
		}
		input.Kind = "request"
		input.Protection = timestamp() + Day
		input.Content = draftID
		for _, id := range input.Files {
			f, err := ensureFile(tx, *p, id)
			if err != nil {
				return err
			}
			if err := canUse(tx, input.Owner, f); err != nil {
				return err
			}
		}
		if err := saveUse(tx, *p, input, nil, &result); err != nil {
			return err
		}
		if result.Replayed {
			return nil
		}
		if draftID != "" {
			var draft Entity
			if err := tx.First(&draft, "entity_key = ?", Key(input.Owner, "draft", draftID)).Error; err != nil {
				return err
			}
			if draft.State != Active {
				return ErrConflict
			}
			if !result.Replayed {
				if len(draftVersion) > 0 && draftVersion[0] != nil && draft.Version != *draftVersion[0] {
					return ErrConflict
				}
				if len(input.Files) > 0 {
					if err := tx.Where("entity_key = ? AND file_id IN ?", draft.Key, input.Files).Delete(&Reference{}).Error; err != nil {
						return err
					}
					draft.Version++
					if err := tx.Save(&draft).Error; err != nil {
						return err
					}
				}
			}
			result.Draft = &draft
		}
		if input.OperationID != "" {
			raw, err := json.Marshal(result)
			if err != nil {
				return err
			}
			if err := tx.Model(&Operation{}).Where("id = ?", Key(input.Owner, input.OperationID)).Update("result", string(raw)).Error; err != nil {
				return err
			}
		}
		return nil
	})
	return result, err
}
func saveUse(tx *gorm.DB, p Policy, input Use, save func(*gorm.DB) error, result *UseResult) error {
	if input.Owner == "" || input.ID == "" || len(input.ID) > 255 || input.Kind == "" || len(input.Kind) > 32 {
		return Error("引用位置无效")
	}
	key := Key(input.Owner, input.Kind, input.ID)
	var entity Entity
	err := tx.First(&entity, "entity_key = ?", key).Error
	found := err == nil
	if err != nil && !notFound(err) {
		return err
	}
	if found && entity.State != Active {
		return ErrConflict
	}
	requestJSON, err := json.Marshal(struct {
		Kind, ID, Payload, Content string
		Files                      []string
	}{input.Kind, input.ID, input.Payload, input.Content, unique(input.Files)})
	if err != nil {
		return err
	}
	requestFingerprint := Key(string(requestJSON))
	if input.OperationID != "" {
		var op Operation
		err := tx.First(&op, "id = ?", Key(input.Owner, input.OperationID)).Error
		if err == nil {
			if op.EntityKey != key || op.Fingerprint != requestFingerprint || op.Epoch != p.Epoch {
				return ErrConflict
			}
			if op.Result == "" || json.Unmarshal([]byte(op.Result), result) != nil {
				return ErrConflict
			}
			result.Replayed = true
			return nil
		}
		if !notFound(err) {
			return err
		}
	}
	if input.Version != nil && ((!found && *input.Version != 0) || (found && entity.Version != *input.Version)) {
		return ErrConflict
	}
	now := timestamp()
	fingerprint := Key(input.Payload)
	if input.Kind == "draft" {
		fingerprint = Key(input.Content)
	}
	changed := !found || (input.Payload != "" && fingerprint != entity.Fingerprint) || (input.Kind != "draft" && input.OperationID != "")
	if !found {
		entity = Entity{Key: key, Owner: input.Owner, Kind: input.Kind, ID: input.ID, State: Active, Created: now, Epoch: p.Epoch}
	}
	files := unique(append(input.Files, ExtractFiles(input.Payload)...))
	var old []Reference
	if err := tx.Where("entity_key = ?", key).Find(&old).Error; err != nil {
		return err
	}
	if input.Payload == "" && input.Files == nil {
		for _, ref := range old {
			files = append(files, ref.FileID)
		}
		files = unique(files)
	}
	oldFiles := map[string]bool{}
	for _, r := range old {
		oldFiles[r.FileID] = true
	}
	if input.Kind == "draft" {
		changed = !found || (input.Content != "" && fingerprint != entity.Fingerprint) || len(files) != len(oldFiles)
		for _, id := range files {
			if !oldFiles[id] {
				changed = true
			}
		}
		if input.Content == "" && found {
			fingerprint = entity.Fingerprint
		}
	}
	missing := []string{}
	for _, id := range files {
		f, err := ensureFile(tx, p, id)
		if err == ErrUnavailable {
			missing = append(missing, id)
			continue
		}
		if err != nil {
			return err
		}
		if f.State == Deleted && oldFiles[id] {
			missing = append(missing, id)
			continue
		}
		if err := canUse(tx, input.Owner, f); err != nil {
			return err
		}
		if changed {
			f.Activity = now
			f.Version++
			if input.Protection > f.Protection {
				f.Protection = input.Protection
			}
			if err := tx.Save(&f).Error; err != nil {
				return err
			}
			if err := tx.Model(&Material{}).Where("owner = ? AND file_id = ?", input.Owner, id).Update("activity", now).Error; err != nil {
				return err
			}
		}
	}
	if save != nil {
		if err := save(tx); err != nil {
			return err
		}
	}
	if changed {
		entity.Activity = now
		entity.Version++
		entity.Fingerprint = fingerprint
	}
	if input.Protection > entity.Protection {
		entity.Protection = input.Protection
	}
	if err := tx.Save(&entity).Error; err != nil {
		return err
	}
	if err := tx.Where("entity_key = ?", key).Delete(&Reference{}).Error; err != nil {
		return err
	}
	for _, id := range files {
		if err := tx.Create(&Reference{EntityKey: key, FileID: id}).Error; err != nil {
			return err
		}
	}
	*result = UseResult{Entity: entity, ExpiresAt: expires(entity.Activity, p), Missing: missing, Epoch: p.Epoch}
	if input.OperationID != "" {
		raw, err := json.Marshal(result)
		if err != nil {
			return err
		}
		if err := tx.Create(&Operation{ID: Key(input.Owner, input.OperationID), Owner: input.Owner, EntityKey: key, Fingerprint: requestFingerprint, Result: string(raw), Created: now, Epoch: p.Epoch}).Error; err != nil {
			return err
		}
	}
	return nil
}

func Release(db *gorm.DB, owner, kind, id string, epoch int64, remove func(*gorm.DB) error) error {
	return WithLock(db, func(tx *gorm.DB, p *Policy) error {
		if err := guard(*p, epoch); err != nil {
			return err
		}
		return ReleaseLocked(tx, *p, owner, kind, id, remove)
	})
}

func ReleaseLocked(tx *gorm.DB, p Policy, owner, kind, id string, remove func(*gorm.DB) error) error {
	key := Key(owner, kind, id)
	var existing Entity
	err := tx.First(&existing, "entity_key = ?", key).Error
	if err != nil && !notFound(err) {
		return err
	}
	if err == nil && existing.Epoch != p.Epoch {
		return ErrConflict
	}
	if strings.HasSuffix(kind, "-task") {
		if err := tx.Where("id = ?", key).Delete(&TaskAttempt{}).Error; err != nil {
			return err
		}
		if err := SettlementState(tx, owner, id, "unknown"); err != nil {
			return err
		}
	}
	if remove != nil {
		if err := remove(tx); err != nil {
			return err
		}
	}
	row := Entity{Key: key, Owner: owner, Kind: kind, ID: id, State: Deleted, Activity: timestamp(), Created: timestamp(), Epoch: p.Epoch, Version: 1}
	if err := tx.Clauses(clause.OnConflict{Columns: []clause.Column{{Name: "entity_key"}}, DoUpdates: clause.Assignments(map[string]any{"state": Deleted, "activity": timestamp(), "version": gorm.Expr("? + 1", clause.Column{Table: "ext_media_lifecycle_entities", Name: "version"})})}).Create(&row).Error; err != nil {
		return err
	}
	return tx.Where("entity_key = ?", key).Delete(&Reference{}).Error
}

type MaterialView struct {
	Material
	MimeType     string `json:"mimeType"`
	Bytes        int64  `json:"bytes"`
	StorageKey   string `json:"storageKey"`
	ExpiresAt    int64  `json:"expiresAt"`
	DraftVersion int64  `json:"draftVersion,omitempty"`
}

func Resolve(db *gorm.DB, shareID string) (MaterialView, error) {
	var view MaterialView
	err := WithLock(db, func(tx *gorm.DB, p *Policy) error {
		if p.Clearing {
			return ErrClearing
		}
		var source Material
		if err := tx.First(&source, "id = ? AND state = ?", shareID, Active).Error; err != nil {
			if notFound(err) {
				return ErrUnavailable
			}
			return err
		}
		f, err := ensureFile(tx, *p, source.FileID)
		if err != nil {
			return err
		}
		if f.State != Active {
			return ErrUnavailable
		}
		view = MaterialView{Material: source, MimeType: f.Mime, Bytes: f.Bytes, StorageKey: "server:" + f.ID, ExpiresAt: expires(f.Activity, *p)}
		return nil
	})
	return view, err
}
func Share(db *gorm.DB, owner, id string) (MaterialView, error) {
	var view MaterialView
	err := WithLock(db, func(tx *gorm.DB, p *Policy) error {
		if err := guard(*p, 0); err != nil {
			return err
		}
		f, err := ensureFile(tx, *p, id)
		if err != nil {
			return err
		}
		if err := canUse(tx, owner, f); err != nil {
			return err
		}
		m, err := material(tx, *p, owner, f, "")
		if err != nil {
			return err
		}
		if m.State != Active {
			newID := "media_" + strings.ReplaceAll(ID(), "-", "")
			if err := tx.Model(&m).Updates(map[string]any{"id": newID, "state": Active}).Error; err != nil {
				return err
			}
			m.ID = newID
			m.State = Active
		}
		view = MaterialView{Material: m, MimeType: f.Mime, Bytes: f.Bytes, StorageKey: "server:" + f.ID, ExpiresAt: expires(f.Activity, *p)}
		return nil
	})
	return view, err
}
func Claim(db *gorm.DB, owner, shareID string, input Use) (MaterialView, error) {
	var view MaterialView
	err := WithLock(db, func(tx *gorm.DB, p *Policy) error {
		if err := guard(*p, input.Epoch); err != nil {
			return err
		}
		var source Material
		if err := tx.First(&source, "id = ? AND state = ?", shareID, Active).Error; err != nil {
			if notFound(err) {
				return ErrUnavailable
			}
			return err
		}
		f, err := ensureFile(tx, *p, source.FileID)
		if err != nil {
			return err
		}
		if f.State != Active {
			return ErrUnavailable
		}
		m, err := material(tx, *p, owner, f, source.Name)
		if err != nil {
			return err
		}
		if m.State != Active {
			m.ID = "media_" + strings.ReplaceAll(ID(), "-", "")
			m.State = Active
			if err := tx.Model(&Material{}).Where("owner = ? AND file_id = ?", owner, f.ID).Updates(map[string]any{"id": m.ID, "state": Active}).Error; err != nil {
				return err
			}
		}
		input.Owner = owner
		input.Files = unique(append(input.Files, f.ID))
		input.OperationID = "claim:" + input.OperationID + ":" + f.ID
		// Preserve the other references already attached to this draft.
		var refs []Reference
		if err := tx.Where("entity_key = ?", Key(owner, input.Kind, input.ID)).Find(&refs).Error; err != nil {
			return err
		}
		for _, ref := range refs {
			input.Files = append(input.Files, ref.FileID)
		}
		if len(unique(input.Files)) > 50 {
			return Error("图片、视频、音频参考素材合计最多 50 个")
		}
		var result UseResult
		if err := saveUse(tx, *p, input, nil, &result); err != nil {
			return err
		}
		view = MaterialView{Material: m, MimeType: f.Mime, Bytes: f.Bytes, StorageKey: "server:" + f.ID, ExpiresAt: result.ExpiresAt, DraftVersion: result.Entity.Version}
		return nil
	})
	return view, err
}

// ExtractFiles accepts only structured object locators, never arbitrary hashes.
// JSON-encoded nested request/history payloads are inspected with a depth bound.
func ExtractFiles(raw string) []string {
	result := []string{}
	var walk func(any, int)
	walk = func(v any, depth int) {
		if depth > 64 {
			return
		}
		switch item := v.(type) {
		case map[string]any:
			for _, value := range item {
				walk(value, depth+1)
			}
		case []any:
			for _, value := range item {
				walk(value, depth+1)
			}
		case string:
			if strings.HasPrefix(item, "server:") {
				id := strings.TrimPrefix(item, "server:")
				if len(id) > 0 && len(id) <= 64 && !strings.ContainsAny(id, " /?&#\n\r") {
					result = append(result, id)
				}
				return
			}
			if u, err := url.Parse(item); err == nil && strings.HasPrefix(u.Path, "/api/files/") {
				id := strings.Split(strings.TrimPrefix(u.Path, "/api/files/"), "/")[0]
				if id != "" && len(id) <= 64 {
					result = append(result, id)
				}
				return
			}
			if strings.HasPrefix(item, "{") || strings.HasPrefix(item, "[") {
				var nested any
				if json.Unmarshal([]byte(item), &nested) == nil {
					walk(nested, depth+1)
				}
			}
		}
	}
	var value any
	if json.Unmarshal([]byte(raw), &value) == nil {
		walk(value, 0)
	}
	return unique(result)
}
func unique(values []string) []string {
	set := map[string]bool{}
	for _, v := range values {
		if v != "" {
			set[v] = true
		}
	}
	result := make([]string, 0, len(set))
	for v := range set {
		result = append(result, v)
	}
	sort.Strings(result)
	return result
}
