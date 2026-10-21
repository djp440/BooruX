package main

import (
	"context"
	"encoding/base64"
	"encoding/json"
	"encoding/xml"
	"fmt"
	"io"
	"net/http"
	"net/url"
	"sort"
	"strconv"
	"strings"
	"time"
)

type sourceComment struct {
	ID        string `json:"id"`
	PostID    string `json:"postId"`
	Source    string `json:"source"`
	Author    string `json:"author"`
	CreatedAt string `json:"createdAt"`
	Body      string `json:"body"`
	SourceURL string `json:"sourceUrl"`
}

type commentCursor struct {
	Member string `json:"member"`
	After  string `json:"after"`
}

func commentTime(value string) (string, error) {
	for _, layout := range []string{time.RFC3339Nano, "2006-01-02 15:04:05", "Mon Jan 2 15:04:05 -0700 2006"} {
		if t, e := time.Parse(layout, value); e == nil {
			return t.UTC().Format("2006-01-02T15:04:05.000000000Z"), nil
		}
	}
	return "", fmt.Errorf("评论时间无效")
}

// Moebooru 按 ID 而非时间分页；先有界遍历到末页再排序，不能仅排序单页。
func (s *server) readComments(ctx context.Context, source, raw string) ([]sourceComment, error) {
	out := []sourceComment{}
	seen := map[string]bool{}
	previousPages := map[string]bool{}
	for page := 1; page <= 40; page++ {
		q := url.Values{}
		path := "/comments.json"
		pageSize := 100
		switch source {
		case "danbooru":
			q.Set("only", "id,post_id,body,created_at,creator_id,is_deleted,is_hidden,is_spam,creator[name]")
			q.Set("search[post_id]", raw)
			q.Set("search[order]", "id_desc")
			q.Set("limit", "100")
			q.Set("page", strconv.Itoa(page))
		case "yandere":
			path = "/comment.json"
			q.Set("post_id", raw)
			q.Set("page", strconv.Itoa(page))
			pageSize = 25
		case "safebooru":
			path = "/index.php"
			q.Set("page", "dapi")
			q.Set("s", "comment")
			q.Set("q", "index")
			q.Set("post_id", raw)
			q.Set("limit", "100")
			q.Set("pid", strconv.Itoa(page-1))
		default:
			return nil, fmt.Errorf("不支持的来源")
		}
		b, err := readSource(ctx, s.sourceURL(source, path)+"?"+q.Encode())
		if err != nil {
			return nil, err
		}
		var items []M
		if source == "safebooru" {
			var doc struct {
				XMLName  xml.Name `xml:"comments"`
				Comments []struct {
					ID        string `xml:"id,attr"`
					PostID    string `xml:"post_id,attr"`
					Author    string `xml:"creator,attr"`
					CreatedAt string `xml:"created_at,attr"`
					Body      string `xml:"body,attr"`
					Deleted   bool   `xml:"is_deleted,attr"`
					Hidden    bool   `xml:"is_hidden,attr"`
				} `xml:"comment"`
			}
			if err = xml.Unmarshal(b, &doc); err != nil {
				return nil, fmt.Errorf("评论 XML 无效: %w", err)
			}
			for _, c := range doc.Comments {
				items = append(items, M{"id": c.ID, "post_id": c.PostID, "creator": c.Author, "created_at": c.CreatedAt, "body": c.Body, "is_deleted": c.Deleted, "is_hidden": c.Hidden})
			}
		} else {
			dec := json.NewDecoder(strings.NewReader(string(b)))
			dec.UseNumber()
			if err = dec.Decode(&items); err != nil {
				return nil, fmt.Errorf("评论 JSON 无效: %w", err)
			}
			if items == nil || dec.Decode(new(any)) != io.EOF {
				return nil, fmt.Errorf("评论响应不是完整数组")
			}
		}
		signature := ""
		newCount := 0
		for _, item := range items {
			id := str(item["id"])
			signature += id + ","
			if n, e := strconv.ParseUint(id, 10, 64); e != nil || n == 0 {
				return nil, fmt.Errorf("评论 ID 无效")
			}
			if str(item["post_id"]) != raw {
				return nil, fmt.Errorf("评论所属帖子不匹配")
			}
			if seen[id] {
				continue
			}
			seen[id] = true
			newCount++
			if item["is_deleted"] == true || item["is_hidden"] == true || item["is_spam"] == true {
				continue
			}
			created, err := commentTime(str(item["created_at"]))
			if err != nil {
				return nil, err
			}
			author := str(item["creator_name"])
			if creator, ok := item["creator"].(map[string]any); ok {
				author = firstNonEmpty(str(creator["name"]), author)
			} else {
				author = firstNonEmpty(str(item["creator"]), author)
			}
			if author == "" {
				if uid := str(item["creator_id"]); uid != "" {
					author = "用户 #" + uid
				} else {
					author = "未知作者"
				}
			}
			href := "https://danbooru.donmai.us/posts/" + raw + "#comment_" + id
			if source == "yandere" {
				href = "https://yande.re/post/show/" + raw + "#c" + id
			}
			if source == "safebooru" {
				href = "https://safebooru.org/index.php?page=post&s=view&id=" + raw + "#comment" + id
			}
			out = append(out, sourceComment{id, source + "-" + raw, source, author, created, str(item["body"]), href})
		}
		if len(items) < pageSize {
			sort.Slice(out, func(i, j int) bool {
				if out[i].CreatedAt != out[j].CreatedAt {
					return out[i].CreatedAt > out[j].CreatedAt
				}
				return out[i].ID < out[j].ID
			})
			return out, nil
		}
		if newCount == 0 || previousPages[signature] {
			return nil, fmt.Errorf("评论分页未前进")
		}
		previousPages[signature] = true
	}
	return nil, fmt.Errorf("评论超过有界查询限制，尚未加载完成")
}

