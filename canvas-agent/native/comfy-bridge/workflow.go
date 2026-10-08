package main

import (
	"errors"
	"fmt"
	"math"
	"sort"
	"strconv"
	"strings"
)

func sortWorkflowList(items []jsonMap) {
	sort.Slice(items, func(i, j int) bool {
		return strings.ToLower(stringValue(items[i]["title"])) < strings.ToLower(stringValue(items[j]["title"]))
	})
}

func discoverWorkflowFields(workflow jsonMap, capability string, objectInfos ...jsonMap) []any {
	fields := make([]any, 0)
	objectInfo := jsonMap{}
	if len(objectInfos) > 0 {
		objectInfo = objectInfos[0]
	}
	nodeIDs := sortedNodeIDs(workflow)
	promptNode, promptField := findWorkflowPromptTarget(workflow, nodeIDs)
	imageOrder, videoOrder, audioOrder := 0, 0, 0
	for _, nodeID := range nodeIDs {
		node, ok := mapValue(workflow[nodeID])
		if !ok {
			continue
		}
		inputs, ok := mapValue(node["inputs"])
		if !ok {
			continue
		}
		title := ""
		if meta, ok := mapValue(node["_meta"]); ok {
			title = stringValue(meta["title"])
		}
		classType := stringValue(node["class_type"])
		if isCanvasAnnotationNode(classType) {
			continue
		}
		fieldNames := make([]string, 0, len(inputs))
		for fieldName := range inputs {
			fieldNames = append(fieldNames, fieldName)
		}
		sort.Strings(fieldNames)
		for _, fieldName := range fieldNames {
			fieldValue := inputs[fieldName]
			if isWorkflowLink(fieldValue) {
				continue
			}
			fieldType := discoveredFieldType(fieldName, fieldValue, classType)
			label := fieldName
			if title != "" {
				label = title + " · " + fieldName
			}
			field := jsonMap{"id": nodeID + "::" + fieldName, "nodeId": nodeID, "fieldName": fieldName, "fieldValue": fieldValue, "fieldType": fieldType, "label": label, "enabled": true}
			if nodeID == promptNode && fieldName == promptField {
				field["source"] = "prompt"
				field["sourceAutomatic"] = true
				field["required"] = true
			} else if source := discoveredDynamicSource(fieldName, fieldType, capability); source != "" {
				field["source"] = source
				field["sourceAutomatic"] = true
			}
			switch normalizeSourceName(stringValue(field["source"])) {
			case "referenceimage":
				imageOrder++
				field["imageOrder"] = imageOrder
				field["sourceIndex"] = imageOrder - 1
				field["required"] = imageOrder == 1
			case "referencevideo":
				field["sourceIndex"] = videoOrder
				field["required"] = videoOrder == 0
				videoOrder++
			case "referenceaudio":
				field["sourceIndex"] = audioOrder
				field["required"] = audioOrder == 0
				audioOrder++
			case "mask":
				field["required"] = false
			}
			if stringIn(normalizeSourceName(stringValue(field["source"])), "referenceimage", "referencevideo", "referenceaudio") {
				if plan, ok := discoverMediaPrunePlan(workflow, objectInfo, nodeID); ok {
					field["optionalMedia"] = true
					field["mediaDefaultMode"] = "off"
					field["mediaPrunePlan"] = plan
					if index, ok := dynamicMediaSlotIndex(plan, stringValue(field["source"])); ok {
						field["sourceIndex"] = index
						if normalizeSourceName(stringValue(field["source"])) == "referenceimage" {
							field["imageOrder"] = index + 1
						}
					}
				}
			}
			if isSeedField(fieldName) {
				field["randomEnabled"] = true
			}
			fields = append(fields, field)
		}
	}
	return fields
}

func dynamicMediaSlotIndex(plan jsonMap, source string) (int, bool) {
	prefix := map[string]string{"referenceimage": "ref_images.ref_image_", "referencevideo": "ref_videos.ref_video_", "referenceaudio": "ref_audios.ref_audio_"}[normalizeSourceName(source)]
	index := -1
	for _, raw := range sliceValue(plan["detachInputs"]) {
		detach, ok := mapValue(raw)
		if !ok || !strings.HasPrefix(stringValue(detach["fieldName"]), prefix) {
			return 0, false
		}
		current, err := strconv.Atoi(strings.TrimPrefix(stringValue(detach["fieldName"]), prefix))
		if err != nil || current < 0 || index >= 0 && index != current {
			return 0, false
		}
		index = current
	}
	return index, index >= 0
}

type workflowEdge struct {
	nodeID    string
	fieldName string
}

