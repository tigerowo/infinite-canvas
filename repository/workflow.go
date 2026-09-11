package repository

import (
	"errors"
	medialifecycle "github.com/tigerowo/infinite-canvas/extensions/media-lifecycle"

	"github.com/tigerowo/infinite-canvas/model"
	"gorm.io/gorm"
)

func ListCreativeWorkflows(userID string) ([]model.CreativeWorkflow, error) {
	db, err := DB()
	if err != nil {
		return nil, err
	}
	var workflows []model.CreativeWorkflow
	err = db.Where("scope = ? OR owner_user_id = ?", "public", userID).Order("updated_at DESC").Find(&workflows).Error
	return workflows, err
}

func GetCreativeWorkflow(id string) (model.CreativeWorkflow, bool, error) {
	db, err := DB()
	if err != nil {
		return model.CreativeWorkflow{}, false, err
	}
	var workflow model.CreativeWorkflow
	err = db.First(&workflow, "id = ?", id).Error
	if err != nil {
		if errors.Is(err, gorm.ErrRecordNotFound) {
			return model.CreativeWorkflow{}, false, nil
		}
		return model.CreativeWorkflow{}, false, err
	}
	return workflow, true, nil
}

func SaveCreativeWorkflow(workflow model.CreativeWorkflow) (model.CreativeWorkflow, error) {
	db, err := DB()
	if err != nil {
		return workflow, err
	}
	return workflow, medialifecycle.SaveRecord(db,&workflow)
}

func DeleteCreativeWorkflow(id string) error {
	db, err := DB()
	if err != nil {
		return err
	}
	var workflow model.CreativeWorkflow
	if err:=db.First(&workflow,"id = ?",id).Error;err!=nil{if errors.Is(err,gorm.ErrRecordNotFound){return nil};return err}
	return medialifecycle.Release(db,workflow.OwnerUserID,"workflow",id,0,func(tx *gorm.DB)error{return tx.Delete(&model.CreativeWorkflow{},"id = ?",id).Error})
}
