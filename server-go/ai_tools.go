package main

import (
	"context"
	"database/sql"
	"encoding/json"
	"errors"
	"math"
	"regexp"
	"strings"
)

func toolDef(name, desc string, props M, required ...string) ToolDefinition {
	if required == nil {
		required = []string{}
	}
	return ToolDefinition{Type: "function", Function: ToolSpec{Name: name, Description: desc,
		Parameters: M{"type": "object", "properties": props, "required": required, "additionalProperties": false}}}
}

var aiTools = func() []ToolDefinition {
	s := M{"type": "string"}
	lim := M{"type": "integer", "minimum": 1, "maximum": 20}
	return []ToolDefinition{
		toolDef("search_posts", "搜索当前配置允许的作品；结果会作为媒体直接显示在对话中。", M{"tags": s, "limit": lim}),
		toolDef("get_post", "读取指定作品并在对话中显示媒体。", M{"id": s}, "id"),
		toolDef("list_bookmarks", "读取当前配置允许的收藏作品并在对话中显示媒体。", M{"limit": lim}),
		toolDef("view_post_image", "查看作品的画面。仅当回答需要了解图片视觉内容时调用（如用户要求看图、描述或识别画面）；收藏、查标签、搜索等不依赖画面的操作不要调用。", M{"id": s}, "id"),
		toolDef("search_tags", "查询当前配置允许的作品标签。", M{"query": s}, "query"),
		toolDef("set_bookmark", "仅当用户当前明确要求对具体作品 ID 收藏或取消收藏时执行；目标不明请询问。", M{"id": s, "bookmarked": M{"type": "boolean"}}, "id", "bookmarked"),
	}
}()

func allowedPost(db querier, profileID string, post M) bool {
	if post == nil {
		return false
	}
	st := getProfileSettings(db, profileID)
	rating := str(st["rating"])
	if rating == "" {
		rating = "general"
	}
	return (st["rating"] == "all" || str(post["rating"]) == rating) && isPostAllowed(post, st["tagFilter"])
}

func compactPost(p M) M {
	cut := func(s string, n int) string {
		r := []rune(s)
		if len(r) > n {
			return string(r[:n])
		}
		return s
	}
	names := postTagNames(p)
	if len(names) > 40 {
		names = names[:40]
	}
	if names == nil {
		names = []string{}
	}
	return M{"id": p["id"], "title": cut(str(p["title"]), 200), "artist": cut(str(p["artist"]), 100), "rating": p["rating"],
		"score": p["score"], "isBookmarked": p["isBookmarked"] == true, "tags": names, "mediaType": p["mediaType"],
		"previewUrl": p["previewUrl"], "imageUrl": p["imageUrl"]}
}

func validateTool(name, raw string) (M, error) {
	var spec M
	for _, t := range aiTools {
		if t.Function.Name == name {
			spec = t.Function.Parameters
		}
	}
	if spec == nil {
		return nil, errors.New("未知工具")
	}
	var v any
	if json.Unmarshal([]byte(raw), &v) != nil {
		return nil, errors.New("工具参数不是有效 JSON")
	}
	args, ok := v.(map[string]any)
	if !ok {
		return nil, errors.New("工具参数必须为对象")
	}
	props := spec["properties"].(M)
	for k := range args {
		if _, ok := props[k]; !ok {
			return nil, errors.New("工具含未允许的参数")
		}
	}
	for _, k := range spec["required"].([]string) {
		if _, ok := args[k]; !ok {
			return nil, errors.New("工具缺少必要参数")
		}
	}
	for k, val := range args {
		typ := props[k].(M)["type"]
		valid := false
		switch typ {
		case "integer":
			f, isNum := val.(float64)
			valid = isNum && f == math.Trunc(f) && f >= 1 && f <= 20
		case "string":
			_, valid = val.(string)
		case "boolean":
			_, valid = val.(bool)
		}
		if !valid {
			return nil, errors.New("工具参数类型无效")
		}
		if s, isStr := val.(string); isStr && (utf16Len(s) > 300 || (k == "id" && strings.TrimSpace(s) == "")) {
			return nil, errors.New("工具参数长度无效")
		}
	}
	return args, nil
}

var negatedBookmarkRe = regexp.MustCompile(`(?i)(?:不要|别|不用|无需|不想|不能|不)\s*(?:再)?\s*(?:收藏|bookmark)`)

// quotedBookmarkIntent 判断引用作品时的正文是否表达了收藏（或取消收藏）操作；目标由引用列表限定。
func quotedBookmarkIntent(body string, bookmarked bool) bool {
	body = strings.ToLower(body)
	if negatedBookmarkRe.MatchString(body) {
		return false
	}
	cancel := false
	for _, k := range []string{"取消收藏", "移除收藏", "删除收藏", "unbookmark"} {
		cancel = cancel || strings.Contains(body, k)
	}
	return (strings.Contains(body, "收藏") || strings.Contains(body, "bookmark")) && cancel == !bookmarked
}

