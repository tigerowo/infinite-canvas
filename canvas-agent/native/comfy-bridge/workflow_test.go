package main

import (
	"fmt"
	"testing"
)

func mediaTestObjectInfo() jsonMap {
	return jsonMap{
		"LoadImage": jsonMap{"input": jsonMap{"required": jsonMap{"image": []any{"STRING"}}}},
		"LoadAudio": jsonMap{"input": jsonMap{"required": jsonMap{"audio": []any{"STRING"}}}},
		"Scale":     jsonMap{"input": jsonMap{"required": jsonMap{"image": []any{"IMAGE"}}}},
		"Merge":     jsonMap{"input": jsonMap{"required": jsonMap{"image_a": []any{"IMAGE"}, "image_b": []any{"IMAGE"}}}},
		"Target":    jsonMap{"input": jsonMap{"required": jsonMap{"core": []any{"MODEL"}}, "optional": jsonMap{"image": []any{"IMAGE"}}}},
		"DynamicTarget": jsonMap{"input": jsonMap{"required": jsonMap{"core": []any{"MODEL"}}, "optional": jsonMap{
			"ref_images": []any{"COMFY_AUTOGROW_V3", jsonMap{"template": jsonMap{"input": jsonMap{"required": jsonMap{"ref_image": []any{"IMAGE"}}}}, "prefix": "ref_image_"}},
			"ref_audios": []any{"COMFY_AUTOGROW_V3", jsonMap{"template": jsonMap{"input": jsonMap{"required": jsonMap{"ref_audio": []any{"AUDIO"}}}}, "prefix": "ref_audio_"}},
		}}},
		"Save":         jsonMap{"input": jsonMap{"required": jsonMap{"images": []any{"IMAGE"}}}, "output_node": true},
		"PreviewImage": jsonMap{"input": jsonMap{"required": jsonMap{"images": []any{"IMAGE"}}}, "output_node": true},
	}
}

func TestDiscoverMediaPrunePlan(t *testing.T) {
	tests := []struct {
		name       string
		workflow   jsonMap
		loaderID   string
		wantOK     bool
		wantRemove []string
		wantDetach []any
	}{
		{"direct optional input", jsonMap{"1": jsonMap{"class_type": "LoadImage", "inputs": jsonMap{"image": "a.png"}}, "2": jsonMap{"class_type": "Target", "inputs": jsonMap{"core": []any{"9", 0.0}, "image": []any{"1", 0.0}}}, "9": jsonMap{"class_type": "Core", "inputs": jsonMap{}}}, "1", true, []string{"1"}, []any{jsonMap{"nodeId": "2", "fieldName": "image"}}},
		{"required chain", jsonMap{"1": jsonMap{"class_type": "LoadImage", "inputs": jsonMap{"image": "a.png"}}, "2": jsonMap{"class_type": "Scale", "inputs": jsonMap{"image": []any{"1", 0.0}}}, "3": jsonMap{"class_type": "Target", "inputs": jsonMap{"core": []any{"9", 0.0}, "image": []any{"2", 0.0}}}, "9": jsonMap{"class_type": "Core", "inputs": jsonMap{}}}, "1", true, []string{"1", "2"}, []any{jsonMap{"nodeId": "3", "fieldName": "image"}}},
		{"safe fanout", jsonMap{"1": jsonMap{"class_type": "LoadImage", "inputs": jsonMap{"image": "a.png"}}, "2": jsonMap{"class_type": "Scale", "inputs": jsonMap{"image": []any{"1", 0.0}}}, "3": jsonMap{"class_type": "Scale", "inputs": jsonMap{"image": []any{"1", 0.0}}}, "4": jsonMap{"class_type": "Target", "inputs": jsonMap{"core": []any{"9", 0.0}, "image": []any{"2", 0.0}}}, "5": jsonMap{"class_type": "Target", "inputs": jsonMap{"core": []any{"9", 0.0}, "image": []any{"3", 0.0}}}, "9": jsonMap{"class_type": "Core", "inputs": jsonMap{}}}, "1", true, []string{"1", "2", "3"}, []any{jsonMap{"nodeId": "4", "fieldName": "image"}, jsonMap{"nodeId": "5", "fieldName": "image"}}},
		{"shared required branch", jsonMap{"1": jsonMap{"class_type": "LoadImage", "inputs": jsonMap{"image": "a.png"}}, "2": jsonMap{"class_type": "Merge", "inputs": jsonMap{"image_a": []any{"1", 0.0}, "image_b": []any{"9", 0.0}}}, "9": jsonMap{"class_type": "LoadImage", "inputs": jsonMap{"image": "b.png"}}}, "1", false, nil, nil},
		{"output node", jsonMap{"1": jsonMap{"class_type": "LoadImage", "inputs": jsonMap{"image": "a.png"}}, "2": jsonMap{"class_type": "Save", "inputs": jsonMap{"images": []any{"1", 0.0}}}}, "1", false, nil, nil},
		{"preview sink", jsonMap{"1": jsonMap{"class_type": "LoadImage", "inputs": jsonMap{"image": "a.png"}}, "2": jsonMap{"class_type": "PreviewImage", "inputs": jsonMap{"images": []any{"1", 0.0}}}}, "1", true, []string{"1", "2"}, []any{}},
		{"unknown input", jsonMap{"1": jsonMap{"class_type": "LoadImage", "inputs": jsonMap{"image": "a.png"}}, "2": jsonMap{"class_type": "Unknown", "inputs": jsonMap{"image": []any{"1", 0.0}}}}, "1", false, nil, nil},
		{"cycle", jsonMap{"1": jsonMap{"class_type": "LoadImage", "inputs": jsonMap{"image": "a.png"}}, "2": jsonMap{"class_type": "Scale", "inputs": jsonMap{"image": []any{"1", 0.0}, "loop": []any{"3", 0.0}}}, "3": jsonMap{"class_type": "Scale", "inputs": jsonMap{"image": []any{"2", 0.0}}}}, "1", false, nil, nil},
		{"dynamic image", jsonMap{"1": jsonMap{"class_type": "LoadImage", "inputs": jsonMap{"image": "a.png"}}, "2": jsonMap{"class_type": "DynamicTarget", "inputs": jsonMap{"core": []any{"9", 0.0}, "ref_images.ref_image_2": []any{"1", 0.0}}}, "9": jsonMap{"class_type": "Core", "inputs": jsonMap{}}}, "1", true, []string{"1"}, []any{jsonMap{"nodeId": "2", "fieldName": "ref_images.ref_image_2"}}},
		{"dynamic audio", jsonMap{"1": jsonMap{"class_type": "LoadAudio", "inputs": jsonMap{"audio": "a.wav"}}, "2": jsonMap{"class_type": "DynamicTarget", "inputs": jsonMap{"core": []any{"9", 0.0}, "ref_audios.ref_audio_1": []any{"1", 0.0}}}, "9": jsonMap{"class_type": "Core", "inputs": jsonMap{}}}, "1", true, []string{"1"}, []any{jsonMap{"nodeId": "2", "fieldName": "ref_audios.ref_audio_1"}}},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			plan, ok := discoverMediaPrunePlan(tt.workflow, mediaTestObjectInfo(), tt.loaderID)
			if ok != tt.wantOK {
				t.Fatalf("ok=%v plan=%#v", ok, plan)
			}
			if !ok {
				return
			}
			if !sameJSON(plan["removeNodeIds"], tt.wantRemove) || !sameJSON(plan["detachInputs"], tt.wantDetach) {
				t.Fatalf("plan=%#v want remove=%#v detach=%#v", plan, tt.wantRemove, tt.wantDetach)
			}
		})
	}
}

