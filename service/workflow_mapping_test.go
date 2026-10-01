package service

import (
	"encoding/json"
	"strings"
	"testing"

	"github.com/tigerowo/infinite-canvas/model"
)

func TestResolveWorkflowFieldsLegacyMedia(t *testing.T) {
	enabled := true
	entry := model.WorkflowEntry{Fields: []model.WorkflowFieldMapping{{NodeID: "217", FieldName: "image", Source: "referenceImage", Required: true, Enabled: &enabled}}}
	_, err := ResolveWorkflowFields(entry, WorkflowRunInput{})
	if err == nil || !strings.Contains(err.Error(), "必填字段 217::image 缺少值") {
		t.Fatalf("旧媒体字段缺少素材时仍应保持必填校验，err=%v", err)
	}
}

func TestWorkflowRunInputMediaSlotModes(t *testing.T) {
	var input WorkflowRunInput
	if err := json.Unmarshal([]byte(`{"mediaSlotModes":{"217::image":"off"}}`), &input); err != nil {
		t.Fatal(err)
	}
	if input.MediaSlotModes["217::image"] != "off" {
		t.Fatalf("槽位模式未按稳定字段身份解析：%#v", input.MediaSlotModes)
	}
}

func TestResolveWorkflowFieldsAllowsWorkflowsWithoutPrompt(t *testing.T) {
	enabled := true
	entry := model.WorkflowEntry{Provider: "comfyui", Capability: "image", Fields: []model.WorkflowFieldMapping{{NodeID: "1", FieldName: "seed", FieldType: "NUMBER", FieldValue: 42, Enabled: &enabled}}, WorkflowJSON: map[string]any{"1": map[string]any{"inputs": map[string]any{"seed": float64(1)}}}}
	values, err := ResolveWorkflowFields(entry, WorkflowRunInput{})
	if err != nil || len(values) != 1 || values[0].Value != float64(42) {
		t.Fatalf("无提示词工作流应使用配置的字段值，values=%#v err=%v", values, err)
	}
}

func TestResolveWorkflowFieldsRequiredPrompt(t *testing.T) {
	enabled := true
	entry := model.WorkflowEntry{Fields: []model.WorkflowFieldMapping{{NodeID: "1", FieldName: "text", Source: "prompt", Required: true, Enabled: &enabled}}}
	_, err := ResolveWorkflowFields(entry, WorkflowRunInput{})
	if err == nil || !strings.Contains(err.Error(), "必填") {
		t.Fatalf("必填提示词缺失时应报错，err=%v", err)
	}
}

func TestResolveWorkflowFieldsMediaCannotBeReplacedByFieldValue(t *testing.T) {
	enabled := true
	entry := model.WorkflowEntry{Fields: []model.WorkflowFieldMapping{{NodeID: "1", FieldName: "image", Source: "referenceImage", Enabled: &enabled}}}
	input := WorkflowRunInput{ReferenceImages: []string{"data:image/png;base64,AQ=="}, FieldValues: map[string]any{"field:1:image": "https://example.com/other.png"}}
	values, err := ResolveWorkflowFields(entry, input)
	if err != nil || len(values) != 1 {
		t.Fatalf("素材映射应使用引用槽位，values=%#v err=%v", values, err)
	}
	media, ok := values[0].Value.(map[string]any)
	if !ok || media["mediaId"] != "image:0" {
		t.Fatalf("素材引用被任意字段值覆盖：%#v", values[0].Value)
	}
}

func TestResolveWorkflowFieldsRejectsUnmappedMedia(t *testing.T) {
	entry := model.WorkflowEntry{Provider: "comfyui"}
	_, err := ResolveWorkflowFields(entry, WorkflowRunInput{ReferenceImages: []string{"data:image/png;base64,AQ=="}})
	if err == nil || !strings.Contains(err.Error(), "没有对应") {
		t.Fatalf("未配置的素材槽位不能静默丢弃，err=%v", err)
	}
}

func TestResolveWorkflowFieldsSkipsConnectedInput(t *testing.T) {
	enabled := true
	entry := model.WorkflowEntry{Fields: []model.WorkflowFieldMapping{{NodeID: "2", FieldName: "image", FieldValue: "replacement", Enabled: &enabled}}, WorkflowJSON: map[string]any{"2": map[string]any{"inputs": map[string]any{"image": []any{"1", float64(0)}}}}}
	values, err := ResolveWorkflowFields(entry, WorkflowRunInput{})
	if err != nil || len(values) != 0 {
		t.Fatalf("已连接的节点输入应保留原拓扑，values=%#v err=%v", values, err)
	}
}

