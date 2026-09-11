package medialifecycle

import "testing"

func TestDraftUnchangedSaveDoesNotRenewAndRejectsConcurrentOverwrite(t *testing.T) {
	db := testDB(t)
	id := upload(t, db, "a", "one")
	version := int64(0)
	input := Use{Owner: "a", Kind: "draft", ID: "composer", Epoch: 1, Version: &version, Content: "content-1", Files: []string{id}, OperationID: "save-1"}
	first, err := SaveUse(db, input, nil)
	if err != nil {
		t.Fatal(err)
	}
	version = first.Entity.Version
	age(t, db)
	input.OperationID = "save-2"
	unchanged, err := SaveUse(db, input, nil)
	if err != nil {
		t.Fatal(err)
	}
	if unchanged.Entity.Activity > timestamp()-30*Day || unchanged.Entity.Version != version {
		t.Fatal("unchanged draft renewed")
	}
	input.Content, input.OperationID = "content-2", "edit"
	edited, err := SaveUse(db, input, nil)
	if err != nil {
		t.Fatal(err)
	}
	if edited.Entity.Activity < timestamp()-1000 {
		t.Fatal("real edit did not renew")
	}
	input.Content, input.OperationID = "stale-other-browser", "other-browser"
	if _, err := SaveUse(db, input, nil); err != ErrConflict {
		t.Fatalf("concurrent overwrite accepted: %v", err)
	}
	input.Content, input.OperationID = "content-1", "save-1"
	replay, err := SaveUse(db, input, nil)
	if err != nil || replay.Entity.Version != first.Entity.Version {
		t.Fatalf("retry acquired a newer version: %+v %v", replay, err)
	}
	input.ID = "another-composer"
	if _, err := SaveUse(db, input, nil); err != ErrConflict {
		t.Fatalf("operation reused for another entity: %v", err)
	}
}

func TestPromotionProtectsBeforeReleaseAndReplayCannotRemoveNewReferences(t *testing.T) {
	db := testDB(t)
	id := upload(t, db, "a", "one")
	version := int64(0)
	draft := Use{Owner: "a", Kind: "draft", ID: "composer", Epoch: 1, Version: &version, Content: "first", Files: []string{id}, OperationID: "save"}
	saved, err := SaveUse(db, draft, nil)
	if err != nil {
		t.Fatal(err)
	}
	version = saved.Entity.Version
	submit := Use{Owner: "a", ID: "request", Epoch: 1, OperationID: "submit", Files: []string{id}}
	result, err := Promote(db, submit, draft.ID, &version)
	if err != nil {
		t.Fatal(err)
	}
	var count int64
	db.Model(&Reference{}).Where("entity_key = ?", Key("a", "request", "request")).Count(&count)
	if count != 1 || result.Entity.Protection < timestamp()+Day-1000 {
		t.Fatal("durable protection missing")
	}
	db.Model(&Reference{}).Where("entity_key = ?", Key("a", "draft", "composer")).Count(&count)
	if count != 0 {
		t.Fatal("submitted draft edge retained")
	}
	draft.Content, draft.OperationID = "late queued save", "late"
	if _, err := SaveUse(db, draft, nil); err != ErrConflict {
		t.Fatalf("queued save restored submitted edge: %v", err)
	}
	version = result.Draft.Version
	draft.Content, draft.OperationID = "new edit using reference", "new-edit"
	if _, err := SaveUse(db, draft, nil); err != nil {
		t.Fatal(err)
	}
	if _, err := Promote(db, submit, draft.ID, &version); err != nil {
		t.Fatal(err)
	}
	db.Model(&Reference{}).Where("entity_key = ?", Key("a", "draft", "composer")).Count(&count)
	if count != 1 {
		t.Fatal("old submission replay removed a new draft reference")
	}
}

func TestPromotionFailureRollsBackProtectionAndDraftRelease(t *testing.T) {
	db := testDB(t)
	id := upload(t, db, "a", "one")
	if _, err := SaveUse(db, Use{Owner: "a", Kind: "draft", ID: "draft", Epoch: 1, Files: []string{id}}, nil); err != nil {
		t.Fatal(err)
	}
	wrongVersion := int64(50)
	if _, err := Promote(db, Use{Owner: "a", ID: "task", Epoch: 1, OperationID: "submit", Files: []string{id}}, "draft", &wrongVersion); err != ErrConflict {
		t.Fatal(err)
	}
	var count int64
	db.Model(&Entity{}).Where("kind = ?", "request").Count(&count)
	if count != 0 {
		t.Fatal("failed promotion left durable request")
	}
	db.Model(&Reference{}).Where("entity_key = ?", Key("a", "draft", "draft")).Count(&count)
	if count != 1 {
		t.Fatal("failed promotion released draft")
	}
}