func TestDiscoverWorkflowFieldsAddsSafeMediaPrunePlan(t *testing.T) {
	workflow := jsonMap{"1": jsonMap{"class_type": "LoadImage", "inputs": jsonMap{"image": "a.png"}}, "2": jsonMap{"class_type": "Target", "inputs": jsonMap{"core": []any{"9", 0.0}, "image": []any{"1", 0.0}}}, "9": jsonMap{"class_type": "Core", "inputs": jsonMap{}}}
	fields := discoverWorkflowFields(workflow, "video", mediaTestObjectInfo())
	field, _ := mapValue(fields[0])
	if !boolValue(field["optionalMedia"]) || stringValue(field["mediaDefaultMode"]) != "off" || field["mediaPrunePlan"] == nil {
		t.Fatalf("安全媒体字段未附带可选裁枝计划：%#v", field)
	}
}

func sameJSON(left, right any) bool {
	return fmt.Sprintf("%#v", left) == fmt.Sprintf("%#v", right)
}

func TestWorkflowFieldsKeepOriginalBridgeExecution(t *testing.T) {
	workflow := jsonMap{
		"1": jsonMap{"class_type": "LoadImage", "inputs": jsonMap{"image": "old.png"}},
		"2": jsonMap{"class_type": "KSampler", "inputs": jsonMap{"image": []any{"1", float64(0)}, "steps": float64(20)}},
		"3": jsonMap{"class_type": "CLIPTextEncode", "inputs": jsonMap{"text": "old"}},
	}
	fields := []any{jsonMap{"nodeId": "1", "fieldName": "image", "source": "referenceImage", "sourceIndex": float64(0), "enabled": true}, jsonMap{"nodeId": "2", "fieldName": "steps", "source": "count", "enabled": true}}
	payload := jsonMap{"workflowFields": fields, "referenceImages": []any{}, "workflowOverrides": []any{jsonMap{"nodeId": "2", "fieldName": "steps", "value": float64(5)}}}
	if err := validateWorkflowMediaInputs(fields, payload); err != nil {
		t.Fatal(err)
	}
	if err := applyWorkflowFields(workflow, payload, map[string]string{}); err != nil {
		t.Fatal(err)
	}
	if _, exists := workflow["1"]; exists {
		t.Fatal("缺失的可选素材节点未删除")
	}
	inputs := workflow["2"].(jsonMap)["inputs"].(jsonMap)
	if _, exists := inputs["image"]; exists {
		t.Fatal("已删除素材节点的连接未清理")
	}
	if inputs["steps"] != float64(5) {
		t.Fatalf("工作流业务字段未传入：%#v", workflow)
	}
}
