package main

import (
	"context"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
)

func testServer(t *testing.T) http.Handler {
	t.Helper()
	db, err := initDatabase(":memory:")
	if err != nil {
		t.Fatal(err)
	}
	return withMiddleware((&server{db: db, media: newMediaCache(db, t.TempDir())}).routes())
}

func do(h http.Handler, method, path, body string) *httptest.ResponseRecorder {
	r := httptest.NewRequest(method, path, strings.NewReader(body))
	r.Header.Set("Content-Type", "application/json")
	w := httptest.NewRecorder()
	h.ServeHTTP(w, r)
	return w
}

func TestHealthAndBookmarkFlow(t *testing.T) {
	h := testServer(t)
	if w := do(h, "GET", "/api/health", ""); w.Code != 200 || !strings.Contains(w.Body.String(), `"status":"ok"`) {
		t.Fatal(w.Body.String())
	}
	if w := do(h, "POST", "/api/posts/post-101/bookmark?profileId=default", "{}"); w.Code != 200 {
		t.Fatal(w.Body.String())
	}
	if w := do(h, "GET", "/api/profiles/default/bookmarks", ""); !strings.Contains(w.Body.String(), `"count":1`) {
		t.Fatal(w.Body.String())
	}
	if w := do(h, "GET", "/api/posts?profileId=", ""); w.Code != 400 {
		t.Fatal(w.Code)
	}
	if w := do(h, "GET", "/api/posts?profileId=nope", ""); w.Code != 404 {
		t.Fatal(w.Code)
	}
}

func TestTagFilterAndIntent(t *testing.T) {
	post := M{"tags": []M{{"name": "ai_generated"}}}
	f := map[string]any{"blacklistEnabled": true, "blacklist": []any{"ai"}}
	if isPostAllowed(post, f) {
		t.Fatal("ai should be blocked")
	}
	if !isPostAllowed(M{"tags": []M{{"name": "maid"}}}, f) {
		t.Fatal("maid must not be blocked")
	}
	if !explicitBookmarkIntent("收藏作品 post-101", "post-101", true) || explicitBookmarkIntent("也许收藏 post-101", "post-101", true) {
		t.Fatal("intent mismatch")
	}
}

func TestPostsCursorPagination(t *testing.T) {
	h := testServer(t)
	seen := map[string]bool{}
	cursor := ""
	for i := 0; i < 50; i++ {
		path := "/api/posts?limit=2"
		if cursor != "" {
			path += "&cursor=" + cursor
		}
		w := do(h, "GET", path, "")
		var res struct {
			Posts      []M
			NextCursor string
		}
		if w.Code != 200 || json.Unmarshal(w.Body.Bytes(), &res) != nil {
			t.Fatal(w.Code, w.Body.String())
		}
		for _, p := range res.Posts {
			id := str(p["id"])
			if seen[id] {
				t.Fatal("重复作品", id)
			}
			seen[id] = true
		}
		if res.NextCursor == "" {
			break
		}
		cursor = res.NextCursor
	}
	if len(seen) < 3 {
		t.Fatal("游标未遍历全部种子数据", len(seen))
	}
	if w := do(h, "GET", "/api/posts?cursor=!!bad", ""); w.Code != 400 {
		t.Fatal(w.Code)
	}
}

func TestParentChildFields(t *testing.T) {
	d := transformDanbooruPost(M{"id": float64(2), "parent_id": float64(1), "has_children": true, "file_url": "https://x/a.jpg", "preview_file_url": "https://x/p.jpg"})
	if d["parentId"] != "danbooru-1" || d["hasChildren"] != true {
		t.Fatal(d["parentId"], d["hasChildren"])
	}
	if p := transformDanbooruPost(M{"id": float64(1), "parent_id": nil}); p["parentId"] != nil || p["hasChildren"] != false {
		t.Fatal(p["parentId"], p["hasChildren"])
	}
	y := transformYanderePost(M{"id": float64(9), "parent_id": float64(8), "has_children": false, "sample_url": "https://x/y.jpg"})
	if y["parentId"] != "yandere-8" {
		t.Fatal(y["parentId"])
	}
}