func discoverMediaPrunePlan(workflow, objectInfo jsonMap, loaderID string) (jsonMap, bool) {
	if _, ok := mapValue(workflow[loaderID]); !ok || len(objectInfo) == 0 {
		return nil, false
	}
	edges := make(map[string][]workflowEdge)
	for nodeID, rawNode := range workflow {
		node, ok := mapValue(rawNode)
		if !ok {
			continue
		}
		inputs, _ := mapValue(node["inputs"])
		for fieldName, value := range inputs {
			link := sliceValue(value)
			if len(link) >= 2 {
				sourceID := strings.TrimSpace(stringValue(link[0]))
				if sourceID != "" {
					edges[sourceID] = append(edges[sourceID], workflowEdge{nodeID: nodeID, fieldName: fieldName})
				}
			}
		}
	}
	for sourceID := range edges {
		sort.Slice(edges[sourceID], func(i, j int) bool {
			if edges[sourceID][i].nodeID == edges[sourceID][j].nodeID {
				return edges[sourceID][i].fieldName < edges[sourceID][j].fieldName
			}
			return edges[sourceID][i].nodeID < edges[sourceID][j].nodeID
		})
	}
	removed := map[string]bool{loaderID: true}
	active := map[string]bool{loaderID: true}
	detach := make([]any, 0)
	var walk func(string) bool
	walk = func(sourceID string) bool {
		for _, edge := range edges[sourceID] {
			if active[edge.nodeID] {
				return false
			}
			node, ok := mapValue(workflow[edge.nodeID])
			if !ok {
				return false
			}
			classType := stringValue(node["class_type"])
			requirement, known := workflowInputRequirement(objectInfo, classType, edge.fieldName)
			if !known {
				return false
			}
			if workflowOutputNode(objectInfo, classType) && normalizeSourceName(classType) != "previewimage" {
				return false
			}
			otherLinked := workflowHasOtherLinkedInput(node, edge.fieldName, sourceID)
			if requirement == "optional" && otherLinked {
				detach = append(detach, jsonMap{"nodeId": edge.nodeID, "fieldName": edge.fieldName})
				continue
			}
			if requirement == "required" && otherLinked {
				return false
			}
			if removed[edge.nodeID] {
				continue
			}
			removed[edge.nodeID] = true
			active[edge.nodeID] = true
			if !walk(edge.nodeID) {
				return false
			}
			delete(active, edge.nodeID)
		}
		return true
	}
	if !walk(loaderID) {
		return nil, false
	}
	removeNodeIDs := make([]string, 0, len(removed))
	for nodeID := range removed {
		removeNodeIDs = append(removeNodeIDs, nodeID)
	}
	sort.Strings(removeNodeIDs)
	sort.Slice(detach, func(i, j int) bool {
		left, _ := mapValue(detach[i])
		right, _ := mapValue(detach[j])
		return stringValue(left["nodeId"])+"::"+stringValue(left["fieldName"]) < stringValue(right["nodeId"])+"::"+stringValue(right["fieldName"])
	})
	return jsonMap{"removeNodeIds": removeNodeIDs, "detachInputs": detach}, true
}

func workflowHasOtherLinkedInput(node jsonMap, fieldName, sourceID string) bool {
	inputs, _ := mapValue(node["inputs"])
	for name, value := range inputs {
		if name == fieldName {
			continue
		}
		link := sliceValue(value)
		if len(link) >= 2 && stringValue(link[0]) != sourceID {
			return true
		}
	}
	return false
}

func workflowInputRequirement(objectInfo jsonMap, classType, fieldName string) (string, bool) {
	nodeInfo, ok := mapValue(objectInfo[classType])
	if !ok {
		return "", false
	}
	inputs, ok := mapValue(nodeInfo["input"])
	if !ok {
		return "", false
	}
	for _, group := range []string{"required", "optional"} {
		definitions, _ := mapValue(inputs[group])
		if _, ok := definitions[fieldName]; ok {
			return group, true
		}
		for dynamicName, rawDefinition := range definitions {
			definition := sliceValue(rawDefinition)
			if len(definition) < 2 || stringValue(definition[0]) != "COMFY_AUTOGROW_V3" {
				continue
			}
			options, _ := mapValue(definition[1])
			prefix := stringValue(options["prefix"])
			if template, ok := mapValue(options["template"]); ok && prefix == "" {
				prefix = stringValue(template["prefix"])
			}
			childName := strings.TrimPrefix(fieldName, dynamicName+".")
			if childName == fieldName || prefix == "" || !strings.HasPrefix(childName, prefix) {
				continue
			}
			index := strings.TrimPrefix(childName, prefix)
			if _, err := strconv.Atoi(index); err == nil {
				return group, true
			}
		}
	}
	return "", false
}

func workflowOutputNode(objectInfo jsonMap, classType string) bool {
	nodeInfo, ok := mapValue(objectInfo[classType])
	return ok && boolValue(nodeInfo["output_node"])
}

