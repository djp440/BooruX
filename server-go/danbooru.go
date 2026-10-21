package main

import (
	"context"
	"database/sql"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net/http"
	"net/url"
	"regexp"
	"strconv"
	"strings"
	"time"
)

const (
	danbooruAPIURL  = "https://danbooru.donmai.us/posts.json"
	safebooruAPIURL = "https://safebooru.org/index.php"
	yandereAPIURL   = "https://yande.re/post.json"
	userAgent       = "TikBooru/1.0 (Windows NT 10.0; Win64; x64; +https://github.com/tikbooru/tikbooru)"
	avatarURL       = "https://images.unsplash.com/photo-1534528741775-53994a69daeb?w=120&auto=format&fit=crop&q=80"
)

var (
	videoURLRe = regexp.MustCompile(`(?i)\.(mp4|webm|mov|m4v|ogv)$`)
	gifURLRe   = regexp.MustCompile(`(?i)\.gif$`)
	videoTagRe = regexp.MustCompile(`\b(webm|mp4_video|video|animated_video)\b`)
	gifTagRe   = regexp.MustCompile(`\b(animated_gif|gif|animated)\b`)
	vidOnlyRe  = regexp.MustCompile(`\b(video|webm)\b`)
	extRe      = regexp.MustCompile(`\.[^/.]+$`)
)

func inList(s string, list ...string) bool {
	for _, v := range list {
		if s == v {
			return true
		}
	}
	return false
}

func detectMediaType(u, fileExt, tags string) string {
	ext := strings.TrimPrefix(strings.ToLower(fileExt), ".")
	if inList(ext, "mp4", "webm", "mov", "m4v", "ogv", "zip", "ugoira") {
		return "video"
	}
	if ext == "gif" {
		return "gif"
	}
	if u != "" {
		clean := strings.ToLower(strings.SplitN(u, "?", 2)[0])
		if videoURLRe.MatchString(clean) {
			return "video"
		}
		if gifURLRe.MatchString(clean) {
			return "gif"
		}
	}
	if tags != "" {
		t := strings.ToLower(tags)
		if videoTagRe.MatchString(t) {
			return "video"
		}
		if gifTagRe.MatchString(t) && !vidOnlyRe.MatchString(t) {
			return "gif"
		}
	}
	return "image"
}

// encodeURIComponent 等价实现
func encodeURIComponent(s string) string {
	return strings.ReplaceAll(url.QueryEscape(s), "+", "%20")
}

func wrapProxiedURL(u string) string {
	if u == "" {
		return ""
	}
	if strings.HasPrefix(u, "/api/") || strings.HasPrefix(u, "data:") || strings.HasPrefix(u, "blob:") {
		return u
	}
	if strings.Contains(u, "cdn.donmai.us") {
		return "/api/media?url=" + encodeURIComponent(u)
	}
	return u
}

func firstNonEmpty(vs ...string) string {
	for _, v := range vs {
		if v != "" {
			return v
		}
	}
	return ""
}

func variantURL(variants []any, types ...string) string {
	for _, t := range types {
		for _, v := range variants {
			m, _ := v.(map[string]any)
			if str(m["type"]) == t && str(m["url"]) != "" {
				return str(m["url"])
			}
		}
	}
	return ""
}

func extractDanbooruURLs(raw M) (string, string) {
	var variants []any
	if ma, ok := raw["media_asset"].(map[string]any); ok {
		variants, _ = ma["variants"].([]any)
	}
	imageURL := firstNonEmpty(variantURL(variants, "original"), str(raw["file_url"]))
	previewURL := firstNonEmpty(variantURL(variants, "720x720", "360x360", "sample", "180x180"), str(raw["preview_file_url"]), str(raw["large_file_url"]), str(raw["file_url"]))
	md5 := str(raw["md5"])
	if (imageURL == "" || previewURL == "") && len(md5) >= 4 {
		s1, s2 := md5[:2], md5[2:4]
		ext := orDefault(str(raw["file_ext"]), "jpg")
		if imageURL == "" {
			imageURL = fmt.Sprintf("https://cdn.donmai.us/original/%s/%s/%s.%s", s1, s2, md5, ext)
		}
		if previewURL == "" {
			previewURL = fmt.Sprintf("https://cdn.donmai.us/180x180/%s/%s/%s.jpg", s1, s2, md5)
		}
	}
	if previewURL == "" {
		previewURL = imageURL
	}
	return wrapProxiedURL(imageURL), wrapProxiedURL(previewURL)
}

