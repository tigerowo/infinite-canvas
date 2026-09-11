package medialifecycle

import (
	"encoding/json"
	"fmt"
	"time"

	"gorm.io/gorm"
)

type PolicyChangePreview struct {
	ID                string `json:"id"`
	Files             int    `json:"files"`
	Records           int    `json:"records"`
	Bytes             int64  `json:"bytes"`
	AdditionalFiles   int    `json:"additionalFiles"`
	AdditionalRecords int    `json:"additionalRecords"`
	Fingerprint       string `json:"-"`
}

func validatePolicyInput(input Policy) error {
	if (input.Mode != "retention" && input.Mode != "forever") || input.Days < 1 || input.Days > 36500 || (input.Execution != "observe" && input.Execution != "enforce") {
		return Error("保留模式或天数无效（1 至 36500 天）")
	}
	return nil
}

func needsPolicyPreview(current, proposed Policy) bool {
	return proposed.Mode == "retention" && (current.Mode == "forever" || proposed.Days < current.Days || (current.Execution != "enforce" && proposed.Execution == "enforce"))
}

func policyImpact(tx *gorm.DB, current, proposed Policy) (PolicyChangePreview, error) {
	result := PolicyChangePreview{}
	identity := []string{fmt.Sprintf("%d/%d/%s/%d/%s/%t", current.Version, current.Epoch, proposed.Mode, proposed.Days, proposed.Execution, proposed.StorageReviewed)}
	now := timestamp()
	var entities []Entity
	if err := tx.Where("state = ?", Active).Order("entity_key").Find(&entities).Error; err != nil {
		return result, err
	}
	for _, e := range entities {
		if !expired(e.Activity, e.Protection, now, proposed) {
			continue
		}
		result.Records++
		if !expired(e.Activity, e.Protection, now, current) {
			result.AdditionalRecords++
		}
		identity = append(identity, fmt.Sprintf("entity/%s/%d", e.Key, e.Version))
	}
	var files []File
	if err := tx.Where("state IN ?", []string{Active, Uploading, Deleting}).Order("id").Find(&files).Error; err != nil {
		return result, err
	}
	for _, f := range files {
		if f.State != Deleting {
			if !expired(f.Activity, f.Protection, now, proposed) {
				continue
			}
			protected, err := hasLiveDependency(tx, proposed, f.ID, now)
			if err != nil {
				return result, err
			}
			if protected {
				continue
			}
		}
		result.Files++
		result.Bytes += f.Bytes
		oldProtected, err := hasLiveDependency(tx, current, f.ID, now)
		if err != nil {
			return result, err
		}
		if f.State != Deleting && (!expired(f.Activity, f.Protection, now, current) || oldProtected) {
			result.AdditionalFiles++
		}
		identity = append(identity, fmt.Sprintf("file/%s/%d/%s", f.ID, f.Version, f.Scope))
	}
	result.Fingerprint = Key(identity...)
	return result, nil
}

// A policy preview is a short-lived control receipt, not a runnable delete batch.
func PreviewPolicyChange(db *gorm.DB, proposed Policy) (PolicyChangePreview, error) {
	var result PolicyChangePreview
	err := WithLock(db, func(tx *gorm.DB, current *Policy) error {
		if current.Clearing {
			return ErrClearing
		}
		if current.Version != proposed.Version {
			return ErrConflict
		}
		if err := validatePolicyInput(proposed); err != nil {
			return err
		}
		if current.MigratedAt == 0 {
			return Error("旧数据登记尚未完成，不能预览保留规则")
		}
		var err error
		result, err = policyImpact(tx, *current, proposed)
		if err != nil {
			return err
		}
		result.ID = Key("policy-preview", ID())
		body, err := json.Marshal(result)
		if err != nil {
			return err
		}
		return tx.Create(&Operation{ID: result.ID, EntityKey: "policy-preview", Fingerprint: result.Fingerprint, Result: string(body), Created: timestamp(), Epoch: current.Epoch}).Error
	})
	return result, err
}

func verifyPolicyPreview(tx *gorm.DB, current, proposed Policy, ids []string) error {
	if !needsPolicyPreview(current, proposed) {
		return nil
	}
	if len(ids) != 1 || ids[0] == "" {
		return Error("缩短保留期限或启用清理前，请先预览并确认影响范围")
	}
	var receipt Operation
	if err := tx.First(&receipt, "id = ? AND entity_key = ?", ids[0], "policy-preview").Error; err != nil {
		return Error("保留规则预览无效，请重新预览")
	}
	if receipt.Epoch != current.Epoch || timestamp()-receipt.Created > int64(15*time.Minute/time.Millisecond) {
		return Error("保留规则预览已失效，请重新预览")
	}
	impact, err := policyImpact(tx, current, proposed)
	if err != nil {
		return err
	}
	if receipt.Fingerprint != impact.Fingerprint {
		return Error("规则或到期候选已变化，请重新预览后保存")
	}
	return nil
}