// discoverWorkflowGraph 将 ComfyUI 画布 JSON 压缩成网页只读预览所需的节点和连线。
// 画布 JSON 不能直接提交给 /prompt，因此预览数据必须和可执行 API JSON 分开传输。
func discoverWorkflowGraph(workflow jsonMap) jsonMap {
	rawNodes := sliceValue(workflow["nodes"])
	if len(rawNodes) == 0 {
		return nil
	}

	nodes := make([]any, 0, len(rawNodes))
	nodeIDs := make(map[string]bool, len(rawNodes))
	for _, raw := range rawNodes {
		node, ok := mapValue(raw)
		if !ok {
			continue
		}
		nodeID := strings.TrimSpace(stringValue(node["id"]))
		if nodeID == "" || nodeIDs[nodeID] {
			continue
		}
		classType := firstNonEmpty(stringValue(node["type"]), stringValue(node["class_type"]), "Unknown")
		title := stringValue(node["title"])
		if title == "" {
			if properties, ok := mapValue(node["properties"]); ok {
				title = stringValue(properties["Node name for S&R"])
			}
		}
		if title == "" {
			title = classType
		}
		nodes = append(nodes, jsonMap{"id": nodeID, "title": title, "classType": classType})
		nodeIDs[nodeID] = true
	}
	if len(nodes) == 0 {
		return nil
	}

	edges := make([]any, 0)
	edgeKeys := make(map[string]bool)
	for _, raw := range sliceValue(workflow["links"]) {
		items := sliceValue(raw)
		if len(items) < 4 {
			continue
		}
		from := strings.TrimSpace(stringValue(items[1]))
		to := strings.TrimSpace(stringValue(items[3]))
		if from == "" || to == "" || from == to || !nodeIDs[from] || !nodeIDs[to] {
			continue
		}
		key := from + ":" + to
		if edgeKeys[key] {
			continue
		}
		edgeKeys[key] = true
		edges = append(edges, jsonMap{"from": from, "to": to})
	}
	return jsonMap{"nodes": nodes, "edges": edges}
}

// convertComfyCanvasWorkflow 将 ComfyUI 保存的画布 JSON 转成 /prompt 接受的 API JSON。
// 画布节点的 link 使用全局 link ID，API 节点则直接保存 [来源节点, 输出槽位]。
// 只转换画布中明确声明的输入和 widget 默认值，避免把布局字段带入执行请求。
func convertComfyCanvasWorkflow(workflow, objectInfo jsonMap) (jsonMap, error) {
	rawNodes := sliceValue(workflow["nodes"])
	if len(rawNodes) == 0 {
		return nil, nil
	}
	links := make(map[string][]any)
	for _, raw := range sliceValue(workflow["links"]) {
		items := sliceValue(raw)
		if len(items) < 4 {
			continue
		}
		links[workflowNumberKey(items[0])] = items
	}

	converted := make(jsonMap, len(rawNodes))
	for _, raw := range rawNodes {
		node, ok := mapValue(raw)
		if !ok {
			continue
		}
		nodeID := strings.TrimSpace(stringValue(node["id"]))
		classType := strings.TrimSpace(firstNonEmpty(stringValue(node["type"]), stringValue(node["class_type"])))
		if nodeID == "" || classType == "" || isCanvasAnnotationNode(classType) {
			continue
		}
		if mode := int(numberValue(node["mode"])); mode == 2 || mode == 4 {
			return nil, fmt.Errorf("节点 %s 使用了静音或绕过模式，请从 ComfyUI 导出 API JSON", classType)
		}
		nodeInfo, ok := mapValue(objectInfo[classType])
		if !ok {
			return nil, fmt.Errorf("ComfyUI /object_info 未返回节点类型 %s，请从 ComfyUI 导出 API JSON", classType)
		}
		inputDefinitions, ok := mapValue(nodeInfo["input"])
		if !ok {
			return nil, fmt.Errorf("ComfyUI 节点 %s 缺少输入定义", classType)
		}
		inputOrder, ok := mapValue(nodeInfo["input_order"])
		if !ok {
			return nil, fmt.Errorf("ComfyUI 节点 %s 缺少 input_order", classType)
		}

		inputs := make(jsonMap)
		socketInputs := make(map[string]bool)
		widgetNames := make(map[string]string)

		for _, rawInput := range sliceValue(node["inputs"]) {
			input, ok := mapValue(rawInput)
			if !ok {
				continue
			}
			fieldName := strings.TrimSpace(stringValue(input["name"]))
			if fieldName == "" {
				continue
			}
			socketInputs[fieldName] = true
			if widget, ok := mapValue(input["widget"]); ok {
				widgetNames[fieldName] = firstNonEmpty(stringValue(widget["name"]), fieldName)
			}
			linkKey := workflowNumberKey(input["link"])
			link, exists := links[linkKey]
			if linkKey == "" || !exists {
				continue
			}
			fromNode := strings.TrimSpace(stringValue(link[1]))
			if fromNode != "" {
				inputs[fieldName] = []any{fromNode, int(numberValue(link[2]))}
			}
		}

		namedWidgets := make(jsonMap)
		if rawNamed, ok := mapValue(node["widgets_values_named"]); ok {
			for name, value := range rawNamed {
				namedWidgets[name] = value
			}
		}
		if rawNamed, ok := mapValue(node["widgets_values"]); ok {
			for name, value := range rawNamed {
				namedWidgets[name] = value
			}
		}
		widgetValues := sliceValue(node["widgets_values"])
		widgetIndex := 0

		for _, group := range []string{"required", "optional"} {
			definitions, _ := mapValue(inputDefinitions[group])
			for _, rawName := range sliceValue(inputOrder[group]) {
				fieldName := strings.TrimSpace(stringValue(rawName))
				if fieldName == "" {
					continue
				}
				_, linked := inputs[fieldName]
				spec := sliceValue(definitions[fieldName])
				if len(spec) == 0 {
					continue
				}

				inputType := strings.TrimSpace(stringValue(spec[0]))
				if strings.HasPrefix(inputType, "COMFY_") {
					return nil, fmt.Errorf("节点 %s 的动态输入 %s 需要 ComfyUI 前端转换，请导出 API JSON", classType, fieldName)
				}
				_, comboWidget := spec[0].([]any)
				widgetBacked := comboWidget
				for _, candidate := range strings.Split(inputType, ",") {
					switch strings.TrimSpace(candidate) {
					case "STRING", "INT", "FLOAT", "BOOLEAN", "COMBO":
						widgetBacked = true
					}
				}

				specOptions := jsonMap{}
				if len(spec) > 1 {
					specOptions, _ = mapValue(spec[1])
				}
				if boolValue(firstValue(specOptions["forceInput"], specOptions["force_input"])) {
					widgetBacked = false
				}
				if socketInputs[fieldName] && widgetNames[fieldName] == "" {
					widgetBacked = false
				}
				if !widgetBacked {
					continue
				}

				widgetName := firstNonEmpty(widgetNames[fieldName], fieldName)
				value, found := namedWidgets[widgetName]
				if !found && widgetName != fieldName {
					value, found = namedWidgets[fieldName]
				}
				if !found && widgetIndex < len(widgetValues) {
					value = widgetValues[widgetIndex]
					found = true
				}

				if widgetIndex < len(widgetValues) {
					widgetIndex++
					if widgetIndex < len(widgetValues) {
						control := strings.ToLower(strings.TrimSpace(stringValue(widgetValues[widgetIndex])))
						if boolValue(specOptions["control_after_generate"]) ||
							(isSeedField(fieldName) && (control == "fixed" || control == "increment" || control == "decrement" || control == "randomize")) {
							widgetIndex++
						}
					}
				}

				if linked {
					continue
				}
				if !found {
					if group == "required" {
						return nil, fmt.Errorf("节点 %s 缺少必填控件 %s 的值", classType, fieldName)
					}
					continue
				}
				if values, ok := value.([]any); ok {
					inputs[fieldName] = jsonMap{"__value__": values}
				} else {
					inputs[fieldName] = value
				}
			}
		}

		apiNode := jsonMap{"class_type": classType, "inputs": inputs}
		if title := firstNonEmpty(stringValue(node["title"]), nodeTitle(node)); title != "" {
			apiNode["_meta"] = jsonMap{"title": title}
		}
		converted[nodeID] = apiNode
	}
	if len(converted) == 0 {
		return nil, errors.New("画布 JSON 没有可执行节点")
	}
	return converted, nil
}

