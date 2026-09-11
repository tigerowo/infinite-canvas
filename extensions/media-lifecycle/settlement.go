package medialifecycle

import (
	"encoding/json"
	"github.com/tigerowo/infinite-canvas/model"
	"gorm.io/gorm"
	"time"
)

// Debit commits the balance, audit log and durable operation together. A repeated
// submission must stop before contacting the provider, even for a free request.
func Debit(db *gorm.DB, owner, operation, modelName, path string, credits int, epoch ...int64) error {
	if owner == "" || operation == "" || credits < 0 {
		return Error("结算参数无效")
	}
	return WithLock(db, func(tx *gorm.DB, p *Policy) error {
		if len(epoch) > 0 {
			if err := guard(*p, epoch[0]); err != nil {
				return err
			}
		}
		if p.Clearing {
			return ErrClearing
		}
		var previous Settlement
		err := tx.First(&previous, "id = ?", Key(owner, operation)).Error
		if err == nil {
			return Error("该任务已提交，请查看任务历史，不要重复生成")
		}
		if !notFound(err) {
			return err
		}
		now := time.Now().UTC().Format(time.RFC3339Nano)
		result := tx.Model(&model.User{}).Where("id = ? AND credits >= ?", owner, credits).Updates(map[string]any{"credits": gorm.Expr("credits - ?", credits), "updated_at": now})
		if result.Error != nil {
			return result.Error
		}
		if result.RowsAffected != 1 {
			return Error("算力点不足或账号不存在")
		}
		if err := tx.Create(&Settlement{ID: Key(owner, operation), Owner: owner, Amount: credits, State: "pending", Created: timestamp(), Epoch: p.Epoch}).Error; err != nil {
			return err
		}
		return settlementLog(tx, owner, operation, modelName, path, -credits, now)
	})
}

func Refund(db *gorm.DB, owner, operation, modelName, path string, credits int) error {
	return WithLock(db, func(tx *gorm.DB, p *Policy) error {
		var debit Settlement
		if err := tx.First(&debit, "id = ? AND owner = ?", Key(owner, operation), owner).Error; err != nil {
			return err
		}
		if debit.Amount != credits {
			return Error("退款金额与扣费记录不一致，需核对")
		}
		if debit.State == "refunded" {
			return nil
		}
		if debit.State == "settled" || debit.State == "unknown" {
			return Error("任务结算结果需核对，未自动退款")
		}
		now := time.Now().UTC().Format(time.RFC3339Nano)
		result := tx.Model(&model.User{}).Where("id = ?", owner).Updates(map[string]any{"credits": gorm.Expr("credits + ?", credits), "updated_at": now})
		if result.Error != nil {
			return result.Error
		}
		if result.RowsAffected != 1 {
			return Error("退款账号不存在")
		}
		if err := settlementLog(tx, owner, operation, modelName, path, credits, now); err != nil {
			return err
		}
		return tx.Model(&debit).Update("state", "refunded").Error
	})
}

func SettlementState(db *gorm.DB, owner, operation, state string) error {
	if state != "settled" && state != "unknown" {
		return Error("结算状态无效")
	}
	return db.Model(&Settlement{}).Where("id = ? AND owner = ? AND state = ?", Key(owner, operation), owner, "pending").Update("state", state).Error
}

func settlementLog(tx *gorm.DB, owner, operation, modelName, path string, amount int, now string) error {
	if amount == 0 {
		return nil
	}
	var user model.User
	if err := tx.First(&user, "id = ?", owner).Error; err != nil {
		return err
	}
	kind := model.CreditLogTypeAIConsume
	remark := "调用模型 " + modelName
	if amount > 0 {
		kind = model.CreditLogTypeAIRefund
		remark = "模型调用失败返还 " + modelName
	}
	extra, _ := json.Marshal(map[string]string{"model": modelName, "path": path, "operationId": operation})
	return tx.Create(&model.CreditLog{ID: Key(owner, operation, string(kind)), UserID: owner, Type: kind, Amount: amount, Balance: user.Credits, Remark: remark, Extra: string(extra), CreatedAt: now}).Error
}