func TestChildrenEndpoint(t *testing.T) {
	db, err := initDatabase(":memory:")
	if err != nil {
		t.Fatal(err)
	}
	h := withMiddleware((&server{db: db, media: newMediaCache(db, t.TempDir())}).routes())
	mk := func(id string, parent any, has bool) M {
		return M{"id": id, "title": id, "artist": "a", "imageUrl": "https://x/" + id, "previewUrl": "https://x/" + id, "rating": "general",
			"createdAt": "2026-01-01T00:00:00Z", "tags": []M{}, "parentId": parent, "hasChildren": has}
	}
	if _, err := syncDanbooruToDB(db, []M{mk("danbooru-1", nil, true), mk("danbooru-2", "danbooru-1", false), mk("danbooru-3", "danbooru-1", false)}); err != nil {
		t.Fatal(err)
	}
	w := do(h, "GET", "/api/posts/danbooru-1/children", "")
	var res struct{ Posts []M }
	if w.Code != 200 || json.Unmarshal(w.Body.Bytes(), &res) != nil || len(res.Posts) != 2 {
		t.Fatal(w.Code, w.Body.String())
	}
	w = do(h, "GET", "/api/posts/danbooru-2", "")
	if !strings.Contains(w.Body.String(), `"parentId":"danbooru-1"`) {
		t.Fatal(w.Body.String())
	}
	w = do(h, "GET", "/api/posts/danbooru-1", "")
	if !strings.Contains(w.Body.String(), `"hasChildren":true`) {
		t.Fatal(w.Body.String())
	}
}

func TestArtistNotFaked(t *testing.T) {
	y := transformYanderePost(M{"id": float64(9), "author": "uploader", "sample_url": "https://x/y.jpg"})
	s := transformSafebooruPost(M{"id": float64(7), "owner": "danbooru", "file_url": "https://x/s.jpg"})
	d := transformDanbooruPost(M{"id": float64(2), "tag_string_artist": "real_artist other", "file_url": "https://x/a.jpg"})
	if y["artist"] != "Unknown_Artist" || s["artist"] != "Unknown_Artist" || d["artist"] != "real_artist" {
		t.Fatal(y["artist"], s["artist"], d["artist"])
	}
}

func TestDanbooruBeforeCursor(t *testing.T) {
	var gotPage string
	status := 200
	body := `[{"id":99,"file_url":"https://x/a.jpg","preview_file_url":"https://x/p.jpg"}]`
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		gotPage = r.URL.Query().Get("page")
		w.WriteHeader(status)
		_, _ = w.Write([]byte(body))
	}))
	defer srv.Close()
	ctx := context.Background()
	posts, err := fetchDanbooruPosts(ctx, danbooruOptions{BaseURL: srv.URL, BeforeID: "100", Limit: 1})
	if err != nil || len(posts) != 1 || gotPage != "b100" {
		t.Fatal(err, len(posts), gotPage)
	}
	// 到底：Danbooru 正常返回空数组，不能回退到其他源拿到无关作品
	body = `[]`
	if posts, err = fetchDanbooruPosts(ctx, danbooruOptions{BaseURL: srv.URL, BeforeID: "99"}); err != nil || len(posts) != 0 {
		t.Fatal(err, len(posts))
	}
	// Danbooru 不可用：带游标时报错，交给路由回退本地库
	status = 500
	if _, err = fetchDanbooruPosts(ctx, danbooruOptions{BaseURL: srv.URL, BeforeID: "99"}); err == nil {
		t.Fatal("应返回错误")
	}
}

func TestDanbooruRouteCursorFallsBackToLocal(t *testing.T) {
	db, err := initDatabase(":memory:")
	if err != nil {
		t.Fatal(err)
	}
	mk := func(id, at string) M {
		return M{"id": id, "title": id, "artist": "a", "imageUrl": "https://x/" + id, "previewUrl": "https://x/" + id, "rating": "general", "createdAt": at, "tags": []M{}}
	}
	_, _ = syncDanbooruToDB(db, []M{mk("danbooru-3", "2026-01-03T00:00:00Z"), mk("danbooru-2", "2026-01-02T00:00:00Z"), mk("danbooru-1", "2026-01-01T00:00:00Z")})
	s := &server{db: db, media: newMediaCache(db, t.TempDir())}
	id, ok := s.cursorFromDanbooruID("3")
	if !ok {
		t.Fatal("本地应能由 Danbooru id 还原游标")
	}
	createdAt, pid, _ := decodeCursor(id)
	if createdAt != "2026-01-03T00:00:00Z" || pid != "danbooru-3" {
		t.Fatal(createdAt, pid)
	}
}

func TestChatStateExplicitlyReportsNoProvider(t *testing.T) {
	h := testServer(t)
	w := do(h, http.MethodGet, "/api/profiles/default/chat", "")
	if w.Code != http.StatusOK {
		t.Fatalf("status = %d, body = %q", w.Code, w.Body.String())
	}
	if got := w.Body.String(); !strings.Contains(got, "\"configured\":false") || !strings.Contains(got, "\"messages\":[]") {
		t.Fatalf("body = %s", got)
	}
}
