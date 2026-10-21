package main

import (
	"context"
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"net/url"
	"strconv"
	"strings"
	"time"
)

// 详情不使用持久 family 缓存作授权依据，每次以当前 profile 重新解析成员。
type postDetail struct {
	Success              bool   `json:"success"`
	GroupID              string `json:"groupId"`
	Posts                []M    `json:"posts"`
	Source               string `json:"source"`
	FamilyComplete       bool   `json:"familyComplete"`
	CommentsAvailability string `json:"commentsAvailability"`
}

func sourceID(id string) (string, string, error) {
	for _, source := range []string{"danbooru", "safebooru", "yandere"} {
		if raw, ok := strings.CutPrefix(id, source+"-"); ok {
			n, err := strconv.ParseUint(raw, 10, 64)
			if err != nil || n == 0 || strconv.FormatUint(n, 10) != raw {
				return "", "", fmt.Errorf("无效的帖子 ID")
			}
			return source, raw, nil
		}
	}
	return "", "", nil
}

func (s *server) sourceURL(source, path string) string {
	if s.marketURL != "" {
		return s.marketURL + "/" + source + path
	}
	switch source {
	case "danbooru":
		return "https://danbooru.donmai.us" + path
	case "safebooru":
		return "https://safebooru.org" + path
	default:
		return "https://yande.re" + path
	}
}

func readSource(ctx context.Context, target string) ([]byte, error) {
	ctx, cancel := context.WithTimeout(ctx, 10*time.Second)
	defer cancel()
	req, err := http.NewRequestWithContext(ctx, "GET", target, nil)
	if err != nil {
		return nil, err
	}
	req.Header.Set("User-Agent", userAgent)
	res, err := http.DefaultClient.Do(req)
	if err != nil {
		return nil, err
	}
	defer res.Body.Close()
	if res.StatusCode != 200 {
		return nil, fmt.Errorf("原站 HTTP %d", res.StatusCode)
	}
	b, err := io.ReadAll(io.LimitReader(res.Body, (4<<20)+1))
	if err != nil {
		return nil, err
	}
	if len(b) > 4<<20 {
		return nil, fmt.Errorf("原站响应超过大小限制")
	}
	return b, nil
}

func (s *server) sourcePosts(ctx context.Context, source, tags string, page int) ([]M, error) {
	q := url.Values{"tags": {tags}, "limit": {"100"}, "page": {strconv.Itoa(page)}}
	path := "/posts.json"
	if source == "yandere" {
		path = "/post.json"
	}
	if source == "safebooru" {
		path = "/index.php"
		q.Set("page", "dapi")
		q.Set("s", "post")
		q.Set("q", "index")
		q.Set("json", "1")
		q.Set("pid", strconv.Itoa(page-1))
	}
	b, err := readSource(ctx, s.sourceURL(source, path)+"?"+q.Encode())
	if err != nil {
		return nil, err
	}
	var raw []M
	dec := json.NewDecoder(strings.NewReader(string(b)))
	dec.UseNumber()
	if err = dec.Decode(&raw); err != nil {
		return nil, err
	}
	if raw == nil {
		return nil, fmt.Errorf("帖子响应不是数组")
	}
	if dec.Decode(new(any)) != io.EOF {
		return nil, fmt.Errorf("帖子响应包含额外内容")
	}
	posts := []M{}
	for _, p := range raw {
		unavailable := p["is_deleted"] == true || p["is_banned"] == true || inList(str(p["status"]), "deleted", "flagged")
		switch source {
		case "danbooru":
			posts = append(posts, transformDanbooruPost(p))
		case "safebooru":
			posts = append(posts, transformSafebooruPost(p))
		case "yandere":
			posts = append(posts, transformYanderePost(p))
		}
		if unavailable {
			posts[len(posts)-1]["unavailable"] = true
		}
	}
	return posts, nil
}

func (s *server) visiblePosts(posts []M, pid string) []M {
	settings := getProfileSettings(s.db, pid)
	out := []M{}
	for _, p := range posts {
		if p["unavailable"] != true && postRatingAllowed(str(p["rating"]), orDefault(str(settings["rating"]), "general")) && isPostAllowed(p, settings["tagFilter"]) {
			out = append(out, p)
		}
	}
	return out
}