func isCanvasAnnotationNode(classType string) bool {
	normalized := strings.ToLower(strings.TrimSpace(classType))
	return normalized == "note" ||
		strings.HasPrefix(normalized, "note:") ||
		normalized == "markdownnote" ||
		strings.HasPrefix(normalized, "markdownnote:") ||
		// rgthree labels are canvas-only headings and must not be sent to /prompt.
		normalized == "label (rgthree)" ||
		normalized == "label" ||
		normalized == "addlabel" ||
		normalized == "fast groups bypasser (rgthree)" ||
		normalized == "fast groups bypasser"
}

func stripCanvasAnnotationNodes(workflow jsonMap) {
	for nodeID, raw := range workflow {
		node, ok := mapValue(raw)
		if !ok || !isCanvasAnnotationNode(firstNonEmpty(stringValue(node["class_type"]), stringValue(node["type"]))) {
			continue
		}
		delete(workflow, nodeID)
	}
}

func nodeTitle(node jsonMap) string {
	if properties, ok := mapValue(node["properties"]); ok {
		return stringValue(properties["Node name for S&R"])
	}
	return ""
}

func workflowNumberKey(value any) string {
	if value == nil || strings.TrimSpace(stringValue(value)) == "" {
		return ""
	}
	return strconv.FormatInt(int64(numberValue(value)), 10)
}

func sortedNodeIDs(workflow jsonMap) []string {
	items := make([]string, 0, len(workflow))
	for nodeID := range workflow {
		items = append(items, nodeID)
	}
	sort.Slice(items, func(i, j int) bool {
		left, leftErr := strconv.ParseInt(items[i], 10, 64)
		right, rightErr := strconv.ParseInt(items[j], 10, 64)
		if leftErr == nil && rightErr == nil {
			return left < right
		}
		return items[i] < items[j]
	})
	return items
}

