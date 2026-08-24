package service

import (
	"context"
	"encoding/json"
	"errors"
	"io"
	"net/http"
	"regexp"
	"strconv"
	"strings"
	"time"

	"github.com/tigerowo/infinite-canvas/model"
	"github.com/tigerowo/infinite-canvas/repository"
)

const (
	gptImage2RawBase              = "https://raw.githubusercontent.com/tigerowo/awesome-gpt-image-2-prompts/main"
	awesomeGptImageRawBase        = "https://raw.githubusercontent.com/ZeroLu/awesome-gpt-image/main"
	awesomeGpt4oImagePromptsBase  = "https://raw.githubusercontent.com/ImgEdify/Awesome-GPT4o-Image-Prompts/main"
	youMindGptImage2RawBase       = "https://raw.githubusercontent.com/YouMind-OpenLab/awesome-gpt-image-2/main"
	youMindNanoBananaProRawBase   = "https://raw.githubusercontent.com/YouMind-OpenLab/awesome-nano-banana-pro-prompts/main"
	xianyuAwesomeGptImage2RawBase = "https://raw.githubusercontent.com/xianyu110/awesome-gptimage2/main"
	davidWuGptImage2RawBase       = "https://raw.githubusercontent.com/davidwuw0811-boop/awesome-gpt-image2-prompts/main"
)

var gptImage2CaseFiles = []string{"README.md", "cases/ad-creative.md", "cases/character.md", "cases/comparison.md", "cases/ecommerce.md", "cases/portrait.md", "cases/poster.md", "cases/ui.md"}

var promptSyncReadLimits = upstreamReadLimits{
	MaxRequests: 32,
	MaxBytes:    32 * 1024 * 1024,
	Deadline:    2 * time.Minute,
}

type gptImage2Data struct {
	Records []struct {
		Title    string `json:"title"`
		TweetURL string `json:"tweet_url"`
		ImageDir string `json:"image_dir"`
		Category string `json:"category"`
		AddedAt  string `json:"added_at"`
	} `json:"records"`
}

type xianyuLatestPromptData struct {
	Dates []struct {
		Items []xianyuLatestPrompt `json:"items"`
	} `json:"dates"`
	Items []xianyuLatestPrompt `json:"items"`
}

type xianyuLatestPrompt struct {
	XURL            string   `json:"x_url"`
	URL             string   `json:"url"`
	Author          string   `json:"author"`
	CreatedAt       string   `json:"created_at"`
	Text            string   `json:"text"`
	Prompt          string   `json:"prompt"`
	Reason          string   `json:"reason"`
	ImageURLs       []string `json:"image_urls"`
	PrimaryImageURL string   `json:"primary_image_url"`
}
type davidWuGptImage2Prompt struct {
	ID         int    `json:"id"`
	TitleEN    string `json:"title_en"`
	TitleCN    string `json:"title_cn"`
	Category   string `json:"category"`
	CategoryCN string `json:"category_cn"`
	Prompt     string `json:"prompt"`
	Note       string `json:"note"`
	Author     string `json:"author"`
	Source     string `json:"source"`
	NeedsRef   bool   `json:"needs_ref"`
	Image      string `json:"image"`
}

func SyncPromptCategory(ctx context.Context, category string) ([]model.PromptCategory, error) {
	budget := newUpstreamReadBudget(ctx, "提示词同步", promptSyncReadLimits)
	defer budget.Close()
	return syncPromptCategoryWithBudget(category, budget)
}

func syncPromptCategoryWithBudget(category string, budget *upstreamReadBudget) ([]model.PromptCategory, error) {
	for _, item := range repository.PromptCategories() {
		if item.Category != category {
			continue
		}
		if err := budget.Check(); err != nil {
			return nil, err
		}
		items, err := buildPromptCategory(item.Category, budget)
		if err != nil {
			return nil, err
		}
		if err := budget.Check(); err != nil {
			return nil, err
		}
		if err := repository.ReplacePromptCategory(item, items); err != nil {
			return nil, err
		}
		return repository.ListPromptCategories()
	}
	return nil, errors.New("未知提示词分类")
}

