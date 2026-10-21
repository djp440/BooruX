package main

import (
	"context"
	"encoding/json"
	"fmt"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
)

func TestPostDetailAndCommentsFilterTrustedMembers(t *testing.T) {
	db, e := initDatabase(":memory:")
	if e != nil {
		t.Fatal(e)
	}
	defer db.Close()
	_, e = setProfileSettings(db, "default", M{"rating": "general", "tagFilter": M{"blacklistEnabled": true, "blacklist": []any{"blocked"}}})
	if e != nil {
		t.Fatal(e)
	}
	calls := []string{}
	upstream := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		calls = append(calls, r.URL.Path+"?"+r.URL.RawQuery)
		if strings.HasSuffix(r.URL.Path, "comments.json") {
			writeJSON(w, 200, []M{{"id": "9007199254740993", "post_id": 2, "body": "<script>safe text</script>\nhttps://example.org", "created_at": "2025-01-01T00:00:00Z", "creator_name": "作者"}})
			return
		}
		post := func(id, parent int, tags, rating string) M {
			return M{"id": id, "parent_id": parent, "tag_string_general": tags, "rating": rating, "file_url": "https://example.org/original.png"}
		}
		switch r.URL.Query().Get("tags") {
		case "id:2":
			writeJSON(w, 200, []M{post(2, 1, "visible", "g")})
		case "id:1":
			writeJSON(w, 200, []M{post(1, 0, "blocked", "g")})
		case "id:3":
			writeJSON(w, 200, []M{post(3, 1, "blocked", "g")})
		default:
			writeJSON(w, 200, []M{post(2, 1, "visible", "g"), post(3, 1, "blocked", "g"), post(4, 1, "visible", "e")})
		}
	}))
	defer upstream.Close()
	s := &server{db: db, marketURL: upstream.URL}
	h := s.routes()
	w := do(h, "GET", "/api/posts/danbooru-2/detail", "")
	if w.Code != 200 {
		t.Fatalf("%d %s", w.Code, w.Body.String())
	}
	var d postDetail
	if e = json.Unmarshal(w.Body.Bytes(), &d); e != nil {
		t.Fatal(e)
	}
	if len(d.Posts) != 1 || d.GroupID != "danbooru-2" || d.Posts[0]["parentId"] != nil || strings.Contains(w.Body.String(), "blocked") {
		t.Fatal(w.Body.String())
	}
	for _, member := range []string{"danbooru-1", "danbooru-3", "danbooru-4", "danbooru-99"} {
		before := len(calls)
		w = do(h, "GET", "/api/posts/danbooru-2/comments?memberId="+member, "")
		if w.Code != 404 {
			t.Fatal(w.Code, w.Body.String())
		}
		for _, call := range calls[before:] {
			if strings.Contains(call, "comments.json") {
				t.Fatal("hidden member requested comments", call)
			}
		}
	}
	w = do(h, "GET", "/api/posts/danbooru-2/comments?memberId=danbooru-2", "")
	if w.Code != 200 || !strings.Contains(w.Body.String(), "9007199254740993") || !strings.Contains(w.Body.String(), "作者") {
		t.Fatal(w.Code, w.Body.String())
	}
	w = do(h, "GET", "/api/posts/danbooru-3/detail", "")
	if w.Code != 404 {
		t.Fatal(w.Code, w.Body.String())
	}
	for _, path := range []string{"/api/posts/danbooru-0/detail", "/api/posts/danbooru-2/detail?profileId=", "/api/posts/danbooru-02/detail"} {
		if w = do(h, "GET", path, ""); w.Code != 400 {
			t.Fatal(path, w.Code)
		}
	}
}