func (s *server) postCommentsHandler(w http.ResponseWriter, r *http.Request) {
	pid, ok := s.detailProfile(w, r)
	if !ok {
		return
	}
	// 本地模式在游标、成员和上游解析之前短路，绝不访问原站。
	if str(getProfileSettings(s.db, pid)["dataSource"]) == "sqlite" {
		writeJSON(w, 200, M{"success": true, "availability": "local-only", "comments": []sourceComment{}, "nextCursor": nil, "exhausted": false})
		return
	}
	ctx, cancel := context.WithTimeout(r.Context(), 45*time.Second)
	defer cancel()
	detail, code, err := s.resolveDetail(ctx, r.PathValue("id"), pid)
	if err != nil {
		errJSON(w, code, detailError(code))
		return
	}
	if detail.CommentsAvailability != "available" {
		writeJSON(w, 200, M{"success": true, "availability": detail.CommentsAvailability, "comments": []sourceComment{}, "nextCursor": nil, "exhausted": false})
		return
	}
	member := r.URL.Query().Get("memberId")
	visible := false
	for _, p := range detail.Posts {
		if str(p["id"]) == member {
			visible = true
		}
	}
	if !visible {
		errJSON(w, 404, "帖子不存在")
		return
	}
	after := ""
	cursor := r.URL.Query().Get("cursor")
	if cursor != "" {
		b, e := base64.RawURLEncoding.DecodeString(cursor)
		var c commentCursor
		if e != nil || len(b) > 1024 || json.Unmarshal(b, &c) != nil || c.Member != member || c.After == "" {
			errJSON(w, 400, "评论游标无效")
			return
		}
		after = c.After
	}
	limit := 25
	if raw := r.URL.Query().Get("limit"); raw != "" {
		n, e := strconv.Atoi(raw)
		if e != nil || n < 1 || n > 100 {
			errJSON(w, 400, "评论条数无效")
			return
		}
		limit = n
	}
	source, raw, _ := sourceID(member)
	comments, err := s.readComments(ctx, source, raw)
	if err != nil {
		errJSON(w, 502, "原站评论暂时无法加载，请重试")
		return
	}
	start := 0
	if after != "" {
		found := false
		for i, c := range comments {
			if c.ID == after {
				start = i + 1
				found = true
				break
			}
		}
		if !found {
			errJSON(w, 409, "评论已变化，请重新加载评论")
			return
		}
	}
	end := min(start+limit, len(comments))
	var next any
	if end < len(comments) {
		b, _ := json.Marshal(commentCursor{member, comments[end-1].ID})
		next = base64.RawURLEncoding.EncodeToString(b)
	}
	writeJSON(w, 200, M{"success": true, "availability": "available", "memberId": member, "comments": comments[start:end], "nextCursor": next, "exhausted": end == len(comments)})
}