func buildPromptCategory(category string, budget *upstreamReadBudget) ([]model.Prompt, error) {
	switch category {
	case "gpt-image-2-prompts":
		return buildGptImage2Prompts(budget)
	case "awesome-gpt-image":
		return buildAwesomeGptImagePrompts(budget)
	case "awesome-gpt4o-image-prompts":
		return buildAwesomeGpt4oImagePrompts(budget)
	case "xianyu-awesome-gptimage2":
		return buildXianyuAwesomeGptImage2Prompts(budget)
	case "youmind-gpt-image-2":
		return buildYouMindGptImage2Prompts(budget)
	case "youmind-nano-banana-pro":
		return buildYouMindNanoBananaProPrompts(budget)
	case "davidwu-gpt-image2-prompts":
		return buildDavidWuGptImage2Prompts(budget)
	}
	return nil, errors.New("未知提示词分类")
}

func fetchText(budget *upstreamReadBudget, baseURL, file string) (string, error) {
	request, err := http.NewRequestWithContext(budget.Context(), http.MethodGet, baseURL+"/"+file, nil)
	if err != nil {
		return "", err
	}
	client := budget.HTTPClient(SafeProxyHTTPClientWithTimeout(30 * time.Second))
	response, err := client.Do(request)
	if err != nil {
		return "", normalizeUpstreamBudgetError(err)
	}
	defer response.Body.Close()
	if response.StatusCode < 200 || response.StatusCode >= 300 {
		return "", errors.New(file + " 拉取失败")
	}
	data, err := io.ReadAll(response.Body)
	return string(data), normalizeUpstreamBudgetError(err)
}

type gptImage2Case struct {
	prompt string
	image  string
}

func buildGptImage2Prompts(budget *upstreamReadBudget) ([]model.Prompt, error) {
	cases := map[string]gptImage2Case{}
	raw, err := fetchText(budget, gptImage2RawBase, "data/ingested_tweets.json")
	if err != nil {
		return nil, err
	}
	data := gptImage2Data{}
	if err := json.Unmarshal([]byte(raw), &data); err != nil {
		return nil, err
	}
	for _, file := range gptImage2CaseFiles {
		markdown, err := fetchText(budget, gptImage2RawBase, file)
		if err != nil {
			return nil, err
		}
		collectGptImage2Cases(cases, markdown)
	}
	items := []model.Prompt{}
	for _, item := range data.Records {
		c := cases[item.TweetURL]
		if c.prompt == "" {
			c = cases[item.ImageDir]
		}
		if c.prompt == "" {
			continue
		}
		image := c.image
		date := normalizePromptTime(item.AddedAt)
		items = append(items, model.Prompt{ID: "gpt-image-2-prompts-" + leftPad(len(items)+1), Title: item.Title, CoverURL: image, Prompt: c.prompt, Tags: tagsFromCategory(item.Category), CreatedAt: date, UpdatedAt: date, Preview: markdownPreview([]string{image})})
	}
	return items, nil
}

func collectGptImage2Cases(cases map[string]gptImage2Case, markdown string) {
	re := regexp.MustCompile("(?s)### Case \\d+: \\[[^\\]]+\\]\\(([^)]+)\\).*?\\*\\*Prompt:\\*\\*\\s*\\r?\\n\\s*```[\\w-]*\\r?\\n(.*?)\\r?\\n```")
	reImageDir := regexp.MustCompile(`images/\w+_case\d+`)
	reImage := regexp.MustCompile(`<img[^>]+src="([^"]+)"|!\[[^\]]*\]\(([^)]+)\)`)
	for _, match := range re.FindAllStringSubmatch(markdown, -1) {
		prompt := strings.TrimSpace(match[2])
		image := ""
		if imgMatch := reImage.FindStringSubmatch(match[0]); imgMatch != nil {
			if imgMatch[1] != "" {
				image = absoluteImage(gptImage2RawBase, imgMatch[1])
			} else {
				image = absoluteImage(gptImage2RawBase, imgMatch[2])
			}
		}
		item := gptImage2Case{prompt: prompt, image: image}
		cases[match[1]] = item
		if dir := reImageDir.FindString(match[0]); dir != "" {
			cases[dir] = item
		}
	}
}

