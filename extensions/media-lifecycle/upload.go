package medialifecycle

import (
	"encoding/json"
	"time"

	"github.com/tigerowo/infinite-canvas/model"
	"gorm.io/gorm"
)

type UploadLease struct {
	File   File
	Token  string
	Reused bool
}

// RegisterObject covers browser direct uploads as well as legacy index writers.
// Object identity is immutable; registration and retention must commit together.
func RegisterObject(db *gorm.DB, object model.StorageObject, scope string, epoch int64) error {
	return WithLock(db, func(tx *gorm.DB, p *Policy) error {
		if epoch == 0 && p.Epoch > 1 {
			return ErrConflict
		}
		if err := guard(*p, epoch); err != nil {
			return err
		}
		if err := tx.Create(&object).Error; err != nil {
			return err
		}
		file, err := ensureFile(tx, *p, object.ID)
		if err != nil {
			return err
		}
		if scope != "" {
			file.Scope = scope
			if err := tx.Save(&file).Error; err != nil {
				return err
			}
		}
		if object.CreatedBy == "" || object.CreatedBy == "anonymous" {
			return nil
		}
		var result UseResult
		return saveUse(tx, *p, Use{Owner: object.CreatedBy, Kind: "upload", ID: object.ID, Files: []string{object.ID}}, nil, &result)
	})
}

func PrepareUpload(db *gorm.DB, lease UploadLease, object model.StorageObject) error {
	raw, err := json.Marshal(object)
	if err != nil {
		return err
	}
	return WithLock(db, func(tx *gorm.DB, p *Policy) error {
		if err := guard(*p, lease.File.Epoch); err != nil {
			return err
		}
		if err := renewUpload(tx, lease); err != nil {
			return err
		}
		result := tx.Model(&File{}).Where("id = ? AND state = ?", lease.File.ID, Uploading).Update("object_json", string(raw))
		if result.Error != nil {
			return result.Error
		}
		if result.RowsAffected != 1 {
			return ErrConflict
		}
		return nil
	})
}

// Only the current uploader may keep its slot. Renewal never changes retention.
func RenewUpload(db *gorm.DB, lease UploadLease) error {
	return WithLock(db, func(tx *gorm.DB, p *Policy) error {
		if err := guard(*p, lease.File.Epoch); err != nil {
			return err
		}
		return renewUpload(tx, lease)
	})
}
func renewUpload(tx *gorm.DB, lease UploadLease) error {
	result := tx.Model(&Dedup{}).Where("file_id = ? AND token = ? AND lease_until > ? AND file_id IN (SELECT id FROM ext_media_lifecycle_files WHERE state = ?)", lease.File.ID, lease.Token, timestamp(), Uploading).Update("lease_until", timestamp()+int64(10*time.Minute/time.Millisecond))
	if result.Error != nil {
		return result.Error
	}
	if result.RowsAffected != 1 {
		return ErrConflict
	}
	return nil
}
func AbandonUpload(db *gorm.DB, lease UploadLease) error {
	return db.Model(&Dedup{}).Where("file_id = ? AND token = ?", lease.File.ID, lease.Token).Update("lease_until", 0).Error
}
func MarkMissing(db *gorm.DB, file File) error {
	return WithLock(db, func(tx *gorm.DB, p *Policy) error {
		if err := guard(*p, file.Epoch); err != nil {
			return err
		}
		result := tx.Model(&File{}).Where("id = ? AND state = ? AND epoch = ? AND version = ?", file.ID, Active, file.Epoch, file.Version).Updates(map[string]any{"state": Deleted, "version": gorm.Expr("version + 1")})
		if result.Error != nil {
			return result.Error
		}
		if result.RowsAffected != 1 {
			return ErrConflict
		}
		return nil
	})
}

// Recover an OSS success followed by a failed index transaction. Only a caller
// with the same verified body can obtain this lease, and the object is never rewritten.
func RecoverUpload(db *gorm.DB, lease UploadLease, owner, name string, object model.StorageObject) error {
	return CompleteUpload(db, lease, owner, name, object)
}

func StorageScope(provider model.StorageProvider, owner string) string {
	return Key("storage", string(provider.Type), provider.Endpoint, provider.Bucket, provider.PathPrefix, owner)
}

func ReserveUpload(db *gorm.DB, scope, hash, mime string, size int64, epoch int64) (UploadLease, error) {
	var lease UploadLease
	err := WithLock(db, func(tx *gorm.DB, p *Policy) error {
		if err := guard(*p, epoch); err != nil {
			return err
		}
		key := Key(scope, hash)
		var slot Dedup
		err := tx.First(&slot, "id = ?", key).Error
		if err != nil && !notFound(err) {
			return err
		}
		if err == nil {
			var f File
			if err := tx.First(&f, "id = ?", slot.FileID).Error; err != nil {
				return err
			}
			if f.State == Active {
				lease = UploadLease{File: f, Reused: true}
				return nil
			}
			if f.State == Uploading && slot.LeaseUntil > timestamp() {
				return ErrUploading
			}
		}
		now := timestamp()
		f := File{ID: ID(), Scope: scope, Hash: hash, State: Uploading, Bytes: size, Mime: mime, Activity: now, Created: now, Version: 1, Epoch: p.Epoch}
		if err := tx.Create(&f).Error; err != nil {
			return err
		}
		slot = Dedup{ID: key, FileID: f.ID, Token: ID(), LeaseUntil: now + int64(10*time.Minute/time.Millisecond)}
		if err := tx.Save(&slot).Error; err != nil {
			return err
		}
		lease = UploadLease{File: f, Token: slot.Token}
		return nil
	})
	return lease, err
}

