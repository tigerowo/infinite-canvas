package medialifecycle

import (
	"testing"
)

func TestShorterPolicyRequiresMatchingPreview(t *testing.T) {
	db := testDB(t)
	file := upload(t, db, "a", "preview-policy")
	if err := db.Model(&File{}).Where("id = ?", file).Update("activity", timestamp()-20*Day).Error; err != nil {
		t.Fatal(err)
	}
	db.Model(&Entity{}).Where("owner = ?", "a").Update("activity", timestamp()-20*Day)
	p, err := GetPolicy(db)
	if err != nil {
		t.Fatal(err)
	}
	p.Days = 10
	if _, err := UpdatePolicy(db, p); err == nil {
		t.Fatal("shorter retention was accepted without preview")
	}
	preview, err := PreviewPolicyChange(db, p)
	if err != nil {
		t.Fatal(err)
	}
	if preview.AdditionalFiles != 1 {
		t.Fatalf("missing newly expired file: %+v", preview)
	}
	changed := p
	changed.Days = 5
	if _, err := UpdatePolicy(db, changed, preview.ID); err == nil {
		t.Fatal("preview accepted for a different policy")
	}
	if _, err := UpdatePolicy(db, p, preview.ID); err != nil {
		t.Fatal(err)
	}
}

func TestPolicyPreviewRejectsChangedCandidates(t *testing.T) {
	db := testDB(t)
	file := upload(t, db, "a", "changed-candidate")
	db.Model(&File{}).Where("id = ?", file).Update("activity", timestamp()-20*Day)
	db.Model(&Entity{}).Where("owner = ?", "a").Update("activity", timestamp()-20*Day)
	p, _ := GetPolicy(db)
	p.Days = 10
	preview, err := PreviewPolicyChange(db, p)
	if err != nil {
		t.Fatal(err)
	}
	if err := db.Model(&File{}).Where("id = ?", file).Update("version", 999).Error; err != nil {
		t.Fatal(err)
	}
	if _, err := UpdatePolicy(db, p, preview.ID); err == nil {
		t.Fatal("candidate changed since preview")
	}
}

func TestForeverToRetentionAndEnablingDeletionNeedPreview(t *testing.T) {
	db := testDB(t)
	p, _ := GetPolicy(db)
	p.Mode, p.Execution = "forever", "observe"
	p, err := UpdatePolicy(db, p)
	if err != nil {
		t.Fatal(err)
	}
	p.Mode = "retention"
	if _, err := UpdatePolicy(db, p); err == nil {
		t.Fatal("forever data entered retention without a preview")
	}
	preview, err := PreviewPolicyChange(db, p)
	if err != nil {
		t.Fatal(err)
	}
	p, err = UpdatePolicy(db, p, preview.ID)
	if err != nil {
		t.Fatal(err)
	}
	p.Execution = "enforce"
	if _, err := UpdatePolicy(db, p); err == nil {
		t.Fatal("deletion enabled without preview")
	}
}