func buildAwesomeGptImagePrompts(budget *upstreamReadBudget) ([]model.Prompt, error) {
	markdown, err := fetchText(budget, awesomeGptImageRawBase, "README.md")
	if err != nil {
		return nil, err
	}
	items := []model.Prompt{}
	for _, section := range splitBeforeHeading(markdown, "## ") {
		tags := tagsFromHeading(firstMatch(section, `(?m)^##\s+(.+)$`))
		for _, block := range splitBeforeHeading(section, "### ") {
			title := strings.TrimSpace(regexp.MustCompile(`\[([^\]]+)]\([^)]+\)`).ReplaceAllString(firstMatch(block, `(?m)^###\s+(.+)$`), "$1"))
			prompt := strings.TrimSpace(firstMatch(block, "(?s)\\*\\*Prompt:\\*\\*\\s*\\r?\\n\\s*```[\\w-]*\\r?\\n(.*?)\\r?\\n```"))
			if title == "" || prompt == "" {
				continue
			}
			images := extractMarkdownImages(awesomeGptImageRawBase, block)
			cover := ""
			if len(images) > 0 {
				cover = images[0]
			}
			items = append(items, model.Prompt{ID: "awesome-gpt-image-" + leftPad(len(items)+1), Title: title, CoverURL: cover, Prompt: prompt, Tags: tags, Preview: markdownPreview(images)})
		}
	}
	return items, nil
}

func buildAwesomeGpt4oImagePrompts(budget *upstreamReadBudget) ([]model.Prompt, error) {
	markdown, err := fetchText(budget, awesomeGpt4oImagePromptsBase, "README.zh-CN.md")
	if err != nil {
		return nil, err
	}
	items := []model.Prompt{}
	for _, block := range splitBeforeHeading(markdown, "### ") {
		title := strings.TrimSpace(firstMatch(block, `(?m)^###\s+(.+)$`))
		prompt := strings.TrimSpace(firstMatch(block, "(?s)- \\*\\*提示词文本：\\*\\*\\s*`(.*?)`"))
		if title == "" || prompt == "" {
			continue
		}
		images := extractMarkdownImages(awesomeGpt4oImagePromptsBase, block)
		cover := ""
		if len(images) > 0 {
			cover = images[0]
		}
		items = append(items, model.Prompt{ID: "awesome-gpt4o-image-prompts-" + leftPad(len(items)+1), Title: title, CoverURL: cover, Prompt: prompt, Tags: []string{"gpt4o"}, Preview: markdownPreview(images)})
	}
	return items, nil
}

func buildXianyuAwesomeGptImage2Prompts(budget *upstreamReadBudget) ([]model.Prompt, error) {
	markdown, err := fetchText(budget, xianyuAwesomeGptImage2RawBase, "README.md")
	if err != nil {
		return nil, err
	}
	items := parseXianyuPromptCollection(markdown)
	latest, err := buildXianyuLatestXPrompts(budget, len(items))
	if err != nil {
		return nil, err
	}
	items = append(items, latest...)
	return items, nil
}

func parseXianyuPromptCollection(markdown string) []model.Prompt {
	section := markdownSection(markdown, "## 提示词合集", "## 高级技巧")
	items := []model.Prompt{}
	currentCategory := ""
	currentTitle := ""
	currentLines := []string{}
	finish := func() {
		if currentTitle == "" || currentCategory == "补充案例提示词" {
			return
		}
		block := strings.Join(currentLines, "\n")
		prompt := xianyuCodeBlockText(block)
		if prompt == "" {
			prompt = xianyuFallbackPromptText(block)
		}
		if prompt == "" {
			return
		}
		images := extractMarkdownImages(xianyuAwesomeGptImage2RawBase, block)
		cover := ""
		if len(images) > 0 {
			cover = images[0]
		}
		items = append(items, model.Prompt{ID: "xianyu-awesome-gptimage2-" + leftPad(len(items)+1), Title: currentTitle, CoverURL: cover, Prompt: prompt, Tags: xianyuPromptTags(currentCategory), Preview: markdownPreview(images)})
	}
	for _, line := range strings.Split(section, "\n") {
		if strings.HasPrefix(line, "### ") && !strings.HasPrefix(line, "#### ") {
			finish()
			currentTitle = ""
			currentLines = []string{}
			currentCategory = cleanXianyuCategory(strings.TrimSpace(strings.TrimPrefix(line, "### ")))
			continue
		}
		if strings.HasPrefix(line, "#### ") {
			finish()
			currentTitle = cleanXianyuPromptTitle(strings.TrimSpace(strings.TrimPrefix(line, "#### ")))
			currentLines = []string{}
			continue
		}
		if currentTitle != "" {
			currentLines = append(currentLines, line)
		}
	}
	finish()
	return items
}