func findWorkflowPromptTarget(workflow jsonMap, nodeIDs []string) (string, string) {
	bestNode, bestField, bestScore := "", "", math.MinInt
	for _, nodeID := range nodeIDs {
		node, ok := mapValue(workflow[nodeID])
		if !ok {
			continue
		}
		inputs, ok := mapValue(node["inputs"])
		if !ok {
			continue
		}
		classType := strings.ToLower(stringValue(node["class_type"]))
		title := ""
		if meta, ok := mapValue(node["_meta"]); ok {
			title = strings.ToLower(stringValue(meta["title"]))
		}
		for fieldName, value := range inputs {
			if _, ok := value.(string); !ok || !isPromptCandidate(fieldName, classType, title) {
				continue
			}
			descriptor := strings.ToLower(fieldName + " " + title)
			score := 0
			if strings.Contains(descriptor, "negative") || strings.Contains(descriptor, "负面") || strings.Contains(descriptor, "反向") || strings.Contains(descriptor, "负向") {
				score -= 100
			}
			if strings.Contains(descriptor, "positive") || strings.Contains(descriptor, "正面") || strings.Contains(descriptor, "正向") {
				score += 20
			}
			if strings.Contains(classType, "cliptextencode") {
				score += 5
			}
			if isPromptWorkflowField(jsonMap{"fieldName": fieldName}) {
				score += 2
			}
			if bestNode == "" || score > bestScore {
				bestNode, bestField, bestScore = nodeID, fieldName, score
			}
		}
	}
	return bestNode, bestField
}

func isPromptCandidate(fieldName, classType, title string) bool {
	key := normalizeSourceName(fieldName)
	if stringIn(key, "text", "prompt", "positiveprompt", "positive", "caption", "description") {
		return true
	}
	if strings.ToLower(fieldName) != "value" {
		return false
	}
	descriptor := classType + " " + title
	return strings.Contains(descriptor, "cliptextencode") || strings.Contains(descriptor, "text") || strings.Contains(descriptor, "string") || strings.Contains(descriptor, "prompt") || strings.Contains(descriptor, "提示词") || strings.Contains(descriptor, "文本")
}

func discoveredFieldType(fieldName string, value any, classType string) string {
	key, classKey := normalizeSourceName(fieldName), normalizeSourceName(classType)
	if strings.Contains(key, "mask") {
		return "IMAGE"
	}
	if strings.Contains(classKey, "loadimage") && stringIn(key, "image", "file", "path") {
		return "IMAGE"
	}
	if strings.Contains(classKey, "loadvideo") && stringIn(key, "video", "file", "path") {
		return "VIDEO"
	}
	if strings.Contains(classKey, "loadaudio") && stringIn(key, "audio", "file", "path") {
		return "AUDIO"
	}
	if discoveredNamedDynamicSource(fieldName, "") != "" {
		return scalarFieldType(value)
	}
	switch value.(type) {
	case bool:
		return "BOOLEAN"
	case float64, float32, int, int64:
		return "NUMBER"
	}
	if mediaFieldName(key, "image") || mediaValueType(value) == "IMAGE" {
		return "IMAGE"
	}
	if mediaFieldName(key, "video") || mediaValueType(value) == "VIDEO" {
		return "VIDEO"
	}
	if mediaFieldName(key, "audio") || mediaValueType(value) == "AUDIO" {
		return "AUDIO"
	}
	return "TEXT"
}

func mediaValueType(value any) string {
	if items := sliceValue(value); len(items) > 0 {
		value = items[0]
	}
	text := strings.ToLower(stringValue(value))
	if index := strings.IndexAny(text, "?#"); index >= 0 {
		text = text[:index]
	}
	if hasAnySuffix(text, ".png", ".jpg", ".jpeg", ".webp", ".gif", ".bmp", ".avif") {
		return "IMAGE"
	}
	if hasAnySuffix(text, ".mp4", ".webm", ".mov", ".m4v", ".mkv") {
		return "VIDEO"
	}
	if hasAnySuffix(text, ".mp3", ".wav", ".ogg", ".m4a", ".flac", ".aac") {
		return "AUDIO"
	}
	return ""
}

func discoveredDynamicSource(fieldName, fieldType, capability string) string {
	if source := discoveredNamedDynamicSource(fieldName, capability); source != "" {
		return source
	}
	switch strings.ToUpper(strings.TrimSpace(fieldType)) {
	case "IMAGE":
		return "referenceImage"
	case "VIDEO":
		return "referenceVideo"
	case "AUDIO":
		return "referenceAudio"
	default:
		return ""
	}
}

