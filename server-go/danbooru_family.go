package main

import (
	"context"
	"fmt"
	"net/http"
	"net/url"
	"strconv"
	"strings"
	"time"
)

func (s *server) danbooruFamilyHandler(w http.ResponseWriter, r *http.Request) {
	pid, ok := s.optionalProfile(w, r, false)
	if !ok {
		return
	}
	id := strings.TrimPrefix(r.PathValue("id"), "danbooru-")
	if n, err := strconv.ParseUint(id, 10, 64); err != nil || n == 0 {
		errJSON(w, 400, "无效的 Danbooru 帖子 ID")
		return
	}
	settings := getProfileSettings(s.db, pid)
	rating := orDefault(str(settings["rating"]), "general")
	if str(settings["dataSource"]) == "sqlite" {
		posts, err := getPosts(s.db, postFilter{ParentID: "danbooru-" + id, Rating: rating, ProfileID: pid})
		if err != nil {
			s.fail500(w, "DANBOORU_FAMILY", "Failed to list cached family", err)
			return
		}
		if parent, err := getPostByID(s.db, "danbooru-"+id, pid); err != nil {
			s.fail500(w, "DANBOORU_FAMILY", "Failed to read cached parent", err)
			return
		} else if parent != nil && postRatingAllowed(str(parent["rating"]), rating) {
			posts = append([]M{parent}, posts...)
		}
		writeJSON(w, 200, M{"success": true, "posts": s.visiblePosts(posts, orDefault(pid, "default")), "source": "sqlite"})
		return
	}
	base := danbooruAPIURL
	if s.marketURL != "" {
		base = s.marketURL + "/danbooru/posts.json"
	}
	ctx, cancel := context.WithTimeout(r.Context(), 25*time.Second)
	defer cancel()
	posts, err := fetchDanbooruFamily(ctx, base, id, rating)
	if err != nil {
		appendServerLog("WARN", "DANBOORU_FAMILY", "Failed to fetch related posts", err.Error())
		errJSON(w, 502, "关联媒体暂时无法加载，请重试")
		return
	}
	writeJSON(w, 200, M{"success": true, "posts": s.visiblePosts(posts, orDefault(pid, "default")), "source": "danbooru"})
}

func fetchDanbooruFamily(ctx context.Context, base, id, rating string) ([]M, error) {
	posts := []M{}
	seen := map[string]bool{}
	for _, tag := range []string{"id:" + id, "parent:" + id} {
		before := ""
		for {
			q := url.Values{"tags": {buildDanbooruQueryTags(tag, rating)}, "limit": {"100"}}
			if before != "" {
				q.Set("page", "b"+before)
			}
			raw, ok, err := fetchJSONArray(ctx, base+"?"+q.Encode())
			if err != nil {
				return nil, err
			}
			if !ok {
				return nil, fmt.Errorf("Danbooru family %s unavailable", id)
			}
			for _, item := range raw {
				postID := str(item["id"])
				if seen[postID] || item["is_deleted"] == true || item["is_banned"] == true {
					continue
				}
				if postID != id && str(item["parent_id"]) != id {
					continue
				}
				p := transformDanbooruPost(item)
				if !postRatingAllowed(str(p["rating"]), rating) {
					continue
				}
				seen[postID] = true
				posts = append(posts, p)
			}
			if tag == "id:"+id || len(raw) < 100 {
				break
			}
			next := str(raw[len(raw)-1]["id"])
			if next == before || next == "" {
				return nil, fmt.Errorf("Danbooru family cursor did not advance")
			}
			before = next
		}
	}
	return posts, nil
}