func markdownSection(markdown, startHeading, endHeading string) string {
	start := strings.Index(markdown, startHeading)
	if start < 0 {
		return ""
	}
	rest := markdown[start+len(startHeading):]
	end := strings.Index(rest, endHeading)
	if end < 0 {
		return markdown[start:]
	}
	return markdown[start : start+len(startHeading)+end]
}

func cleanXianyuCategory(value string) string {
	value = strings.TrimSpace(value)
	for _, sep := range []string{"、", ".", "．", " "} {
		if index := strings.Index(value, sep); index >= 0 {
			prefix := strings.TrimSpace(value[:index])
			if prefix != "" && len([]rune(prefix)) <= 4 {
				value = strings.TrimSpace(value[index+len(sep):])
			}
			break
		}
	}
	return value
}

func cleanXianyuPromptTitle(value string) string {
	value = strings.TrimSpace(value)
	if index := strings.Index(value, " "); index > 0 {
		prefix := value[:index]
		if strings.Contains(prefix, ".") || strings.Contains(prefix, "．") {
			value = strings.TrimSpace(value[index+1:])
		}
	}
	return value
}

func xianyuCodeBlockText(block string) string {
	lines := []string{}
	inCode := false
	for _, line := range strings.Split(block, "\n") {
		text := strings.TrimSpace(line)
		if strings.HasPrefix(text, "```") {
			if inCode {
				break
			}
			inCode = true
			continue
		}
		if inCode {
			lines = append(lines, line)
		}
	}
	return strings.TrimSpace(strings.Join(lines, "\n"))
}

func xianyuFallbackPromptText(block string) string {
	lines := []string{}
	for _, line := range strings.Split(block, "\n") {
		text := strings.TrimSpace(line)
		if text == "" || strings.HasPrefix(text, "#") || strings.HasPrefix(text, "---") || strings.HasPrefix(text, "![") || strings.HasPrefix(text, "|") || strings.HasPrefix(text, ">") || strings.HasPrefix(text, "```") {
			continue
		}
		if strings.HasPrefix(text, "- 原文链接") || strings.HasPrefix(text, "- 公众号") || strings.HasPrefix(text, "- 作者") || strings.HasPrefix(text, "- 本次补充") || strings.HasPrefix(text, "- 说明") {
			continue
		}
		text = strings.TrimSpace(strings.TrimPrefix(text, "-"))
		text = strings.TrimSpace(strings.TrimPrefix(text, "*"))
		if strings.HasPrefix(text, "提示词：") {
			text = strings.TrimSpace(strings.TrimPrefix(text, "提示词："))
		}
		if text != "" && !strings.HasPrefix(text, "http") {
			lines = append(lines, text)
		}
	}
	return strings.Join(lines, "\n")
}

func xianyuPromptTags(category string) []string {
	tags := []string{"gpt-image-2"}
	if category != "" {
		tags = append(tags, splitTags(category, "\\s*(/|&|、|与)\\s*")...)
	}
	return tags
}