func explicitBookmarkIntent(text, id string, bookmarked bool) bool {
	// 引用作品时正文末尾附「[引用作品：id、id…]」。目标 ID 在引用列表内（可多件），且正文表达了对应操作，即视为明确指定
	if body, quoted, ok := strings.Cut(text, "\n\n[引用作品："); ok {
		for _, q := range strings.Split(strings.TrimSuffix(quoted, "]"), "、") {
			if q == id {
				return quotedBookmarkIntent(body, bookmarked)
			}
		}
		text = body
	}
	action := `(?:收藏|bookmark)`
	if !bookmarked {
		action = `(?:取消收藏|移除收藏|删除收藏|unbookmark)`
	}
	re, err := regexp.Compile(`(?i)^(?:请|请帮我|帮我|please\s+)?\s*` + action + `\s*(?:作品\s*|ID\s*[:：]?\s*)?` + regexp.QuoteMeta(id) + `[。！.!\s]*$`)
	return err == nil && re.MatchString(strings.TrimSpace(text))
}

func executeTool(ctx context.Context, db *sql.DB, profileID, name string, args M, userText string) (M, error) {
	if err := ctx.Err(); err != nil {
		return nil, err
	}
	if name == "get_post" || name == "set_bookmark" {
		post, _ := getPostByID(db, str(args["id"]), profileID)
		if !allowedPost(db, profileID, post) {
			return nil, errors.New("作品不存在或不符合当前筛选规则")
		}
		if name == "set_bookmark" {
			want, _ := args["bookmarked"].(bool)
			if !explicitBookmarkIntent(userText, str(post["id"]), want) {
				return nil, errors.New("用户消息中没有对该作品明确的收藏/取消收藏指令：需要用户正文写明操作，且作品由用户引用或在正文给出 ID")
			}
			p := compactPost(post)
			p["isBookmarked"] = want
			return M{"post": p, "mutation": M{"id": post["id"], "bookmarked": want}}, nil
		}
		return M{"post": compactPost(post)}, nil
	}
	settings := getProfileSettings(db, profileID)
	source := "sqlite"
	limit := 10
	if args["limit"] != nil {
		limit = int(num(args["limit"]))
	}
	var candidates []M
	if name == "search_posts" && settings["dataSource"] != "sqlite" {
		rating := str(settings["rating"])
		if rating == "" {
			rating = "general"
		}
		posts, err := fetchDanbooruPosts(ctx, danbooruOptions{Tags: str(args["tags"]), Rating: rating, Limit: 40, RedactLogs: true, ThrowOnFailure: true,
			OnSource: func(s string) { source = s }})
		if err == nil {
			if ctx.Err() == nil {
				_, _ = syncDanbooruToDB(db, posts)
				for _, p := range posts {
					if lp, _ := getPostByID(db, str(p["id"]), profileID); lp != nil {
						candidates = append(candidates, lp)
					}
				}
			}
		} else {
			source = "sqlite_fallback"
		}
		if err := ctx.Err(); err != nil {
			return nil, err
		}
	}
	if source == "sqlite" || source == "sqlite_fallback" {
		want := limit
		if name == "search_tags" {
			want = 500
		}
		for offset := 0; offset < 10000 && len(candidates) < want; offset += 100 {
			tag := ""
			if name == "search_posts" {
				tag = str(args["tags"])
			}
			batch, _ := getPosts(db, postFilter{ProfileID: profileID, Tag: tag, Limit: 100, Offset: offset})
			for _, p := range batch {
				if allowedPost(db, profileID, p) && (name != "list_bookmarks" || p["isBookmarked"] == true) {
					candidates = append(candidates, p)
				}
			}
			if len(batch) < 100 {
				break
			}
		}
	}
	var filtered []M
	for _, p := range candidates {
		if allowedPost(db, profileID, p) {
			filtered = append(filtered, p)
		}
	}
	if name == "search_tags" {
		q := strings.ToLower(str(args["query"]))
		seen := map[string]bool{}
		tags := []string{}
		for _, p := range filtered {
			for _, t := range postTagNames(p) {
				if !seen[t] && strings.Contains(strings.ToLower(t), q) {
					seen[t] = true
					tags = append(tags, t)
				}
			}
		}
		if len(tags) > 50 {
			tags = tags[:50]
		}
		return M{"source": source, "tags": tags}, nil
	}
	out := []M{}
	for _, p := range filtered {
		if (name != "list_bookmarks" || p["isBookmarked"] == true) && len(out) < limit {
			out = append(out, compactPost(p))
		}
	}
	return M{"source": source, "posts": out}, nil
}