func TestRunningHubManagementFieldsKeepFourImageSlots(t *testing.T) {
	workflow := map[string]any{
		"11": map[string]any{"class_type": "LoadImage", "inputs": map[string]any{"image": "a.png"}},
		"12": map[string]any{"class_type": "LoadImage", "inputs": map[string]any{"image": "b.png"}},
		"13": map[string]any{"class_type": "LoadImage", "inputs": map[string]any{"image": "c.png"}},
		"15": map[string]any{"class_type": "LoadImage", "inputs": map[string]any{"image": "d.png"}},
		"14": map[string]any{"class_type": "RH_Image", "inputs": map[string]any{"aspectRatio": "9:16", "prompt": "", "resolution": "1k", "seed": float64(1), "skip_error": false}},
		"16": map[string]any{"class_type": "SaveImage", "inputs": map[string]any{"filename_prefix": "ComfyUI", "images": []any{"14", float64(0)}}},
	}
	fields := discoverWorkflowFields(workflow, "image")
	enabled, imageOrder := 0, 0
	for _, field := range fields {
		if field.Enabled != nil && *field.Enabled {
			enabled++
		}
		if field.Source == "referenceImage" {
			imageOrder++
			if field.ImageOrder != imageOrder || field.SourceIndex != imageOrder-1 {
				t.Fatalf("图片素材槽位错误：%#v", field)
			}
		}
	}
	if len(fields) != 10 || enabled != 8 || imageOrder != 4 {
		t.Fatalf("字段/启用/素材数量不匹配：%d/%d/%d", len(fields), enabled, imageOrder)
	}
	entry := model.WorkflowEntry{Provider: "runninghub", Capability: "image", Fields: fields, WorkflowJSON: workflow}
	refs := []string{"data:image/png;base64,AQ==", "data:image/png;base64,AQ==", "data:image/png;base64,AQ==", "data:image/png;base64,AQ=="}
	values, err := ResolveWorkflowFields(entry, WorkflowRunInput{Prompt: "测试", ReferenceImages: refs})
	if err != nil {
		t.Fatalf("四张图片必须全部映射：%v", err)
	}
	media := 0
	for _, value := range values {
		if _, ok := value.Value.(map[string]any); ok {
			media++
		}
	}
	if media != 4 {
		t.Fatalf("四张图片映射数量错误：%d", media)
	}
}

func TestResolveWorkflowFieldsSkipsRunningHubInternalInput(t *testing.T) {
	enabled := true
	entry := model.WorkflowEntry{Provider: "runninghub", Fields: []model.WorkflowFieldMapping{{NodeID: "1", FieldName: "width", Source: "width", Enabled: &enabled}}, WorkflowJSON: map[string]any{"1": map[string]any{"class_type": "ImageResize+", "inputs": map[string]any{"width": float64(512)}}}}
	values, err := ResolveWorkflowFields(entry, WorkflowRunInput{Size: "1024x1024"})
	if err != nil || len(values) != 0 {
		t.Fatalf("RunningHub 内部尺寸节点应保留原拓扑，values=%#v err=%v", values, err)
	}
}

func TestResolveWorkflowFieldsUsesFullAspectRatioOption(t *testing.T) {
	enabled := true
	entry := model.WorkflowEntry{Fields: []model.WorkflowFieldMapping{{NodeID: "1", FieldName: "aspect_ratio", Source: "aspectRatio", Options: []any{"16:9 (Widescreen)", "9:16 (Portrait)"}, Enabled: &enabled}}}
	values, err := ResolveWorkflowFields(entry, WorkflowRunInput{Size: "16:9-1k"})
	if err != nil || len(values) != 1 || values[0].Value != "16:9 (Widescreen)" {
		t.Fatalf("比例必须转成工作流枚举的完整值，values=%#v err=%v", values, err)
	}
}

func TestRunningHubProtocolFieldTranslations(t *testing.T) {
	enabled := true
	entry := model.WorkflowEntry{Provider: "runninghub", Capability: "image", Fields: []model.WorkflowFieldMapping{
		{NodeID: "1", ClassType: "ResolutionSelector", FieldName: "aspectRatio", Source: "aspectRatio", Enabled: &enabled},
		{NodeID: "2", FieldName: "width", Source: "width", Enabled: &enabled},
	}}
	values, err := ResolveWorkflowFields(entry, WorkflowRunInput{Size: "9:16-1k"})
	if err != nil || len(values) != 2 || values[0].Value != "9:16 (Portrait Widescreen)" || values[1].Value != "1024" {
		t.Fatalf("RunningHub 比例和宽度未按原协议转换：values=%#v err=%v", values, err)
	}
	entry.Capability = "video"
	entry.Fields = []model.WorkflowFieldMapping{
		{NodeID: "1", FieldName: "resolution", Source: "vquality", Options: []any{"720p", "1080p"}, Enabled: &enabled},
		{NodeID: "2", FieldName: "duration", Source: "videoSeconds", Options: []any{"5s", "10s"}, Enabled: &enabled},
	}
	values, err = ResolveWorkflowFields(entry, WorkflowRunInput{VideoQuality: "720", VideoSeconds: "5"})
	if err != nil || len(values) != 2 || values[0].Value != "720p" || values[1].Value != "5s" {
		t.Fatalf("RunningHub 视频清晰度和时长未按工作流选项转换：values=%#v err=%v", values, err)
	}
}

