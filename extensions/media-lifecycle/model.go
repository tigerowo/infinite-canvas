// Package medialifecycle owns retention metadata. It deliberately does not
// import repository or service, so existing persistence paths can join its transaction.
package medialifecycle

import (
	"crypto/sha256"
	"encoding/hex"
	"errors"
	"time"

	"github.com/google/uuid"
	"gorm.io/gorm"
	"gorm.io/gorm/clause"
)

const (
	Active    = "active"
	Uploading = "uploading"
	Deleting  = "deleting"
	Deleted   = "deleted"
	Day       = int64(24 * time.Hour / time.Millisecond)
)

type Error string

func (e Error) Error() string       { return string(e) }
func (e Error) SafeMessage() string { return string(e) }

const (
	ErrUnavailable = Error("素材已删除或正在清理；请保留本机原件，重新上传")
	ErrConflict    = Error("数据版本已变化，请重新同步；未同步的编辑仍保留在本机")
	ErrClearing    = Error("业务数据正在清空，请稍后新建，不要重复提交")
	ErrUploading   = Error("相同素材正在归档，请稍后重试")
	ErrForbidden   = Error("无权使用该素材")
)

type Policy struct {
	ID              int    `gorm:"primaryKey" json:"-"`
	Mode            string `gorm:"size:16" json:"mode"`
	Days            int    `json:"days"`
	Execution       string `gorm:"size:16" json:"execution"`
	Version         int64  `json:"version"`
	Epoch           int64  `json:"epoch"`
	Serial          int64  `json:"-"`
	Clearing        bool   `json:"clearing"`
	StorageReviewed bool   `json:"storageReviewed"`
	MigratedAt      int64  `json:"migratedAt"`
}

func (Policy) TableName() string { return "ext_media_lifecycle_policies" }

type File struct {
	ID           string `gorm:"size:64;primaryKey" json:"id"`
	Scope        string `gorm:"size:64;index" json:"-"`
	Hash         string `gorm:"size:64;index" json:"-"`
	State        string `gorm:"size:16;index" json:"state"`
	Bytes        int64  `json:"bytes"`
	Mime         string `gorm:"size:128" json:"mimeType"`
	Activity     int64  `gorm:"index" json:"lastUsedAt"`
	Created      int64  `json:"createdAt"`
	Protection   int64  `json:"-"`
	Version      int64  `json:"version"`
	Epoch        int64  `json:"-"`
	ObjectJSON   string `gorm:"type:text" json:"-"`
	DeleteWorker string `gorm:"size:64" json:"-"`
	DeleteUntil  int64  `json:"-"`
}

func (File) TableName() string { return "ext_media_lifecycle_files" }

type Dedup struct {
	ID         string `gorm:"size:64;primaryKey"`
	FileID     string `gorm:"size:64;index"`
	Token      string `gorm:"size:64"`
	LeaseUntil int64
}

func (Dedup) TableName() string { return "ext_media_lifecycle_dedup" }

type Material struct {
	ID       string `gorm:"size:64;primaryKey" json:"shareId"`
	Owner    string `gorm:"size:128;uniqueIndex:idx_ml_material_owner_file,priority:1" json:"-"`
	FileID   string `gorm:"size:64;uniqueIndex:idx_ml_material_owner_file,priority:2" json:"fileId"`
	Name     string `gorm:"size:255" json:"name"`
	State    string `gorm:"size:16" json:"state"`
	Activity int64  `json:"lastUsedAt"`
	Epoch    int64  `json:"-"`
}

func (Material) TableName() string { return "ext_media_lifecycle_materials" }

type Entity struct {
	Key         string `gorm:"column:entity_key;size:64;primaryKey" json:"-"`
	Owner       string `gorm:"size:128;index" json:"-"`
	Kind        string `gorm:"size:32;index" json:"kind"`
	ID          string `gorm:"size:255" json:"id"`
	State       string `gorm:"size:16;index" json:"state"`
	Fingerprint string `gorm:"size:64" json:"-"`
	Activity    int64  `gorm:"index" json:"lastUsedAt"`
	Created     int64  `json:"createdAt"`
	Protection  int64  `json:"-"`
	Version     int64  `json:"version"`
	Epoch       int64  `json:"-"`
}

func (Entity) TableName() string { return "ext_media_lifecycle_entities" }

type Reference struct {
	EntityKey string `gorm:"size:64;primaryKey"`
	FileID    string `gorm:"size:64;primaryKey;index"`
}

func (Reference) TableName() string { return "ext_media_lifecycle_references" }

type Operation struct {
	ID          string `gorm:"size:64;primaryKey"`
	Owner       string `gorm:"size:128"`
	EntityKey   string `gorm:"size:64"`
	Fingerprint string `gorm:"size:64"`
	Result      string `gorm:"type:text"`
	Created     int64  `gorm:"index"`
	Epoch       int64
}

func (Operation) TableName() string { return "ext_media_lifecycle_operations" }

