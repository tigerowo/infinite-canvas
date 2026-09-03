package handler

import (
	"encoding/base64"
	"encoding/json"
	"errors"
	"net/http"
	"strings"

	"github.com/tigerowo/infinite-canvas/service"
)

type mimoTTSProxyRequest struct {
	Model               string `json:"model"`
	Input               string `json:"input"`
	Voice               string `json:"voice"`
	ResponseFormat      string `json:"response_format"`
	Instructions        string `json:"instructions"`
	VoiceDesignPrompt   string `json:"mimo_voice_design_prompt"`
	VoiceCloneAudioData string `json:"mimo_voice_clone_audio"`
}

func normalizeMiMoTTSBody(body []byte, contentType string, modelName string) ([]byte, string, error) {
	if !strings.Contains(strings.ToLower(contentType), "application/json") {
		return nil, "", errors.New("MiMo TTS 仅支持 JSON 请求")
	}
	var input mimoTTSProxyRequest
	if err := json.Unmarshal(body, &input); err != nil {
		return nil, "", err
	}
	input.Model = strings.TrimSpace(firstNonEmpty(input.Model, modelName))
	input.Input = strings.TrimSpace(input.Input)
	if input.Input == "" {
		return nil, "", errors.New("MiMo TTS 缺少播报文本")
	}

	messages := make([]map[string]string, 0, 2)
	format := strings.ToLower(strings.TrimSpace(input.ResponseFormat))
	if format == "" {
		format = "wav"
	}
	if format != "wav" && format != "mp3" {
		return nil, "", errors.New("MiMo TTS 当前仅支持 WAV 或 MP3 输出")
	}
	audio := map[string]any{"format": format}
	switch strings.ToLower(input.Model) {
	case "mimo-v2.5-tts":
		if instructions := strings.TrimSpace(input.Instructions); instructions != "" {
			messages = append(messages, map[string]string{"role": "user", "content": instructions})
		}
		voice := strings.TrimSpace(input.Voice)
		if voice == "" {
			voice = "冰糖"
		}
		audio["voice"] = voice
	case "mimo-v2.5-tts-voicedesign":
		description := strings.TrimSpace(input.VoiceDesignPrompt)
		if description == "" {
			return nil, "", errors.New("MiMo VoiceDesign 缺少音色描述")
		}
		messages = append(messages, map[string]string{"role": "user", "content": description})
	case "mimo-v2.5-tts-voiceclone":
		if instructions := strings.TrimSpace(input.Instructions); instructions != "" {
			messages = append(messages, map[string]string{"role": "user", "content": instructions})
		}
		reference := strings.TrimSpace(input.VoiceCloneAudioData)
		if reference == "" {
			return nil, "", errors.New("MiMo VoiceClone 缺少参考音频")
		}
		audio["voice"] = reference
	default:
		return nil, "", errors.New("不支持的 MiMo TTS 模型")
	}
	messages = append(messages, map[string]string{"role": "assistant", "content": input.Input})

	payload := map[string]any{
		"model":    input.Model,
		"messages": messages,
		"audio":    audio,
	}
	encoded, err := json.Marshal(payload)
	if err != nil {
		return nil, "", err
	}
	return encoded, "application/json", nil
}

func copyMiMoTTSResponse(w http.ResponseWriter, response *http.Response, logContext aiLogContext, onFailure func()) bool {
	if logContext.Endpoint != "/audio/speech" || !service.IsMiMoTTSModelName(logContext.Model) {
		return false
	}
	payload, err := readLimitedUpstreamResponse(response.Body, "MiMo TTS", mimoTTSResponseLimit)
	if err != nil {
		if onFailure != nil {
			onFailure()
		}
		saveAIProxyLog(logContext, response.StatusCode, "", err.Error())
		Fail(w, "MiMo TTS 响应读取失败")
		return true
	}
	var root struct {
		Choices []struct {
			Message struct {
				Audio *struct {
					Data string `json:"data"`
				} `json:"audio"`
			} `json:"message"`
		} `json:"choices"`
	}
	if err := json.Unmarshal(payload, &root); err != nil || len(root.Choices) == 0 || root.Choices[0].Message.Audio == nil || strings.TrimSpace(root.Choices[0].Message.Audio.Data) == "" {
		if onFailure != nil {
			onFailure()
		}
		saveAIProxyLog(logContext, response.StatusCode, string(payload), "MiMo TTS 未返回音频数据")
		Fail(w, "MiMo TTS 未返回音频数据")
		return true
	}
	audioBytes, err := base64.StdEncoding.DecodeString(root.Choices[0].Message.Audio.Data)
	if err != nil {
		if onFailure != nil {
			onFailure()
		}
		saveAIProxyLog(logContext, response.StatusCode, "[invalid base64 audio]", err.Error())
		Fail(w, "MiMo TTS 音频解码失败")
		return true
	}
	mimeType := http.DetectContentType(audioBytes)
	if mimeType == "audio/wave" {
		mimeType = "audio/wav"
	}
	w.Header().Set("Content-Type", mimeType)
	w.Header().Del("Content-Length")
	w.WriteHeader(response.StatusCode)
	_, _ = w.Write(audioBytes)
	saveAIProxyLog(logContext, response.StatusCode, "[binary audio]", "")
	return true
}