func (s *server) resolveDetail(ctx context.Context, id, pid string) (*postDetail, int, error) {
	source, raw, err := sourceID(id)
	if err != nil {
		return nil, 400, err
	}
	localOnly := str(getProfileSettings(s.db, pid)["dataSource"]) == "sqlite"
	var seed M
	if localOnly || source == "" {
		seed, err = getPostByID(s.db, id, pid)
	} else {
		var posts []M
		posts, err = s.sourcePosts(ctx, source, "id:"+raw, 1)
		for _, p := range posts {
			if str(p["id"]) == id {
				seed = p
			}
		}
	}
	if err != nil {
		return nil, 502, err
	}
	if seed == nil || len(s.visiblePosts([]M{seed}, pid)) == 0 {
		return nil, 404, fmt.Errorf("帖子不存在")
	}
	root := firstNonEmpty(str(seed["parentId"]), id)
	posts := []M{seed}
	if localOnly || source == "" {
		if parent, e := getPostByID(s.db, root, pid); e != nil {
			return nil, 500, e
		} else if parent != nil && root != id {
			posts = append(posts, parent)
		}
		children, e := getPosts(s.db, postFilter{ParentID: root, ProfileID: pid})
		if e != nil {
			return nil, 500, e
		}
		posts = append(posts, children...)
	} else {
		if root != id {
			parents, e := s.sourcePosts(ctx, source, "id:"+strings.TrimPrefix(root, source+"-"), 1)
			if e != nil {
				return nil, 502, e
			}
			for _, p := range parents {
				if str(p["id"]) == root {
					posts = append(posts, p)
				}
			}
		}
		seenPages := map[string]bool{}
		for page := 1; ; page++ {
			if page > 40 {
				return nil, 502, fmt.Errorf("关联组超过查询限制，未完成")
			}
			children, e := s.sourcePosts(ctx, source, "parent:"+strings.TrimPrefix(root, source+"-"), page)
			if e != nil {
				return nil, 502, e
			}
			for _, p := range children {
				if str(p["parentId"]) == root {
					posts = append(posts, p)
				}
			}
			if len(children) < 100 {
				break
			}
			signature := str(children[0]["id"]) + ":" + str(children[len(children)-1]["id"])
			if seenPages[signature] {
				return nil, 502, fmt.Errorf("关联组分页未前进")
			}
			seenPages[signature] = true
		}
	}
	visible := s.visiblePosts(posts, pid)
	unique := []M{}
	seen := map[string]bool{}
	for _, p := range visible {
		key := str(p["id"])
		if seen[key] {
			continue
		}
		seen[key] = true
		unique = append(unique, p)
	}
	// 隐藏父帖的标识不随可见子帖输出。
	for i, p := range unique {
		n := M{}
		for k, v := range p {
			n[k] = v
		}
		if !seen[str(n["parentId"])] {
			n["parentId"] = nil
		}
		n["hasChildren"] = false
		for _, child := range visible {
			if str(child["parentId"]) == str(n["id"]) {
				n["hasChildren"] = true
			}
		}
		unique[i] = n
	}
	groupID := id
	if seen[root] {
		groupID = root
	}
	availability := "available"
	if source == "" {
		availability = "unsupported"
	}
	if localOnly {
		availability = "local-only"
	}
	return &postDetail{true, groupID, s.applyBookmarkState(unique, pid), source, !localOnly && source != "", availability}, 200, nil
}

func (s *server) detailProfile(w http.ResponseWriter, r *http.Request) (string, bool) {
	if _, present := r.URL.Query()["profileId"]; !present {
		return s.requireProfile(w, "default")
	}
	return s.optionalProfile(w, r, false)
}
func (s *server) postDetailHandler(w http.ResponseWriter, r *http.Request) {
	pid, ok := s.detailProfile(w, r)
	if !ok {
		return
	}
	ctx, cancel := context.WithTimeout(r.Context(), 30*time.Second)
	defer cancel()
	detail, code, err := s.resolveDetail(ctx, r.PathValue("id"), pid)
	if err != nil {
		errJSON(w, code, detailError(code))
		return
	}
	writeJSON(w, 200, detail)
}
func detailError(code int) string {
	switch code {
	case 400:
		return "无效的帖子 ID"
	case 404:
		return "帖子不存在"
	default:
		return "原站关联帖子暂时无法加载，请重试"
	}
}