func discoveredNamedDynamicSource(fieldName, capability string) string {
	key := normalizeSourceName(fieldName)
	if strings.Contains(key, "mask") {
		return "mask"
	}
	if source := dimensionFieldSource(key); source != "" {
		return source
	}
	if stringIn(key, "ratio", "aspectratio", "imageaspectratio", "imageratio", "videoaspectratio", "videoratio") {
		return "aspectRatio"
	}
	if stringIn(key, "videoresolution", "videoquality", "vquality") {
		return "vquality"
	}
	if stringIn(key, "size", "imagesize", "imageresolution") {
		return "size"
	}
	if key == "resolution" {
		if capability == "video" {
			return "vquality"
		}
		if capability == "image" {
			return "size"
		}
	}
	aliases := map[string]string{
		"batch": "count", "batchsize": "count", "count": "count", "numimages": "count", "numberofimages": "count", "imagecount": "count", "imagescount": "count",
		"quality": "quality", "duration": "videoSeconds", "seconds": "videoSeconds", "durationseconds": "videoSeconds", "videoseconds": "videoSeconds", "videoduration": "videoSeconds", "videodurationseconds": "videoSeconds", "videolength": "videoSeconds", "clipduration": "videoSeconds",
		"generateaudio": "videoGenerateAudio", "videogenerateaudio": "videoGenerateAudio", "watermark": "videoWatermark", "videowatermark": "videoWatermark",
		"audioformat": "audioFormat", "voice": "audioVoice", "audiovoice": "audioVoice", "audiospeed": "audioSpeed", "audioinstructions": "audioInstructions",
		"transparent": "transparentBackground", "transparentbackground": "transparentBackground",
	}
	return aliases[key]
}

var dimensionPrefixes = []string{"", "image", "video", "size", "output", "target", "latent", "frame", "canvas", "source", "resolution", "final"}

func dimensionFieldSource(key string) string {
	for _, prefix := range dimensionPrefixes {
		if key == prefix+"width" {
			return "width"
		}
		if key == prefix+"height" {
			return "height"
		}
	}
	if key == "pixelwidth" || key == "widthpixels" {
		return "width"
	}
	if key == "pixelheight" || key == "heightpixels" {
		return "height"
	}
	return ""
}

func scalarFieldType(value any) string {
	switch value.(type) {
	case bool:
		return "BOOLEAN"
	case float64, float32, int, int64:
		return "NUMBER"
	default:
		return "TEXT"
	}
}

func mediaFieldName(key, mediaType string) bool {
	if key == mediaType {
		return true
	}
	for _, prefix := range []string{"input", "reference", "ref", "source", "init", "start", "end", "first", "last", "control", "controlnet", "style", "subject"} {
		if key == prefix+mediaType {
			return true
		}
	}
	for _, suffix := range []string{"file", "path", "filename", "upload"} {
		if key == mediaType+suffix {
			return true
		}
	}
	return mediaType == "image" && stringIn(key, "firstframe", "lastframe", "startframe", "endframe")
}

func isWorkflowLink(value any) bool {
	items := sliceValue(value)
	if len(items) != 2 || stringValue(items[0]) == "" {
		return false
	}
	index, ok := items[1].(float64)
	return ok && index == math.Trunc(index)
}

func isSeedField(value string) bool {
	key := normalizeSourceName(value)
	return key == "seed" || strings.HasSuffix(key, "seed") || strings.Contains(key, "noiseseed")
}

func normalizeSourceName(value string) string {
	replacer := strings.NewReplacer(" ", "", "_", "", "-", "")
	return strings.ToLower(replacer.Replace(strings.TrimSpace(value)))
}

func validateWorkflowMediaInputs(fields []any, payload jsonMap) error {
	capacities := map[string]int{"referenceimage": 0, "referencevideo": 0, "referenceaudio": 0}
	hasMask := false
	for _, raw := range fields {
		field, ok := mapValue(raw)
		if !ok || field["enabled"] == false {
			continue
		}
		source := normalizedWorkflowFieldSource(field)
		if source == "mask" {
			hasMask = true
			continue
		}
		key := canonicalMediaSource(source)
		if _, ok := capacities[key]; !ok {
			continue
		}
		index := workflowSourceIndex(field)
		if index+1 > capacities[key] {
			capacities[key] = index + 1
		}
	}
	checks := []struct {
		label string
		key   string
		value any
	}{{"参考图片", "referenceimage", payload["referenceImages"]}, {"参考视频", "referencevideo", payload["referenceVideos"]}, {"参考音频", "referenceaudio", payload["referenceAudios"]}}
	for _, check := range checks {
		count := len(sliceValue(check.value))
		if count > capacities[check.key] {
			return fmt.Errorf("工作流只配置了 %d 个%s槽位，但画布传入了 %d 个；请在字段映射中补齐槽位", capacities[check.key], check.label, count)
		}
	}
	if payload["mask"] != nil && !hasMask {
		return errors.New("画布传入了蒙版，但工作流没有配置蒙版字段映射")
	}
	return nil
}

