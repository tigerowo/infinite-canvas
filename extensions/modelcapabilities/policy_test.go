package modelcapabilities

import "testing"

func TestNewAPIVideoProfiles(t *testing.T) {
	p, err := validatePolicy(Policy{ImageTransfer: "url", NewAPIVideoProfiles: map[string]string{" gateway :: Model ": "canvas-v1"}})
	if err != nil || p.NewAPIVideoProfiles["gateway::model"] != "canvas-v1" {
		t.Fatalf("normalization: %+v %v", p, err)
	}
	for _, profiles := range []map[string]string{{"model": "canvas-v1"}, {"::model": "canvas-v1"}, {"gateway::model": "canvas-v2"}, {"gateway::model": "canvas-v1", "gateway::MODEL": "canvas-v1"}} {
		if _, err := validatePolicy(Policy{ImageTransfer: "url", NewAPIVideoProfiles: profiles}); err == nil {
			t.Fatalf("accepted invalid profile: %+v", profiles)
		}
	}
	if _, err := validatePolicy(Policy{ImageTransfer: "base64"}); err != nil {
		t.Fatal("old policy must remain valid", err)
	}
}