func buildXianyuLatestXPrompts(budget *upstreamReadBudget, offset int) ([]model.Prompt, error) {
	raw, err := fetchText(budget, xianyuAwesomeGptImage2RawBase, "data/latest-prompts.json")
	if err != nil {
		return nil, err
	}
	data := xianyuLatestPromptData{}
	if err := json.Unmarshal([]byte(raw), &data); err != nil {
		return nil, err
	}
	items := []model.Prompt{}
	seen := map[string]bool{}
	appendOne := func(item xianyuLatestPrompt) {
		prompt := strings.TrimSpace(item.Prompt)
		if prompt == "" {
			return
		}
		key := firstXianyuNonEmpty(item.XURL, item.URL, item.Author+item.CreatedAt+prompt)
		if seen[key] {
			return
		}
		seen[key] = true
		image := firstXianyuNonEmpty(item.PrimaryImageURL, firstString(item.ImageURLs))
		title := firstXianyuNonEmpty(item.Reason, item.Author, "X Prompt")
		preview := xianyuLatestXPreview(item, image)
		date := normalizePromptTime(item.CreatedAt)
		items = append(items, model.Prompt{ID: "xianyu-awesome-gptimage2-" + leftPad(offset+len(items)+1), Title: title, CoverURL: image, Prompt: prompt, Tags: []string{"x"}, CreatedAt: date, UpdatedAt: date, Preview: preview})
	}
	for _, group := range data.Dates {
		for _, item := range group.Items {
			appendOne(item)
		}
	}
	for _, item := range data.Items {
		appendOne(item)
	}
	return items, nil
}

func xianyuLatestXPreview(item xianyuLatestPrompt, image string) string {
	lines := []string{}
	link := firstXianyuNonEmpty(item.XURL, item.URL)
	if link != "" {
		lines = append(lines, link)
	}
	for _, url := range item.ImageURLs {
		if url = strings.TrimSpace(url); url != "" {
			lines = append(lines, url)
		}
	}
	if len(lines) == 1 && image != "" {
		lines = append(lines, image)
	}
	return strings.Join(lines, "\n")
}

func normalizePromptTime(value string) string {
	value = strings.TrimSpace(value)
	if value == "" {
		return ""
	}
	for _, layout := range []string{time.RFC3339Nano, time.RFC3339, time.RFC1123, time.RFC1123Z, "2006-01-02"} {
		if parsed, err := time.Parse(layout, value); err == nil {
			return parsed.Format(time.RFC3339)
		}
	}
	return value
}

func firstXianyuNonEmpty(values ...string) string {
	for _, value := range values {
		if value = strings.TrimSpace(value); value != "" {
			return value
		}
	}
	return ""
}

func firstString(values []string) string {
	for _, value := range values {
		if value = strings.TrimSpace(value); value != "" {
			return value
		}
	}
	return ""
}

func buildYouMindGptImage2Prompts(budget *upstreamReadBudget) ([]model.Prompt, error) {
	return buildYouMindPrompts(budget, youMindGptImage2RawBase, "youmind-gpt-image-2", "gpt-image-2")
}

func buildYouMindNanoBananaProPrompts(budget *upstreamReadBudget) ([]model.Prompt, error) {
	return buildYouMindPrompts(budget, youMindNanoBananaProRawBase, "youmind-nano-banana-pro", "nano-banana-pro")
}

func buildDavidWuGptImage2Prompts(budget *upstreamReadBudget) ([]model.Prompt, error) {
	raw, err := fetchText(budget, davidWuGptImage2RawBase, "prompts.json")
	if err != nil {
		return nil, err
	}
	data := []davidWuGptImage2Prompt{}
	if err := json.Unmarshal([]byte(raw), &data); err != nil {
		return nil, err
	}
	items := []model.Prompt{}
	for _, item := range data {
		title := strings.TrimSpace(item.TitleCN)
		if title == "" {
			title = strings.TrimSpace(item.TitleEN)
		}
		prompt := strings.TrimSpace(item.Prompt)
		if title == "" || prompt == "" {
			continue
		}
		image := absoluteImage(davidWuGptImage2RawBase, item.Image)
		items = append(items, model.Prompt{ID: "davidwu-gpt-image2-prompts-" + leftPad(item.ID), Title: title, CoverURL: image, Prompt: prompt, Tags: davidWuGptImage2Tags(item), Preview: davidWuGptImage2Preview(item, image)})
	}
	return items, nil
}