func applyWorkflowFields(workflow jsonMap, payload jsonMap, files map[string]string, objectInfos ...jsonMap) error {
	fields := sliceValue(payload["workflowFields"])
	objectInfo := jsonMap{}
	if len(objectInfos) > 0 {
		objectInfo = objectInfos[0]
	}
	prunePlans, err := validatedMediaPrunePlans(workflow, objectInfo, fields, payload)
	if err != nil {
		return err
	}
	overrides := make(map[string]any)
	for _, raw := range sliceValue(payload["workflowOverrides"]) {
		override, ok := mapValue(raw)
		if !ok {
			continue
		}
		nodeID := firstNonEmpty(stringValue(override["nodeId"]), stringValue(override["node"]))
		fieldName := firstNonEmpty(stringValue(override["fieldName"]), stringValue(override["input"]))
		if nodeID != "" && fieldName != "" {
			overrides[nodeID+"::"+fieldName] = override["value"]
		}
	}
	removed := map[string]bool{}
	for _, raw := range fields {
		field, ok := mapValue(raw)
		if !ok || field["enabled"] == false {
			continue
		}
		nodeID := firstNonEmpty(stringValue(field["nodeId"]), stringValue(field["node"]))
		fieldName := firstNonEmpty(stringValue(field["fieldName"]), stringValue(field["input"]))
		if nodeID == "" || fieldName == "" {
			continue
		}
		node, ok := mapValue(workflow[nodeID])
		if !ok {
			if boolValue(field["required"]) {
				return fmt.Errorf("工作流缺少必填映射节点 %s", nodeID)
			}
			continue
		}
		inputs, ok := mapValue(node["inputs"])
		if !ok {
			inputs = jsonMap{}
		}
		source := normalizedWorkflowFieldSource(field)
		identity := nodeID + "::" + fieldName
		value, present := overrides[identity]
		if boolValue(field["optionalMedia"]) && isMediaSource(source) {
			mode, err := bridgeMediaSlotMode(field, payload, identity)
			if err != nil {
				return err
			}
			if mode == "off" || mode == "default" {
				continue
			}
			if !present {
				return fmt.Errorf("工作流媒体槽位 %s 已启用，但没有画布素材", identity)
			}
		}
		if present {
			if media, ok := mapValue(value); ok && stringValue(media["mediaId"]) != "" {
				value = files[stringValue(media["mediaId"])]
				if emptyWorkflowValue(value) {
					return fmt.Errorf("工作流字段 %s.%s 的素材上传结果不存在", nodeID, fieldName)
				}
			}
			inputs[fieldName] = value
		} else if isMediaSource(source) {
			delete(inputs, fieldName)
		}
		node["inputs"] = inputs
		if len(inputs) == 0 && isMediaSource(source) {
			removed[nodeID] = true
		}
	}
	for nodeID := range removed {
		delete(workflow, nodeID)
	}
	if len(removed) > 0 {
		for _, rawNode := range workflow {
			node, ok := mapValue(rawNode)
			if !ok {
				continue
			}
			inputs, _ := mapValue(node["inputs"])
			for fieldName, value := range inputs {
				link := sliceValue(value)
				if len(link) > 0 && removed[stringValue(link[0])] {
					delete(inputs, fieldName)
				}
			}
		}
	}
	return applyValidatedMediaPrunePlans(workflow, prunePlans)
}

func validatedMediaPrunePlans(workflow, objectInfo jsonMap, fields []any, payload jsonMap) ([]jsonMap, error) {
	plans := make([]jsonMap, 0)
	for _, raw := range fields {
		field, ok := mapValue(raw)
		if !ok || field["enabled"] == false || !boolValue(field["optionalMedia"]) || !isMediaSource(normalizedWorkflowFieldSource(field)) {
			continue
		}
		nodeID := firstNonEmpty(stringValue(field["nodeId"]), stringValue(field["node"]))
		fieldName := firstNonEmpty(stringValue(field["fieldName"]), stringValue(field["input"]))
		identity := nodeID + "::" + fieldName
		mode, err := bridgeMediaSlotMode(field, payload, identity)
		if err != nil {
			return nil, err
		}
		if mode != "off" {
			continue
		}
		saved, ok := mapValue(field["mediaPrunePlan"])
		expected, safe := discoverMediaPrunePlan(workflow, objectInfo, nodeID)
		if !ok || !safe || !sameMediaPrunePlan(saved, expected) {
			return nil, fmt.Errorf("媒体槽位 %s 的裁枝计划已失效，请重新拉取工作流参数", identity)
		}
		plans = append(plans, saved)
	}
	return plans, nil
}

func bridgeMediaSlotMode(field, payload jsonMap, identity string) (string, error) {
	modes, _ := mapValue(payload["mediaSlotModes"])
	mode := strings.TrimSpace(stringValue(modes[identity]))
	if mode == "" {
		mode = strings.TrimSpace(stringValue(field["mediaDefaultMode"]))
	}
	if mode == "" {
		mode = "canvas"
	}
	if !stringIn(mode, "off", "canvas", "default") {
		return "", fmt.Errorf("工作流媒体槽位 %s 的模式无效：%s", identity, mode)
	}
	return mode, nil
}

func sameMediaPrunePlan(left, right jsonMap) bool {
	leftNodes, leftDetach, leftOK := normalizedMediaPrunePlan(left)
	rightNodes, rightDetach, rightOK := normalizedMediaPrunePlan(right)
	return leftOK && rightOK && strings.Join(leftNodes, "\x00") == strings.Join(rightNodes, "\x00") && strings.Join(leftDetach, "\x00") == strings.Join(rightDetach, "\x00")
}