func CompleteUpload(db *gorm.DB, lease UploadLease, owner, name string, object model.StorageObject) error {
	return WithLock(db, func(tx *gorm.DB, p *Policy) error {
		if err := guard(*p, lease.File.Epoch); err != nil {
			return err
		}
		var f File
		if err := tx.First(&f, "id = ?", lease.File.ID).Error; err != nil {
			return err
		}
		if !lease.Reused {
			var slot Dedup
			if err := tx.First(&slot, "id = ?", Key(f.Scope, f.Hash)).Error; err != nil {
				return err
			}
			if slot.Token != lease.Token || slot.FileID != f.ID || slot.LeaseUntil < timestamp() || f.State != Uploading {
				return ErrConflict
			}
			raw, err := json.Marshal(object)
			if err != nil {
				return err
			}
			f.ObjectJSON = string(raw)
			if err := tx.Create(&object).Error; err != nil {
				return err
			}
		} else if f.State != Active {
			return ErrUnavailable
		}
		f.State = Active
		f.Activity = timestamp()
		f.Version++
		if err := tx.Save(&f).Error; err != nil {
			return err
		}
		m, err := material(tx, *p, owner, f, name)
		if err != nil {
			return err
		}
		if m.State != Active {
			if err := tx.Delete(&m).Error; err != nil {
				return err
			}
			if _, err := material(tx, *p, owner, f, name); err != nil {
				return err
			}
		}
		var result UseResult
		// A verified upload is an explicit new use, even after this user removed
		// their previous library entry. Keep the same physical object identity.
		if err := tx.Model(&Entity{}).Where("entity_key = ? AND state = ?", Key(owner, "upload", f.ID), Deleted).Updates(map[string]any{"state": Active, "epoch": p.Epoch}).Error; err != nil {
			return err
		}
		return saveUse(tx, *p, Use{Owner: owner, Kind: "upload", ID: f.ID, Files: []string{f.ID}, OperationID: "upload:" + ID()}, nil, &result)
	})
}

// Detach removes this user's library/upload relationship and stops new claims
// of their old share ID. Physical deletion is exclusively a cleanup operation.
func Detach(db *gorm.DB, owner, id string) error {
	return WithLock(db, func(tx *gorm.DB, p *Policy) error {
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
		if err := tx.Model(&Material{}).Where("owner = ? AND file_id = ?", owner, id).Update("state", "revoked").Error; err != nil {
			return err
		}
		var entities []Entity
		if err := tx.Where("owner = ? AND kind IN ? AND id = ?", owner, []string{"upload", "library"}, id).Find(&entities).Error; err != nil {
			return err
		}
		for _, e := range entities {
			if err := tx.Where("entity_key = ?", e.Key).Delete(&Reference{}).Error; err != nil {
				return err
			}
			if err := tx.Model(&e).Updates(map[string]any{"state": Deleted, "version": e.Version + 1}).Error; err != nil {
				return err
			}
		}
		return nil
	})
}

func ObjectForFile(f File) (model.StorageObject, error) {
	var object model.StorageObject
	err := json.Unmarshal([]byte(f.ObjectJSON), &object)
	return object, err
}

type Capacity struct {
	PhysicalBytes int64 `json:"physicalBytes"`
	PhysicalFiles int64 `json:"physicalFiles"`
	LogicalBytes  int64 `json:"logicalBytes"`
	PendingBytes  int64 `json:"pendingBytes"`
}

func GetCapacity(db *gorm.DB, owner string) (Capacity, error) {
	var result Capacity
	var files []File
	if err := db.Where("state <> ?", Deleted).Find(&files).Error; err != nil {
		return result, err
	}
	logical := map[string]bool{}
	var materials []Material
	if err := db.Where("owner = ? AND state = ?", owner, Active).Find(&materials).Error; err != nil {
		return result, err
	}
	for _, m := range materials {
		logical[m.FileID] = true
	}
	var ids []string
	if err := db.Table("ext_media_lifecycle_references AS r").Joins("JOIN ext_media_lifecycle_entities AS e ON e.entity_key = r.entity_key").Where("e.owner = ? AND e.state = ?", owner, Active).Pluck("r.file_id", &ids).Error; err != nil {
		return result, err
	}
	for _, id := range ids {
		logical[id] = true
	}
	for _, f := range files {
		result.PhysicalFiles++
		result.PhysicalBytes += f.Bytes
		if f.State == Deleting {
			result.PendingBytes += f.Bytes
		}
		if logical[f.ID] {
			result.LogicalBytes += f.Bytes
		}
	}
	return result, nil
}