type Batch struct {
	ID            string `gorm:"size:64;primaryKey" json:"id"`
	Kind          string `gorm:"size:16" json:"kind"`
	State         string `gorm:"size:16" json:"state"`
	PolicyVersion int64  `json:"policyVersion"`
	Epoch         int64  `json:"epoch"`
	Created       int64  `json:"createdAt"`
	Updated       int64  `json:"updatedAt"`
	Error         string `gorm:"type:text" json:"error,omitempty"`
	Worker        string `gorm:"size:64" json:"-"`
	LeaseUntil    int64  `json:"-"`
}

func (Batch) TableName() string { return "ext_media_lifecycle_batches" }

type BatchItem struct {
	BatchID string `gorm:"size:64;primaryKey" json:"batchId"`
	Kind    string `gorm:"size:16;primaryKey" json:"kind"`
	Target  string `gorm:"size:64;primaryKey" json:"target"`
	Version int64  `json:"version"`
	State   string `gorm:"size:16;index" json:"state"`
	Bytes   int64  `json:"bytes"`
	Error   string `gorm:"type:text" json:"error,omitempty"`
}

func (BatchItem) TableName() string { return "ext_media_lifecycle_batch_items" }

type Settlement struct {
	ID      string `gorm:"size:64;primaryKey"`
	Owner   string `gorm:"size:128;index"`
	Amount  int
	State   string `gorm:"size:16"`
	Created int64
	Epoch   int64
}

func (Settlement) TableName() string { return "ext_media_lifecycle_settlements" }

type TaskAttempt struct {
	ID              string `gorm:"size:64;primaryKey"`
	Owner           string `gorm:"size:128;index"`
	Kind            string `gorm:"size:32"`
	TaskID          string `gorm:"size:255"`
	State           string `gorm:"size:32;index"`
	Worker          string `gorm:"size:64"`
	LeaseUntil      int64  `gorm:"index"`
	ResultJSON      string `gorm:"type:text"`
	LastError       string `gorm:"type:text"`
	ManualRetry     bool
	RecoveryVersion int64
	RecoveryAt      string `gorm:"size:40"`
	Started         int64
	ArchiveStarted  int64
	ArchiveAttempts int
	NextAttempt     int64
	Epoch           int64
}

func (TaskAttempt) TableName() string { return "ext_media_lifecycle_task_attempts" }

type RequestLease struct {
	ID    string `gorm:"size:64;primaryKey"`
	Epoch int64
	Until int64 `gorm:"index"`
}

func (RequestLease) TableName() string { return "ext_media_lifecycle_request_leases" }

func Key(values ...string) string {
	h := sha256.New()
	for _, v := range values {
		h.Write([]byte(v))
		h.Write([]byte{0})
	}
	return hex.EncodeToString(h.Sum(nil))
}
func ID() string       { return uuid.NewString() }
func timestamp() int64 { return time.Now().UTC().UnixMilli() }

func Migrate(db *gorm.DB) error {
	if err := db.AutoMigrate(&Policy{}, &File{}, &Dedup{}, &Material{}, &Entity{}, &Reference{}, &Operation{}, &Batch{}, &BatchItem{}, &Settlement{}, &TaskAttempt{}, &RequestLease{}); err != nil {
		return err
	}
	return db.Clauses(clause.OnConflict{DoNothing: true}).Create(&Policy{ID: 1, Mode: "retention", Days: 30, Execution: "observe", Version: 1, Epoch: 1}).Error
}
func GetPolicy(db *gorm.DB) (Policy, error) {
	var p Policy
	err := db.First(&p, 1).Error
	return p, err
}

// WithLock serializes only short metadata transactions across processes and SQL
// dialects. Network I/O must never run inside fn. Row updates also lock on SQLite.
func WithLock(db *gorm.DB, fn func(*gorm.DB, *Policy) error) error {
	return db.Transaction(func(tx *gorm.DB) error {
		if err := tx.Model(&Policy{}).Where("id = ?", 1).UpdateColumn("serial", gorm.Expr("serial + 1")).Error; err != nil {
			return err
		}
		p, err := GetPolicy(tx)
		if err != nil {
			return err
		}
		return fn(tx, &p)
	})
}
func expires(activity int64, p Policy) int64 {
	if p.Mode == "forever" {
		return 0
	}
	return activity + int64(p.Days)*Day
}
func expired(activity, protection, now int64, p Policy) bool {
	return p.Mode != "forever" && activity+int64(p.Days)*Day <= now && protection <= now
}
func guard(p Policy, epoch int64) error {
	if p.Clearing {
		return ErrClearing
	}
	if epoch != 0 && epoch != p.Epoch {
		return ErrConflict
	}
	return nil
}

// GuardEpoch is also used by adapters that already hold the metadata lock.
func GuardEpoch(p Policy, epoch int64) error { return guard(p, epoch) }
func notFound(err error) bool                { return errors.Is(err, gorm.ErrRecordNotFound) }