func buildYouMindPrompts(budget *upstreamReadBudget, baseURL, idPrefix, modelTag string) ([]model.Prompt, error) {
	markdown, err := fetchText(budget, baseURL, "README_zh.md")
	if err != nil {
		return nil, err
	}
	items := []model.Prompt{}
	for _, block := range splitBeforeHeading(markdown, "### ") {
		title := strings.TrimSpace(firstMatch(block, `(?m)^###\s+No\.\s*\d+:\s*(.+)$`))
		prompt := strings.TrimSpace(firstMatch(block, "(?s)#### .*?提示词\\s*\\r?\\n\\s*```[\\w-]*\\r?\\n(.*?)\\r?\\n```"))
		if title == "" || prompt == "" {
			continue
		}
		images := extractMarkdownImages(baseURL, block)
		cover := ""
		if len(images) > 0 {
			cover = images[0]
		}
		items = append(items, model.Prompt{ID: idPrefix + "-" + leftPad(len(items)+1), Title: title, CoverURL: cover, Prompt: prompt, Tags: youMindTags(title, modelTag), Preview: markdownPreview(images)})
	}
	return items, nil
}

func splitBeforeHeading(markdown string, prefix string) []string {
	blocks := []string{}
	lines := strings.Split(markdown, "\n")
	current := []string{}
	for _, line := range lines {
		if strings.HasPrefix(line, prefix) && len(current) > 0 {
			blocks = append(blocks, strings.Join(current, "\n"))
			current = []string{}
		}
		current = append(current, line)
	}
	return append(blocks, strings.Join(current, "\n"))
}

func firstMatch(value string, pattern string) string {
	match := regexp.MustCompile(pattern).FindStringSubmatch(value)
	if len(match) > 1 {
		return match[1]
	}
	return ""
}

func tagsFromCategory(category string) []string {
	return splitTags(regexp.MustCompile(`(?i)\s+Cases$`).ReplaceAllString(category, ""), `\s*(&|and)\s*`)
}

func tagsFromHeading(heading string) []string {
	return splitTags(regexp.MustCompile(`[^\p{L}\p{N}/&、与 ]`).ReplaceAllString(heading, ""), `\s*(/|&|、|与)\s*`)
}

func youMindTags(title, modelTag string) []string {
	tags := []string{modelTag}
	parts := strings.SplitN(title, " - ", 2)
	if len(parts) > 1 {
		tags = append(tags, tagsFromHeading(parts[0])...)
	}
	return tags
}

func davidWuGptImage2Tags(item davidWuGptImage2Prompt) []string {
	tags := splitTags(strings.Join([]string{item.CategoryCN, item.Category, item.Author, item.Source}, "/"), `/`)
	if item.NeedsRef {
		tags = append(tags, "需要参考图")
	}
	return tags
}

func davidWuGptImage2Preview(item davidWuGptImage2Prompt, image string) string {
	lines := []string{}
	if item.TitleEN != "" {
		lines = append(lines, item.TitleEN)
	}
	if item.Note != "" {
		lines = append(lines, item.Note)
	}
	if image != "" {
		lines = append(lines, "![]("+image+")")
	}
	return strings.Join(lines, "\n\n")
}

func splitTags(value string, pattern string) []string {
	tags := []string{}
	for _, tag := range regexp.MustCompile(pattern).Split(value, -1) {
		if tag = strings.ToLower(strings.TrimSpace(tag)); tag != "" {
			tags = append(tags, tag)
		}
	}
	return tags
}

func markdownPreview(images []string) string {
	lines := []string{}
	for _, image := range images {
		if image != "" {
			lines = append(lines, "![]("+image+")")
		}
	}
	return strings.Join(lines, "\n\n")
}

func extractMarkdownImages(baseURL string, block string) []string {
	seen := map[string]bool{}
	images := []string{}
	for _, pattern := range []string{`<img[^>]+src="([^"]+)"`, `!\[[^\]]*]\(([^)]+)\)`} {
		for _, match := range regexp.MustCompile(pattern).FindAllStringSubmatch(block, -1) {
			image := absoluteImage(baseURL, match[1])
			if image != "" && !seen[image] {
				seen[image] = true
				images = append(images, image)
			}
		}
	}
	return images
}

func absoluteImage(baseURL, image string) string {
	if image == "" || strings.HasPrefix(image, "http://") || strings.HasPrefix(image, "https://") {
		return image
	}
	return baseURL + "/" + strings.TrimLeft(strings.TrimPrefix(image, "."), "/")
}

func leftPad(value int) string {
	if value >= 1000 {
		return strconv.Itoa(value)
	}
	text := "000" + strconv.Itoa(value)
	return text[len(text)-3:]
}