func TestPostCommentsLocalModeNeverRequestsUpstream(t *testing.T) {
	db, e := initDatabase(":memory:")
	if e != nil {
		t.Fatal(e)
	}
	defer db.Close()
	_, _ = setProfileSettings(db, "default", M{"dataSource": "sqlite"})
	_, _ = syncDanbooruToDB(db, []M{{"id": "danbooru-1", "rating": "general", "imageUrl": "https://example.org/original.png", "tags": []M{}}})
	count := 0
	upstream := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) { count++; w.WriteHeader(500) }))
	defer upstream.Close()
	h := (&server{db: db, marketURL: upstream.URL}).routes()
	for _, path := range []string{"/api/posts/danbooru-1/detail", "/api/posts/danbooru-1/comments?memberId=hidden&cursor=bad", "/api/posts/unknown/comments"} {
		w := do(h, "GET", path, "")
		if w.Code != 200 || !strings.Contains(w.Body.String(), "local-only") {
			t.Fatal(w.Code, w.Body.String())
		}
	}
	if count != 0 {
		t.Fatal("local mode requested upstream", count)
	}
}

func TestCommentSourceParsingSortingDedupAndPagination(t *testing.T) {
	for _, source := range []string{"danbooru", "yandere", "safebooru"} {
		t.Run(source, func(t *testing.T) {
			calls := 0
			upstream := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
				calls++
				if source == "safebooru" {
					fmt.Fprint(w, `<comments><comment id="2" post_id="1" creator="A &amp; B" created_at="2025-01-01 00:00:00" body="first&#10;&lt;b&gt;text&lt;/b&gt;"/><comment id="1" post_id="1" creator="C" created_at="2025-02-01 00:00:00" body="new"/></comments>`)
					return
				}
				size := 100
				if source == "yandere" {
					size = 25
				}
				items := []M{}
				if r.URL.Query().Get("page") == "1" {
					for i := 0; i < size; i++ {
						items = append(items, M{"id": fmt.Sprint(i + 100), "post_id": 1, "created_at": "2025-01-01T00:00:00Z", "creator": "author", "body": "old"})
					}
				} else {
					items = append(items, M{"id": "999", "post_id": 1, "created_at": "2025-02-01T00:00:00Z", "body": "new"}, M{"id": "100", "post_id": 1, "created_at": "2025-01-01T00:00:00Z", "body": "duplicate"})
				}
				writeJSON(w, 200, items)
			}))
			defer upstream.Close()
			s := &server{marketURL: upstream.URL}
			items, e := s.readComments(context.Background(), source, "1")
			if e != nil {
				t.Fatal(e)
			}
			if source == "safebooru" {
				if len(items) != 2 || items[0].ID != "1" || items[1].Body != "first\n<b>text</b>" || items[1].Author != "A & B" {
					t.Fatal(items)
				}
			} else {
				size := 101
				if source == "yandere" {
					size = 26
				}
				if len(items) != size || items[0].ID != "999" || calls != 2 {
					t.Fatal(len(items), items[0], calls)
				}
			}
		})
	}
}

func TestCommentSourceRejectsFailuresAndNoProgress(t *testing.T) {
	for _, kind := range []string{"status", "invalid", "time", "member", "repeat", "oversize", "deleted"} {
		t.Run(kind, func(t *testing.T) {
			upstream := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
				switch kind {
				case "status":
					w.WriteHeader(503)
					return
				case "invalid":
					fmt.Fprint(w, "<html>offline</html>")
					return
				case "oversize":
					fmt.Fprint(w, strings.Repeat("x", (4<<20)+1))
					return
				}
				p := M{"id": 1, "post_id": 1, "created_at": "2025-01-01T00:00:00Z", "body": "text"}
				if kind == "time" {
					p["created_at"] = "bad"
				}
				if kind == "member" {
					p["post_id"] = 2
				}
				if kind == "deleted" {
					p["is_deleted"] = true
				}
				items := []M{p}
				if kind == "repeat" {
					for len(items) < 100 {
						items = append(items, p)
					}
				}
				writeJSON(w, 200, items)
			}))
			defer upstream.Close()
			items, e := (&server{marketURL: upstream.URL}).readComments(context.Background(), "danbooru", "1")
			if kind == "deleted" {
				if e != nil || len(items) != 0 {
					t.Fatal(items, e)
				}
			} else if e == nil {
				t.Fatal("expected incomplete error", kind)
			}
		})
	}
}

