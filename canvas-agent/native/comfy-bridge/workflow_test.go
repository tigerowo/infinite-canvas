package main

import (
	"fmt"
	"strings"
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
			"ref_images": []any{"COMFY_AUTOGROW_V3", jsonMap{"template": jsonMap{"input": jsonMap{"required": jsonMap{"ref_image": []any{"IMAGE"}}}, "prefix": "ref_image_"}}},
			"ref_audios": []any{"COMFY_AUTOGROW_V3", jsonMap{"template": jsonMap{"input": jsonMap{"required": jsonMap{"ref_audio": []any{"AUDIO"}}}, "prefix": "ref_audio_"}}},
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

func TestDiscoverWorkflowFieldsUsesDynamicMediaSlotIndex(t *testing.T) {
	workflow := jsonMap{
		"1": jsonMap{"class_type": "LoadImage", "inputs": jsonMap{"image": "a.png"}},
		"2": jsonMap{"class_type": "DynamicTarget", "inputs": jsonMap{"core": []any{"9", 0.0}, "ref_images.ref_image_5": []any{"1", 0.0}}},
		"9": jsonMap{"class_type": "Core", "inputs": jsonMap{}},
	}
	fields := discoverWorkflowFields(workflow, "video", mediaTestObjectInfo())
	field, _ := mapValue(fields[0])
	if field["sourceIndex"] != 5 || field["imageOrder"] != 6 {
		t.Fatalf("动态媒体槽位索引错误：%#v", field)
	}
}

func TestApplyOptionalMediaPrunePlans(t *testing.T) {
	base := func() (jsonMap, []any) {
		workflow := jsonMap{
			"1": jsonMap{"class_type": "LoadImage", "inputs": jsonMap{"image": "one.png"}},
			"2": jsonMap{"class_type": "Target", "inputs": jsonMap{"core": []any{"9", 0.0}, "image": []any{"1", 0.0}}},
			"3": jsonMap{"class_type": "LoadImage", "inputs": jsonMap{"image": "two.png"}},
			"4": jsonMap{"class_type": "Target", "inputs": jsonMap{"core": []any{"9", 0.0}, "image": []any{"3", 0.0}}},
			"9": jsonMap{"class_type": "Core", "inputs": jsonMap{}},
		}
		fields := []any{
			optionalMediaTestField("1", 0, jsonMap{"removeNodeIds": []any{"1"}, "detachInputs": []any{jsonMap{"nodeId": "2", "fieldName": "image"}}}),
			optionalMediaTestField("3", 1, jsonMap{"removeNodeIds": []any{"3"}, "detachInputs": []any{jsonMap{"nodeId": "4", "fieldName": "image"}}}),
		}
		return workflow, fields
	}
	t.Run("all off", func(t *testing.T) {
		workflow, fields := base()
		payload := jsonMap{"workflowFields": fields, "mediaSlotModes": jsonMap{"1::image": "off", "3::image": "off"}}
		if err := applyWorkflowFields(workflow, payload, map[string]string{}, mediaTestObjectInfo()); err != nil {
			t.Fatal(err)
		}
		if workflow["1"] != nil || workflow["3"] != nil || workflow["2"].(jsonMap)["inputs"].(jsonMap)["image"] != nil || workflow["4"].(jsonMap)["inputs"].(jsonMap)["image"] != nil {
			t.Fatalf("全部关闭后仍残留媒体分支：%#v", workflow)
		}
	})
	t.Run("fresh discovery plan", func(t *testing.T) {
		workflow, _ := base()
		fields := discoverWorkflowFields(workflow, "video", mediaTestObjectInfo())
		if err := applyWorkflowFields(workflow, jsonMap{"workflowFields": fields}, map[string]string{}, mediaTestObjectInfo()); err != nil {
			t.Fatal(err)
		}
		if workflow["1"] != nil || workflow["3"] != nil {
			t.Fatalf("Bridge 当次发现的 []string 计划未执行：%#v", workflow)
		}
	})
	t.Run("partial off", func(t *testing.T) {
		workflow, fields := base()
		payload := jsonMap{"workflowFields": fields, "mediaSlotModes": jsonMap{"1::image": "off", "3::image": "canvas"}, "workflowOverrides": []any{jsonMap{"nodeId": "3", "fieldName": "image", "value": jsonMap{"mediaId": "image:1"}}}}
		if err := applyWorkflowFields(workflow, payload, map[string]string{"image:1": "uploaded.png"}, mediaTestObjectInfo()); err != nil {
			t.Fatal(err)
		}
		if workflow["1"] != nil || workflow["3"].(jsonMap)["inputs"].(jsonMap)["image"] != "uploaded.png" {
			t.Fatalf("部分关闭或画布覆盖错误：%#v", workflow)
		}
	})
	t.Run("canvas and default keep branches", func(t *testing.T) {
		workflow, fields := base()
		payload := jsonMap{"workflowFields": fields, "mediaSlotModes": jsonMap{"1::image": "canvas", "3::image": "default"}, "workflowOverrides": []any{jsonMap{"nodeId": "1", "fieldName": "image", "value": jsonMap{"mediaId": "image:0"}}}}
		if err := applyWorkflowFields(workflow, payload, map[string]string{"image:0": "uploaded.png"}, mediaTestObjectInfo()); err != nil {
			t.Fatal(err)
		}
		if workflow["1"].(jsonMap)["inputs"].(jsonMap)["image"] != "uploaded.png" || workflow["3"].(jsonMap)["inputs"].(jsonMap)["image"] != "two.png" {
			t.Fatalf("canvas/default 未保留各自语义：%#v", workflow)
		}
	})
	for _, tc := range []struct {
		name string
		plan jsonMap
	}{
		{"stale node", jsonMap{"removeNodeIds": []any{"1", "999"}, "detachInputs": []any{jsonMap{"nodeId": "2", "fieldName": "image"}}}},
		{"stale detach", jsonMap{"removeNodeIds": []any{"1"}, "detachInputs": []any{jsonMap{"nodeId": "2", "fieldName": "missing"}}}},
	} {
		t.Run(tc.name, func(t *testing.T) {
			workflow, fields := base()
			fields[0].(jsonMap)["mediaPrunePlan"] = tc.plan
			err := applyWorkflowFields(workflow, jsonMap{"workflowFields": fields, "mediaSlotModes": jsonMap{"1::image": "off", "3::image": "default"}}, map[string]string{}, mediaTestObjectInfo())
			if err == nil || !strings.Contains(err.Error(), "重新拉取工作流参数") {
				t.Fatalf("失效计划必须在提交前拒绝，err=%v", err)
			}
		})
	}
	t.Run("dangling link", func(t *testing.T) {
		workflow, fields := base()
		workflow["5"] = jsonMap{"class_type": "Unknown", "inputs": jsonMap{"image": []any{"1"}}}
		err := applyWorkflowFields(workflow, jsonMap{"workflowFields": fields, "mediaSlotModes": jsonMap{"1::image": "off", "3::image": "default"}}, map[string]string{}, mediaTestObjectInfo())
		if err == nil || !strings.Contains(err.Error(), "悬空连接") {
			t.Fatalf("裁枝后悬空连接必须阻止提交，err=%v", err)
		}
	})
}

func optionalMediaTestField(nodeID string, sourceIndex int, plan jsonMap) jsonMap {
	return jsonMap{"nodeId": nodeID, "fieldName": "image", "source": "referenceImage", "sourceIndex": float64(sourceIndex), "enabled": true, "optionalMedia": true, "mediaDefaultMode": "off", "mediaPrunePlan": plan}
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