func extractSafebooruURLs(raw M) (string, string) {
	clean := func(v any) string {
		if v == nil {
			return ""
		}
		return strings.ReplaceAll(str(v), `\`, "")
	}
	imageURL, fileURL, previewURL := clean(raw["sample_url"]), clean(raw["file_url"]), clean(raw["preview_url"])
	dir, image := str(raw["directory"]), str(raw["image"])
	if fileURL == "" && dir != "" && image != "" {
		fileURL = fmt.Sprintf("https://safebooru.org/images/%s/%s", dir, image)
	}
	if previewURL == "" && dir != "" && image != "" {
		previewURL = fmt.Sprintf("https://safebooru.org/thumbnails/%s/thumbnail_%s", dir, extRe.ReplaceAllString(image, ".jpg"))
	}
	imageURL = fileURL
	if previewURL == "" {
		previewURL = imageURL
	}
	if strings.HasPrefix(imageURL, "//") {
		imageURL = "https:" + imageURL
	}
	if strings.HasPrefix(previewURL, "//") {
		previewURL = "https:" + previewURL
	}
	return imageURL, previewURL
}

func simpleTags(tagStr string) ([]string, []M) {
	list := strings.Fields(tagStr)
	tags := make([]M, 0, len(list))
	for _, n := range list {
		tags = append(tags, M{"id": "tag-" + n, "name": n, "category": "general"})
	}
	return list, tags
}

func orNum(v any, d float64) float64 {
	if n := num(v); n != 0 {
		return n
	}
	return d
}

func transformSafebooruPost(raw M) M {
	id := "safebooru-" + str(raw["id"])
	w, h := orNum(raw["width"], 1080), orNum(raw["height"], 1920)
	imageURL, previewURL := extractSafebooruURLs(raw)
	list, tags := simpleTags(str(raw["tags"]))
	title := strings.Join(list[:min(3, len(list))], " ")
	if title == "" {
		title = "Booru #" + str(raw["id"])
	}
	score, _ := strconv.Atoi(str(raw["score"]))
	return M{
		"id": id, "title": title, "artist": "Unknown_Artist", "artistAvatar": avatarURL,
		"imageUrl": imageURL, "previewUrl": previewURL, "aspectRatio": w / h, "width": int64(w), "height": int64(h),
		"isBookmarked": false, "rating": "general", "score": score, "mediaType": detectMediaType(imageURL, "", str(raw["tags"])),
		"sourceUrl": firstNonEmpty(imageURL, "https://safebooru.org/index.php?page=post&s=view&id="+str(raw["id"])),
		"parentId":  parentRef("safebooru-", raw), "hasChildren": hasChildren(raw),
		"createdAt": nowISO(), "description": "Safebooru post #" + str(raw["id"]), "tags": tags,
	}
}

func transformYanderePost(raw M) M {
	id := "yandere-" + str(raw["id"])
	w, h := orNum(raw["width"], 1080), orNum(raw["height"], 1920)
	imageURL := str(raw["file_url"])
	previewURL := firstNonEmpty(str(raw["preview_url"]), str(raw["sample_url"]), str(raw["jpeg_url"]), str(raw["file_url"]))
	list, tags := simpleTags(str(raw["tags"]))
	title := strings.Join(list[:min(3, len(list))], " ")
	if title == "" {
		title = "Yande.re #" + str(raw["id"])
	}
	rating := "questionable"
	switch str(raw["rating"]) {
	case "s":
		rating = "general"
	case "q":
		rating = "sensitive"
	case "e":
		rating = "explicit"
	}
	created := time.Now()
	if c := num(raw["created_at"]); c != 0 {
		created = time.Unix(int64(c), 0)
	}
	return M{
		"id": id, "title": title, "artist": "Unknown_Artist", "artistAvatar": avatarURL,
		"imageUrl": imageURL, "previewUrl": previewURL, "aspectRatio": w / h, "width": int64(w), "height": int64(h),
		"isBookmarked": false, "rating": rating, "score": int64(num(raw["score"])), "mediaType": detectMediaType(imageURL, "", str(raw["tags"])),
		"sourceUrl": orDefault(str(raw["source"]), "https://yande.re/post/show/"+str(raw["id"])),
		"parentId":  parentRef("yandere-", raw), "hasChildren": hasChildren(raw),
		"createdAt": iso(created), "description": "Yande.re post #" + str(raw["id"]), "tags": tags,
	}
}

func buildDanbooruQueryTags(tags, rating string) string {
	var list []string
	if strings.TrimSpace(tags) != "" {
		list = append(list, strings.Fields(tags)...)
	}
	if rating == "" {
		rating = "general"
	}
	if inList(rating, "general", "sensitive", "questionable", "explicit") {
		list = append(list, "rating:"+rating)
	}
	return strings.Join(list, " ")
}

func translateTagForSafebooru(tagStr string) string {
	var out []string
	for _, t := range strings.Fields(tagStr) {
		switch {
		case inList(t, "order:rank", "order:score", "order:curated", "trending", "masterpiece"):
			out = append(out, "sort:score:desc")
		case strings.HasPrefix(t, "order:"):
			out = append(out, "sort:"+strings.Replace(t, "order:", "", 1)+":desc")
		case strings.HasPrefix(t, "rating:"):
			if inList(t, "rating:general", "rating:s", "rating:safe") {
				out = append(out, "rating:safe")
			}
		default:
			out = append(out, t)
		}
	}
	return strings.Join(out, " ")
}

func firstWord(s string) string {
	f := strings.Fields(s)
	if len(f) == 0 {
		return ""
	}
	return f[0]
}

// parentRef 把来源的 parent_id 转成本地作品 id；无父作品返回 nil。
func parentRef(prefix string, raw M) any {
	if p := str(raw["parent_id"]); p != "" && p != "0" {
		return prefix + p
	}
	return nil
}

func hasChildren(raw M) bool {
	b, _ := raw["has_children"].(bool)
	return b
}

func transformDanbooruPost(raw M) M {
	id := "danbooru-" + str(raw["id"])
	w, h := orNum(raw["image_width"], 1080), orNum(raw["image_height"], 1920)
	rating := "general"
	switch str(raw["rating"]) {
	case "s":
		rating = "sensitive"
	case "q":
		rating = "questionable"
	case "e":
		rating = "explicit"
	}
	imageURL, previewURL := extractDanbooruURLs(raw)
	artist := orDefault(firstWord(str(raw["tag_string_artist"])), "Unknown_Artist")
	ch, cp := firstWord(str(raw["tag_string_character"])), firstWord(str(raw["tag_string_copyright"]))
	sp := func(s string) string { return strings.ReplaceAll(s, "_", " ") }
	var title string
	switch {
	case ch != "" && cp != "":
		title = sp(ch) + " // " + sp(cp)
	case ch != "":
		title = sp(ch)
	case cp != "":
		title = sp(cp) + " Series"
	default:
		title = "Danbooru #" + str(raw["id"])
	}
	tags := []M{}
	seen := map[string]bool{}
	for _, c := range [][2]string{{"tag_string_artist", "artist"}, {"tag_string_character", "character"}, {"tag_string_copyright", "copyright"}, {"tag_string_general", "general"}, {"tag_string_meta", "meta"}} {
		for _, n := range strings.Fields(str(raw[c[0]])) {
			if !seen[n] {
				seen[n] = true
				tags = append(tags, M{"id": "tag-" + n, "name": n, "category": c[1]})
			}
		}
	}
	created := nowISO()
	if c := str(raw["created_at"]); c != "" {
		if t, err := time.Parse(time.RFC3339, c); err == nil {
			created = iso(t)
		} else {
			created = c
		}
	}
	return M{
		"id": id, "title": title, "artist": artist, "artistAvatar": avatarURL,
		"imageUrl": imageURL, "previewUrl": previewURL, "aspectRatio": w / h, "width": int64(w), "height": int64(h),
		"isBookmarked": false, "rating": rating, "score": int64(num(raw["score"])),
		"mediaType": detectMediaType(imageURL, str(raw["file_ext"]), str(raw["tag_string"])),
		"sourceUrl": orDefault(str(raw["source"]), "https://danbooru.donmai.us/posts/"+str(raw["id"])),
		"parentId":  parentRef("danbooru-", raw), "hasChildren": hasChildren(raw),
		"createdAt": created, "description": fmt.Sprintf("Danbooru post #%s with %d tagged attributes.", str(raw["id"]), len(tags)), "tags": tags,
	}
}

type danbooruOptions struct {
	Tags, Rating   string
	Page, Limit    int
	BeforeID       string // Danbooru 游标：只取 id 小于它的作品（page=b<id>）
	BaseURL        string
	RedactLogs     bool
	ThrowOnFailure bool
	OnSource       func(string)
}

func fetchJSONArray(ctx context.Context, target string) ([]M, bool, error) {
	ctx, cancel := context.WithTimeout(ctx, 6*time.Second)
	defer cancel()
	req, err := http.NewRequestWithContext(ctx, "GET", target, nil)
	if err != nil {
		return nil, false, err
	}
	req.Header.Set("User-Agent", userAgent)
	req.Header.Set("Accept", "application/json")
	res, err := http.DefaultClient.Do(req)
	if err != nil {
		return nil, false, err
	}
	defer res.Body.Close()
	if res.StatusCode < 200 || res.StatusCode > 299 {
		return nil, false, nil
	}
	b, err := io.ReadAll(res.Body)
	if err != nil {
		return nil, false, err
	}
	var arr []M
	if json.Unmarshal(b, &arr) != nil {
		return nil, false, nil
	}
	return arr, true, nil
}

func withImage(posts []M) []M {
	out := []M{}
	for _, p := range posts {
		if str(p["imageUrl"]) != "" {
			out = append(out, p)
		}
	}
	return out
}

func fetchSourcePostByID(ctx context.Context, source, rawID string) (M, bool, error) {
	var target string
	values := url.Values{}
	switch source {
	case "safebooru":
		values.Set("page", "dapi")
		values.Set("s", "post")
		values.Set("q", "index")
		values.Set("json", "1")
		values.Set("tags", "id:"+rawID)
		values.Set("limit", "1")
		target = safebooruAPIURL + "?" + values.Encode()
	case "yandere":
		values.Set("tags", "id:"+rawID)
		values.Set("limit", "1")
		target = yandereAPIURL + "?" + values.Encode()
	}
	arr, ok, err := fetchJSONArray(ctx, target)
	if err != nil || !ok || len(arr) == 0 {
		return nil, ok, err
	}
	raw := arr[0]
	if str(raw["id"]) != rawID {
		return nil, true, nil
	}
	if source == "safebooru" {
		return transformSafebooruPost(raw), true, nil
	}
	return transformYanderePost(raw), true, nil
}

func fetchDanbooruPosts(ctx context.Context, o danbooruOptions) ([]M, error) {
	if err := ctx.Err(); err != nil {
		return nil, err
	}
	received := false
	page := o.Page
	if page <= 0 {
		page = 1
	}
	limit := o.Limit
	if limit <= 0 {
		limit = 20
	}
	limit = min(limit, 100)
	base := orDefault(o.BaseURL, danbooruAPIURL)
	logMeta := func(v any) []any {
		if o.RedactLogs {
			return nil
		}
		return []any{v}
	}
	queryTags := buildDanbooruQueryTags(o.Tags, o.Rating)
	p := url.Values{}
	if queryTags != "" {
		p.Set("tags", queryTags)
	}
	p.Set("page", strconv.Itoa(page))
	if o.BeforeID != "" {
		p.Set("page", "b"+o.BeforeID)
	}
	p.Set("limit", strconv.Itoa(limit))
	target := base + "?" + p.Encode()
	appendServerLog("INFO", "DANBOORU_API", "Requesting Danbooru posts", logMeta(M{"url": target, "queryTags": queryTags})...)

	if arr, ok, err := fetchJSONArray(ctx, target); err != nil {
		if ctx.Err() != nil {
			return nil, ctx.Err()
		}
		appendServerLog("WARN", "DANBOORU_API", "Primary Danbooru API unavailable, attempting Safebooru mirror fallback", logMeta(err.Error())...)
	} else if ok {
		received = true
		if o.OnSource != nil {
			o.OnSource("danbooru")
		}
		var valid []M
		for _, r := range arr {
			if r["is_deleted"] == true || r["is_banned"] == true {
				continue
			}
			valid = append(valid, transformDanbooruPost(r))
		}
		if valid = withImage(valid); len(valid) > 0 {
			appendServerLog("INFO", "DANBOORU_API", fmt.Sprintf("Successfully fetched %d posts from Danbooru", len(valid)))
			return valid, nil
		}
	}

	if o.BeforeID != "" {
		// 游标只对 Danbooru 有意义：正常返回空数组即已到底，不可用则交给调用方回退本地库
		if received {
			return []M{}, nil
		}
		return nil, errors.New("Danbooru 暂不可用")
	}

	sp := url.Values{}
	sp.Set("page", "dapi")
	sp.Set("s", "post")
	sp.Set("q", "index")
	sp.Set("json", "1")
	if t := translateTagForSafebooru(o.Tags); t != "" {
		sp.Set("tags", t)
	}
	sp.Set("limit", strconv.Itoa(limit))
	sp.Set("pid", strconv.Itoa(max(0, page-1)))
	fallback := safebooruAPIURL + "?" + sp.Encode()
	if o.RedactLogs {
		appendServerLog("INFO", "SAFEBOORU_FALLBACK", "Fetching from Safebooru mirror")
	} else {
		appendServerLog("INFO", "SAFEBOORU_FALLBACK", "Fetching from Safebooru mirror: "+fallback)
	}
	if arr, ok, err := fetchJSONArray(ctx, fallback); err != nil {
		if ctx.Err() != nil {
			return nil, ctx.Err()
		}
		appendServerLog("WARN", "SAFEBOORU_FALLBACK", "Safebooru fallback failed, trying Yande.re", logMeta(err.Error())...)
	} else if ok {
		received = true
		if o.OnSource != nil {
			o.OnSource("safebooru")
		}
		var parsed []M
		for _, r := range arr {
			parsed = append(parsed, transformSafebooruPost(r))
		}
		if parsed = withImage(parsed); len(parsed) > 0 {
			appendServerLog("INFO", "SAFEBOORU_FALLBACK", fmt.Sprintf("Successfully fetched %d posts from Safebooru mirror", len(parsed)))
			return parsed, nil
		}
	}

	yp := url.Values{}
	if o.Tags != "" {
		yp.Set("tags", o.Tags)
	}
	yp.Set("limit", strconv.Itoa(limit))
	yp.Set("page", strconv.Itoa(page))
	yURL := yandereAPIURL + "?" + yp.Encode()
	if o.RedactLogs {
		appendServerLog("INFO", "YANDERE_FALLBACK", "Fetching from Yande.re mirror")
	} else {
		appendServerLog("INFO", "YANDERE_FALLBACK", "Fetching from Yande.re mirror: "+yURL)
	}
	if arr, ok, err := fetchJSONArray(ctx, yURL); err != nil {
		if ctx.Err() != nil {
			return nil, ctx.Err()
		}
		appendServerLog("ERROR", "YANDERE_FALLBACK", "Yande.re fallback failed", logMeta(err.Error())...)
	} else if ok {
		received = true
		if o.OnSource != nil {
			o.OnSource("yandere")
		}
		var parsed []M
		for _, r := range arr {
			parsed = append(parsed, transformYanderePost(r))
		}
		if parsed = withImage(parsed); len(parsed) > 0 {
			appendServerLog("INFO", "YANDERE_FALLBACK", fmt.Sprintf("Successfully fetched %d posts from Yande.re mirror", len(parsed)))
			return parsed, nil
		}
	}

	if o.ThrowOnFailure && !received {
		return nil, errors.New("在线作品源暂不可用")
	}
	return []M{}, nil
}

func syncDanbooruToDB(db *sql.DB, posts []M) (int, error) {
	if len(posts) == 0 {
		return 0, nil
	}
	count := 0
	err := withTx(db, func(tx *sql.Tx) error {
		for _, p := range posts {
			if str(p["imageUrl"]) == "" {
				continue
			}
			bm := 0
			if p["isBookmarked"] == true {
				bm = 1
			}
			if _, err := tx.Exec(`INSERT INTO posts (id,title,artist,artist_avatar,image_url,preview_url,aspect_ratio,width,height,is_bookmarked,rating,score,description,media_type,created_at,parent_id,has_children)
        VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)
        ON CONFLICT(id) DO UPDATE SET score=excluded.score,image_url=excluded.image_url,preview_url=excluded.preview_url,media_type=excluded.media_type,
          parent_id=excluded.parent_id,has_children=excluded.has_children`,
				str(p["id"]), str(p["title"]), str(p["artist"]), str(p["artistAvatar"]), str(p["imageUrl"]), str(p["previewUrl"]),
				num(p["aspectRatio"]), int64(num(p["width"])), int64(num(p["height"])), bm, str(p["rating"]), int64(num(p["score"])),
				str(p["description"]), orDefault(str(p["mediaType"]), "image"), str(p["createdAt"]), nullableStr(p["parentId"]), boolInt(p["hasChildren"] == true)); err != nil {
				return err
			}
			tags, _ := p["tags"].([]M)
			for _, t := range tags {
				if _, err := tx.Exec(`INSERT INTO tags (id,name,category,count) VALUES (?,?,?,?) ON CONFLICT(name) DO NOTHING`,
					str(t["id"]), str(t["name"]), str(t["category"]), int64(num(t["count"]))); err != nil {
					return err
				}
				var tid string
				if tx.QueryRow("SELECT id FROM tags WHERE name=?", str(t["name"])).Scan(&tid) == nil {
					if _, err := tx.Exec("INSERT OR IGNORE INTO post_tags (post_id,tag_id) VALUES (?,?)", str(p["id"]), tid); err != nil {
						return err
					}
				}
			}
			count++
		}
		return nil
	})
	if err != nil {
		return 0, err
	}
	appendServerLog("INFO", "DANBOORU_SYNC", fmt.Sprintf("Synced %d Danbooru posts to SQLite database", count))
	return count, nil
}
