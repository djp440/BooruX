package main

import (
	"regexp"
	"strings"
)

var (
	leadHash   = regexp.MustCompile(`^#+`)
	spaceRun   = regexp.MustCompile(`\s+`)
	tokenSplit = regexp.MustCompile(`[_()/\s-]+`)
)

func normalizeTag(tag string) string {
	if tag == "" {
		return ""
	}
	t := spaceRun.ReplaceAllString(leadHash.ReplaceAllString(strings.ToLower(strings.TrimSpace(tag)), ""), "_")
	r := []rune(t)
	if len(r) > 100 {
		r = r[:100]
	}
	return string(r)
}

func matchesTagToken(postTag, filter string) bool {
	if postTag == filter {
		return true
	}
	for _, t := range tokenSplit.Split(postTag, -1) {
		if t == filter {
			return true
		}
	}
	return strings.Contains(filter, "_") && strings.Contains(postTag, filter)
}

// postTagNames 提取作品标签名（兼容 []M 与 []any）。
func postTagNames(p M) []string {
	var out []string
	switch ts := p["tags"].(type) {
	case []M:
		for _, t := range ts {
			out = append(out, str(t["name"]))
		}
	case []any:
		for _, t := range ts {
			if m, ok := t.(map[string]any); ok {
				out = append(out, str(m["name"]))
			}
		}
	}
	return out
}

func cleanList(v any) []string {
	arr, _ := v.([]any)
	var out []string
	for _, x := range arr {
		if s, ok := x.(string); ok {
			if n := normalizeTag(s); n != "" {
				out = append(out, n)
			}
		}
	}
	return out
}

func anyMatch(tags, filters []string) bool {
	for _, f := range filters {
		for _, t := range tags {
			if matchesTagToken(t, f) {
				return true
			}
		}
	}
	return false
}

func isPostAllowed(post M, filter any) bool {
	f, ok := filter.(map[string]any)
	if !ok {
		return true
	}
	var tags []string
	for _, n := range postTagNames(post) {
		if t := normalizeTag(n); t != "" {
			tags = append(tags, t)
		}
	}
	if f["blacklistEnabled"] == true {
		if bl := cleanList(f["blacklist"]); anyMatch(tags, bl) {
			return false
		}
	}
	if f["whitelistEnabled"] == true {
		if wl := cleanList(f["whitelist"]); len(wl) > 0 && !anyMatch(tags, wl) {
			return false
		}
	}
	return true
}

// filterAllowedPosts 按标签过滤设置剔除帖子；未配置过滤时原样返回。
func filterAllowedPosts(posts []M, filter any) []M {
	if _, ok := filter.(map[string]any); !ok {
		return posts
	}
	out := make([]M, 0, len(posts))
	for _, p := range posts {
		if isPostAllowed(p, filter) {
			out = append(out, p)
		}
	}
	return out
}