func normalizedMediaPrunePlan(plan jsonMap) ([]string, []string, bool) {
	nodes := make([]string, 0)
	seen := map[string]bool{}
	var rawNodes []string
	switch values := plan["removeNodeIds"].(type) {
	case []string:
		rawNodes = values
	case []any:
		for _, value := range values {
			rawNodes = append(rawNodes, stringValue(value))
		}
	default:
		return nil, nil, false
	}
	for _, raw := range rawNodes {
		nodeID := strings.TrimSpace(raw)
		if nodeID == "" || seen[nodeID] {
			return nil, nil, false
		}
		seen[nodeID] = true
		nodes = append(nodes, nodeID)
	}
	if len(nodes) == 0 {
		return nil, nil, false
	}
	detach := make([]string, 0)
	seen = map[string]bool{}
	for _, raw := range sliceValue(plan["detachInputs"]) {
		input, ok := mapValue(raw)
		if !ok {
			return nil, nil, false
		}
		key := strings.TrimSpace(stringValue(input["nodeId"])) + "::" + strings.TrimSpace(stringValue(input["fieldName"]))
		if key == "::" || seen[key] {
			return nil, nil, false
		}
		seen[key] = true
		detach = append(detach, key)
	}
	sort.Strings(nodes)
	sort.Strings(detach)
	return nodes, detach, true
}

func applyValidatedMediaPrunePlans(workflow jsonMap, plans []jsonMap) error {
	removed := map[string]bool{}
	for _, plan := range plans {
		nodes, _, _ := normalizedMediaPrunePlan(plan)
		for _, nodeID := range nodes {
			removed[nodeID] = true
		}
	}
	for nodeID := range removed {
		delete(workflow, nodeID)
	}
	for _, plan := range plans {
		_, detachInputs, _ := normalizedMediaPrunePlan(plan)
		for _, key := range detachInputs {
			nodeID, fieldName, _ := strings.Cut(key, "::")
			if removed[nodeID] {
				continue
			}
			node, ok := mapValue(workflow[nodeID])
			if !ok {
				return errors.New("媒体裁枝目标已失效，请重新拉取工作流参数")
			}
			inputs, ok := mapValue(node["inputs"])
			if !ok {
				return errors.New("媒体裁枝输入已失效，请重新拉取工作流参数")
			}
			delete(inputs, fieldName)
		}
	}
	for nodeID, rawNode := range workflow {
		node, _ := mapValue(rawNode)
		inputs, _ := mapValue(node["inputs"])
		for fieldName, value := range inputs {
			link := sliceValue(value)
			if len(link) > 0 && removed[stringValue(link[0])] {
				return fmt.Errorf("媒体裁枝后仍有悬空连接 %s.%s，请重新拉取工作流参数", nodeID, fieldName)
			}
		}
	}
	return nil
}

func normalizedWorkflowFieldSource(field jsonMap) string {
	source := stringValue(field["source"])
	if source == "" && (boolValue(field["bindPrompt"]) || boolValue(field["bind_prompt"])) {
		source = "prompt"
	}
	if source == "" && (boolValue(field["sourceFromUpstream"]) || boolValue(field["source_from_upstream"])) {
		fieldType := strings.ToLower(firstNonEmpty(stringValue(field["fieldType"]), stringValue(field["type"])))
		switch fieldType {
		case "image":
			source = "referenceImage"
		case "video":
			source = "referenceVideo"
		case "audio":
			source = "referenceAudio"
		default:
			if isPromptWorkflowField(field) {
				source = "prompt"
			}
		}
	}
	return normalizeSourceName(source)
}

func isPromptWorkflowField(field jsonMap) bool {
	for _, key := range []string{"fieldName", "input", "label", "name"} {
		if stringIn(normalizeSourceName(stringValue(field[key])), "prompt", "text", "positiveprompt", "caption", "description", "提示词", "正向提示词") {
			return true
		}
	}
	return false
}

func emptyWorkflowValue(value any) bool {
	return value == nil || (func() bool { text, ok := value.(string); return ok && strings.TrimSpace(text) == "" })()
}

func workflowSourceIndex(field jsonMap) int {
	if order := int(numberValue(field["imageOrder"])); order > 0 {
		return order - 1
	}
	index := int(numberValue(field["sourceIndex"]))
	if index < 0 {
		return 0
	}
	return index
}

func canonicalMediaSource(source string) string {
	switch source {
	case "image", "referenceimages":
		return "referenceimage"
	case "video", "referencevideos":
		return "referencevideo"
	case "audio", "referenceaudios":
		return "referenceaudio"
	default:
		return source
	}
}

func isMediaSource(source string) bool {
	return stringIn(source, "referenceimage", "referenceimages", "image", "referencevideo", "referencevideos", "video", "referenceaudio", "referenceaudios", "audio", "mask")
}

func stringIn(value string, candidates ...string) bool {
	for _, candidate := range candidates {
		if value == candidate {
			return true
		}
	}
	return false
}

func hasAnySuffix(value string, suffixes ...string) bool {
	for _, suffix := range suffixes {
		if strings.HasSuffix(value, suffix) {
			return true
		}
	}
	return false
}