func TestPostCommentsCursorAndUnsupported(t *testing.T) {
	db, e := initDatabase(":memory:")
	if e != nil {
		t.Fatal(e)
	}
	defer db.Close()
	_, _ = syncDanbooruToDB(db, []M{{"id": "custom-1", "rating": "general", "imageUrl": "https://example.org/a.png", "tags": []M{}}})
	upstream := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if strings.HasSuffix(r.URL.Path, "comments.json") {
			writeJSON(w, 200, []M{{"id": 2, "post_id": 1, "created_at": "2025-02-01T00:00:00Z"}, {"id": 1, "post_id": 1, "created_at": "2025-01-01T00:00:00Z"}})
			return
		}
		if strings.HasPrefix(r.URL.Query().Get("tags"), "id:") {
			writeJSON(w, 200, []M{{"id": 1, "rating": "g"}})
		} else {
			writeJSON(w, 200, []M{})
		}
	}))
	defer upstream.Close()
	h := (&server{db: db, marketURL: upstream.URL}).routes()
	path := "/api/posts/danbooru-1/comments?memberId=danbooru-1&limit=1"
	w := do(h, "GET", path, "")
	var page struct {
		NextCursor string
		Exhausted  bool
		Comments   []sourceComment
	}
	_ = json.Unmarshal(w.Body.Bytes(), &page)
	if w.Code != 200 || page.Exhausted || page.NextCursor == "" || page.Comments[0].ID != "2" {
		t.Fatal(w.Code, w.Body.String())
	}
	w = do(h, "GET", path+"&cursor="+page.NextCursor, "")
	if w.Code != 200 || !strings.Contains(w.Body.String(), `"exhausted":true`) {
		t.Fatal(w.Code, w.Body.String())
	}
	w = do(h, "GET", path+"&cursor=invalid", "")
	if w.Code != 400 {
		t.Fatal(w.Code)
	}
	w = do(h, "GET", "/api/posts/custom-1/comments", "")
	if w.Code != 200 || !strings.Contains(w.Body.String(), "unsupported") {
		t.Fatal(w.Code, w.Body.String())
	}
}

func TestCommentSafebooruPaginationDoesNotAssumeSingleSnapshot(t *testing.T) {
	upstream := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.URL.Query().Get("limit") != "100" {
			t.Error("missing bounded limit")
		}
		fmt.Fprint(w, `<comments>`)
		if r.URL.Query().Get("pid") == "0" {
			for i := 100; i < 200; i++ {
				fmt.Fprintf(w, `<comment id="%d" post_id="1" created_at="2025-01-01 00:00:00" body="old"/>`, i)
			}
		} else {
			fmt.Fprint(w, `<comment id="1" post_id="1" created_at="2025-02-01 00:00:00" body="new"/>`)
		}
		fmt.Fprint(w, `</comments>`)
	}))
	defer upstream.Close()
	comments, err := (&server{marketURL: upstream.URL}).readComments(context.Background(), "safebooru", "1")
	if err != nil || len(comments) != 101 || comments[0].ID != "1" {
		t.Fatal(len(comments), err)
	}
}

func TestPostDetailSourceOriginalMedia(t *testing.T) {
	y := transformYanderePost(M{"id": 1, "file_url": "https://example.org/original.png", "sample_url": "https://example.org/sample.jpg"})
	if y["imageUrl"] != "https://example.org/original.png" {
		t.Fatal(y)
	}
	y = transformYanderePost(M{"id": 1, "sample_url": "https://example.org/sample.jpg"})
	if y["imageUrl"] != "" {
		t.Fatal("sample presented as original", y)
	}
	safe := transformSafebooruPost(M{"id": 1, "file_url": "https://example.org/original.png", "sample_url": "https://example.org/sample.jpg"})
	if safe["imageUrl"] != "https://example.org/original.png" {
		t.Fatal(safe)
	}
}