func TestRunningHubNestedStatus(t *testing.T) {
	code, ok := runningHubResponseCode(map[string]any{"code": float64(0), "data": map[string]any{"status": "running"}})
	if !ok || code != 804 {
		t.Fatalf("排队/运行状态不能被外层成功码覆盖：code=%d valid=%v", code, ok)
	}
}

func TestRunningHubRandomSeedIgnoresTestDefault(t *testing.T) {
	enabled := true
	entry := model.WorkflowEntry{Provider: "runninghub", Fields: []model.WorkflowFieldMapping{{NodeID: "1", FieldName: "seed", FieldType: "NUMBER", FieldValue: 1, Min: 7, Max: 7, RandomEnabled: true, Enabled: &enabled}}}
	values, err := ResolveWorkflowFields(entry, WorkflowRunInput{FieldValues: map[string]any{"field:1:seed": 999}})
	if err != nil || len(values) != 1 || values[0].Value != float64(7) {
		t.Fatalf("随机种子不应被测试画布默认值覆盖：values=%#v err=%v", values, err)
	}
}

func TestComfyWorkflowPayloadMediaAndFieldValues(t *testing.T) {
	entry := model.WorkflowEntry{Capability: "image", Fields: []model.WorkflowFieldMapping{{NodeID: "1", FieldName: "steps", Source: "count", FieldValue: 20}, {NodeID: "2", FieldName: "image", Source: "referenceImage"}, {NodeID: "3", FieldName: "mask", Source: "mask"}}}
	input := WorkflowRunInput{FieldValues: map[string]any{"field:1:steps": 12}, ReferenceImages: []string{"https://example.com/ref.png"}, Mask: "data:image/png;base64,AQ=="}
	overrides, err := ResolveWorkflowFields(entry, input)
	if err != nil {
		t.Fatal(err)
	}
	payload := comfyWorkflowPayload(entry, input, overrides)
	fields := payload["workflowFields"].([]model.WorkflowFieldMapping)
	queuedOverrides := payload["workflowOverrides"].([]WorkflowOverride)
	if fields[0].Source != "count" || fields[0].FieldValue != 20 || fields[1].Source != "referenceImage" || queuedOverrides[0].Value != 12 {
		t.Fatalf("Bridge 字段值或素材来源被错误改写：%#v", fields)
	}
	images := payload["referenceImages"].([]map[string]any)
	mask := payload["mask"].(map[string]any)
	if images[0]["url"] != "https://example.com/ref.png" || images[0]["dataUrl"] != nil || mask["id"] != "mask" || mask["dataUrl"] != "data:image/png;base64,AQ==" {
		t.Fatalf("Bridge 参考素材协议不匹配：images=%#v mask=%#v", images, mask)
	}
}

func TestResolveWorkflowFieldsValidatesRangeOption(t *testing.T) {
	enabled := true
	entry := model.WorkflowEntry{Fields: []model.WorkflowFieldMapping{{NodeID: "1", FieldName: "steps", FieldType: "NUMBER", FieldValue: 9, Options: []any{map[string]any{"range": map[string]any{"min": 2, "max": 8, "step": 2}}}, Enabled: &enabled}}}
	_, err := ResolveWorkflowFields(entry, WorkflowRunInput{})
	if err == nil || !strings.Contains(err.Error(), "超出") {
		t.Fatalf("必须执行字段选项中的数值范围校验，err=%v", err)
	}
}

func TestWorkflowResultURLs(t *testing.T) {
	urls, err := workflowResultURLs(`{"images":[{"url":"http://127.0.0.1:8189/outputs/0123456789abcdef"}],"video":{"url":""}}`)
	if err != nil || len(urls) != 1 || urls[0] != "http://127.0.0.1:8189/outputs/0123456789abcdef" {
		t.Fatalf("Bridge 结果解析错误，urls=%#v err=%v", urls, err)
	}
}
