package repository

import (
	"errors"
	"strings"
	medialifecycle "github.com/tigerowo/infinite-canvas/extensions/media-lifecycle"

	"github.com/tigerowo/infinite-canvas/model"
	"gorm.io/gorm"
	"gorm.io/gorm/clause"
)

func ListUserCanvasProjects(userID string) ([]model.CanvasProject, error) {
	db, err := DB()
	if err != nil {
		return nil, err
	}

	var projects []model.CanvasProject
	err = db.Where(
		"user_id = ? AND deleted_at = ''",
		strings.TrimSpace(userID),
	).Order("updated_at DESC").Find(&projects).Error
	return projects, err
}

func SaveUserCanvasProject(
	project model.CanvasProject,
	baseUpdatedAt ...*string,
) (model.CanvasProject, error) {
	db, err := DB()
	if err != nil {
		return project, err
	}
	var saved model.CanvasProject
	err = medialifecycle.WithLock(db,func(tx *gorm.DB,p *medialifecycle.Policy)error{
		var saveErr error
		saved,saveErr = saveCanvasProject(tx,project,baseUpdatedAt...)
		if saveErr != nil { return saveErr }
		if saved.DeletedAt != "" { return nil }
		return medialifecycle.TrackRecord(tx,*p,&saved)
	})
	return saved,err
}

func saveCanvasProject(db *gorm.DB,project model.CanvasProject,baseUpdatedAt ...*string)(model.CanvasProject,error){

	project.UserID = strings.TrimSpace(project.UserID)
	project.ID = strings.TrimSpace(project.ID)

	var current model.CanvasProject
	err := db.First(
		&current,
		"user_id = ? AND id = ?",
		project.UserID,
		project.ID,
	).Error
	if errors.Is(err, gorm.ErrRecordNotFound) {
		if len(baseUpdatedAt) > 0 && baseUpdatedAt[0] != nil && *baseUpdatedAt[0] != "" {
			return current, canvasSyncError("画布版本已更新，请重新同步")
		}
		return project, db.Create(&project).Error
	}
	if err != nil {
		return project, err
	}
	if len(baseUpdatedAt) > 0 && baseUpdatedAt[0] != nil && (current.DeletedAt != "" || current.UpdatedAt != *baseUpdatedAt[0] || project.UpdatedAt <= current.UpdatedAt) {
		return current, canvasSyncError("画布版本已更新，请重新同步")
	}
	if current.DeletedAt != "" || current.UpdatedAt > project.UpdatedAt {
		return current, nil
	}

	query := db.Model(&model.CanvasProject{})
	if len(baseUpdatedAt) > 0 && baseUpdatedAt[0] != nil {
		query = query.Where("updated_at = ?", *baseUpdatedAt[0])
	}
	result := query.
		Where(
			"user_id = ? AND id = ? AND deleted_at = '' AND updated_at <= ?",
			project.UserID,
			project.ID,
			project.UpdatedAt,
		).
		Updates(map[string]any{
			"project_data": project.ProjectData,
			"updated_at":   project.UpdatedAt,
		})
	if result.Error != nil {
		return project, result.Error
	}
	if result.RowsAffected == 0 {
		if len(baseUpdatedAt) > 0 && baseUpdatedAt[0] != nil {
			return current, canvasSyncError("画布版本已更新，请重新同步")
		}
		if err := db.First(
			&current,
			"user_id = ? AND id = ?",
			project.UserID,
			project.ID,
		).Error; err != nil {
			return project, err
		}
		return current, nil
	}
	return project, nil
}

type canvasSyncError string

func (err canvasSyncError) Error() string       { return string(err) }
func (err canvasSyncError) SafeMessage() string { return string(err) }

func SaveUserCanvasProjects(
	userID string,
	projects []model.CanvasProject,
) ([]model.CanvasProject, error) {
	for _, project := range projects {
		project.UserID = userID
		if _, err := SaveUserCanvasProject(project); err != nil {
			return nil, err
		}
	}
	return ListUserCanvasProjects(userID)
}

func SoftDeleteUserCanvasProjects(
	userID string,
	ids []string,
	deletedAt string,
) error {
	ids = uniqueTrimmedValues(ids...)
	if len(ids) == 0 {
		return nil
	}

	db, err := DB()
	if err != nil {
		return err
	}

	records := make([]model.CanvasProject, 0, len(ids))
	for _, id := range ids {
		records = append(records, model.CanvasProject{
			UserID:    strings.TrimSpace(userID),
			ID:        id,
			CreatedAt: deletedAt,
			UpdatedAt: deletedAt,
			DeletedAt: deletedAt,
		})
	}

	return medialifecycle.WithLock(db,func(tx *gorm.DB,p *medialifecycle.Policy)error{
	if p.Clearing { return medialifecycle.ErrClearing }
	for _,id:=range ids{
		key:=medialifecycle.Key(userID,"canvas",id)
		if err:=tx.Model(&medialifecycle.Entity{}).Where("entity_key = ?",key).Updates(map[string]any{"state":medialifecycle.Deleted,"version":gorm.Expr("version + 1")}).Error;err!=nil{return err}
		if err:=tx.Where("entity_key = ?",key).Delete(&medialifecycle.Reference{}).Error;err!=nil{return err}
	}
	return tx.Clauses(clause.OnConflict{
		Columns: []clause.Column{
			{Name: "user_id"},
			{Name: "id"},
		},
		DoUpdates: clause.AssignmentColumns([]string{
			"project_data",
			"updated_at",
			"deleted_at",
		}),
	}).Create(&records).Error
	})
}

func CleanupDeletedCanvasProjects(before string) error {
	db, err := DB()
	if err != nil {
		return err
	}

	// Keep the lightweight tombstone: old browsers can return after any cleanup window.
	return db.Where(
		"deleted_at <> '' AND deleted_at < ?",
		before,
	).Model(&model.CanvasProject{}).Update("project_data", "").Error
}
