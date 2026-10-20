package main

import (
	"context"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"net/url"
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

func TestPostDetailAndChildrenRespectProfileRating(t *testing.T) {
	db, err := initDatabase(":memory:")
	if err != nil {
		t.Fatal(err)
	}
	_, _ = db.Exec("DELETE FROM posts")
	mk := func(id, rating string, parent any) M {
		return M{"id": id, "title": id, "artist": "a", "imageUrl": "https://x/" + id, "previewUrl": "https://x/" + id,
			"rating": rating, "createdAt": "2026-01-01T00:00:00Z", "tags": []M{}, "parentId": parent}
	}
	if _, err := syncDanbooruToDB(db, []M{mk("test-parent", "general", nil), mk("test-safe-child", "general", "test-parent"), mk("test-explicit-child", "explicit", "test-parent")}); err != nil {
		t.Fatal(err)
	}
	if _, err := setProfileSettings(db, defaultProfileID, M{"rating": "general"}); err != nil {
		t.Fatal(err)
	}
	h := withMiddleware((&server{db: db, media: newMediaCache(db, t.TempDir())}).routes())

	if w := do(h, "GET", "/api/posts/test-explicit-child?profileId=default", ""); w.Code != 404 {
		t.Fatalf("explicit detail status = %d, body = %s", w.Code, w.Body.String())
	}
	if w := do(h, "GET", "/api/posts/missing?profileId=default", ""); w.Code != 404 {
		t.Fatalf("missing detail status = %d, body = %s", w.Code, w.Body.String())
	}
	w := do(h, "GET", "/api/posts/test-parent/children?profileId=default", "")
	var res struct{ Posts []M }
	if w.Code != 200 || json.Unmarshal(w.Body.Bytes(), &res) != nil || len(res.Posts) != 1 || str(res.Posts[0]["id"]) != "test-safe-child" {
		t.Fatalf("children status = %d, body = %s", w.Code, w.Body.String())
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

func TestTimelineUsesProfileRatingAndReportsLocalFallback(t *testing.T) {
	db, err := initDatabase(":memory:")
	if err != nil {
		t.Fatal(err)
	}
	seed := []M{
		{"id": "danbooru-1", "title": "safe", "artist": "a", "imageUrl": "https://x/1.jpg", "previewUrl": "https://x/1.jpg", "rating": "general", "createdAt": "2026-01-03T00:00:00Z", "tags": []M{}},
	}
	_, _ = db.Exec("DELETE FROM posts WHERE id NOT IN ('danbooru-1')")
	if _, err := syncDanbooruToDB(db, seed); err != nil {
		t.Fatal(err)
	}
	if _, err := setProfileSettings(db, defaultProfileID, M{"dataSource": "sqlite", "rating": "general"}); err != nil {
		t.Fatal(err)
	}
	s := &server{db: db, media: newMediaCache(db, t.TempDir())}
	h := withMiddleware(s.routes())

	w := do(h, http.MethodGet, "/api/danbooru/posts?profileId=default&limit=10", "")
	if w.Code != http.StatusOK {
		t.Fatal(w.Code, w.Body.String())
	}
	var res struct {
		Source, Fallback string
		Posts            []M
	}
	if err := json.Unmarshal(w.Body.Bytes(), &res); err != nil {
		t.Fatal(err)
	}
	if res.Source != "sqlite" || res.Fallback != "" || len(res.Posts) != 1 {
		t.Fatalf("source=%q fallback=%q posts=%d", res.Source, res.Fallback, len(res.Posts))
	}
}

func TestTimelineOnlineFailureFallsBackToCacheAndForcesRating(t *testing.T) {
	db, err := initDatabase(":memory:")
	if err != nil {
		t.Fatal(err)
	}
	_, _ = db.Exec("DELETE FROM posts")
	posts := []M{
		{"id": "danbooru-1", "title": "safe", "artist": "a", "imageUrl": "https://x/1.jpg", "previewUrl": "https://x/1.jpg", "rating": "general", "createdAt": "2026-01-03T00:00:00Z", "tags": []M{}},
		{"id": "danbooru-2", "title": "explicit", "artist": "a", "imageUrl": "https://x/2.jpg", "previewUrl": "https://x/2.jpg", "rating": "explicit", "createdAt": "2026-01-02T00:00:00Z", "tags": []M{}},
	}
	if _, err := syncDanbooruToDB(db, posts); err != nil {
		t.Fatal(err)
	}
	if _, err := setProfileSettings(db, defaultProfileID, M{"dataSource": "danbooru", "rating": "general"}); err != nil {
		t.Fatal(err)
	}
	var requested string
	upstream := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		requested = r.URL.Query().Get("tags")
		http.NotFound(w, r)
	}))
	defer upstream.Close()
	s := &server{db: db, media: newMediaCache(db, t.TempDir()), marketURL: upstream.URL}
	h := withMiddleware(s.routes())

	w := do(h, http.MethodGet, "/api/danbooru/posts?profileId=default&limit=10", "")
	var res struct {
		Source, Fallback string
		Posts            []M
	}
	if w.Code != http.StatusOK || json.Unmarshal(w.Body.Bytes(), &res) != nil {
		t.Fatal(w.Code, w.Body.String())
	}
	if !strings.Contains(requested, "rating:general") || res.Source != "sqlite" || res.Fallback != "online-unavailable" {
		t.Fatalf("requested=%q source=%q fallback=%q", requested, res.Source, res.Fallback)
	}
	for _, p := range res.Posts {
		if p["rating"] != "general" {
			t.Fatal("越级作品泄露", p["rating"])
		}
	}
}

func TestTimelineOnlineRatingMismatchFallsBackSafely(t *testing.T) {
	upstream := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		_, _ = w.Write([]byte(`[{"id":7,"rating":"e","image_width":100,"image_height":100,"file_url":"https://x/7.jpg","created_at":"2026-01-01T00:00:00Z"}]`))
	}))
	defer upstream.Close()
	db, err := initDatabase(":memory:")
	if err != nil {
		t.Fatal(err)
	}
	_, _ = db.Exec("DELETE FROM posts")
	s := &server{db: db, media: newMediaCache(db, t.TempDir()), marketURL: upstream.URL}
	h := withMiddleware(s.routes())
	w := do(h, http.MethodGet, "/api/danbooru/posts?profileId=default&limit=10", "")
	var res struct {
		Source   string
		Fallback string
		Posts    []M
	}
	if json.Unmarshal(w.Body.Bytes(), &res) != nil {
		t.Fatal(w.Body.String())
	}
	if res.Source != "sqlite" || res.Fallback != "rating-filtered" || len(res.Posts) != 0 {
		t.Fatalf("source=%q fallback=%q posts=%d", res.Source, res.Fallback, len(res.Posts))
	}
}

func TestTimelineLocalCursorContinuesWithoutResetting(t *testing.T) {
	db, err := initDatabase(":memory:")
	if err != nil {
		t.Fatal(err)
	}
	_, _ = db.Exec("DELETE FROM posts")
	var posts []M
	for i := 1; i <= 3; i++ {
		posts = append(posts, M{"id": "post-" + string(rune('0'+i)), "title": "t", "artist": "a", "imageUrl": "https://x/" + string(rune('0'+i)), "previewUrl": "https://x/" + string(rune('0'+i)), "rating": "general", "createdAt": "2026-01-0" + string(rune('0'+i)) + "T00:00:00Z", "tags": []M{}})
	}
	if _, err := syncDanbooruToDB(db, posts); err != nil {
		t.Fatal(err)
	}
	if _, err := setProfileSettings(db, defaultProfileID, M{"dataSource": "sqlite"}); err != nil {
		t.Fatal(err)
	}
	h := withMiddleware((&server{db: db, media: newMediaCache(db, t.TempDir())}).routes())
	w := do(h, http.MethodGet, "/api/danbooru/posts?profileId=default&limit=2", "")
	var first struct {
		Posts      []M
		NextCursor string
	}
	if json.Unmarshal(w.Body.Bytes(), &first) != nil || len(first.Posts) != 2 || first.NextCursor == "" {
		t.Fatal(w.Body.String())
	}
	w = do(h, http.MethodGet, "/api/danbooru/posts?profileId=default&limit=2&cursor="+url.QueryEscape(first.NextCursor), "")
	var second struct {
		Posts      []M
		NextCursor string
	}
	if json.Unmarshal(w.Body.Bytes(), &second) != nil || len(second.Posts) != 1 || second.NextCursor != "" {
		t.Fatal(w.Body.String())
	}
	if str(second.Posts[0]["id"]) != "post-1" {
		t.Fatal(second.Posts[0]["id"])
	}
}

func TestDanbooruSearchRequiresEveryTagAndKeepsRatingBoundary(t *testing.T) {
	db, err := initDatabase(":memory:")
	if err != nil {
		t.Fatal(err)
	}
	_, _ = db.Exec("DELETE FROM posts")
	posts := []M{
		{"id": "danbooru-1", "title": "both", "artist": "a", "imageUrl": "https://x/1.jpg", "previewUrl": "https://x/1.jpg", "rating": "general", "createdAt": "2026-01-03T00:00:00Z", "tags": []M{{"id": "tag-cat", "name": "cat_ears", "category": "general"}, {"id": "tag-blue", "name": "blue_eyes", "category": "general"}}},
		{"id": "danbooru-2", "title": "one", "artist": "a", "imageUrl": "https://x/2.jpg", "previewUrl": "https://x/2.jpg", "rating": "general", "createdAt": "2026-01-02T00:00:00Z", "tags": []M{{"id": "tag-cat", "name": "cat_ears", "category": "general"}}},
		{"id": "danbooru-3", "title": "explicit both", "artist": "a", "imageUrl": "https://x/3.jpg", "previewUrl": "https://x/3.jpg", "rating": "explicit", "createdAt": "2026-01-01T00:00:00Z", "tags": []M{{"id": "tag-cat", "name": "cat_ears", "category": "general"}, {"id": "tag-blue", "name": "blue_eyes", "category": "general"}}},
	}
	if _, err := syncDanbooruToDB(db, posts); err != nil {
		t.Fatal(err)
	}
	if _, err := setProfileSettings(db, defaultProfileID, M{"dataSource": "sqlite", "rating": "general"}); err != nil {
		t.Fatal(err)
	}
	h := withMiddleware((&server{db: db, media: newMediaCache(db, t.TempDir())}).routes())
	w := do(h, http.MethodGet, "/api/danbooru/posts?profileId=default&limit=10&tags="+url.QueryEscape("cat_ears blue_eyes"), "")
	var res struct {
		Posts []M
	}
	if w.Code != http.StatusOK || json.Unmarshal(w.Body.Bytes(), &res) != nil {
		t.Fatal(w.Code, w.Body.String())
	}
	if len(res.Posts) != 1 || str(res.Posts[0]["id"]) != "danbooru-1" {
		t.Fatalf("expected only the general post with both tags, got %#v", res.Posts)
	}
}

func TestBuildDanbooruQueryTagsKeepsSpacedQuery(t *testing.T) {
	if got := buildDanbooruQueryTags(" cat_ears  blue_eyes ", "general"); got != "cat_ears blue_eyes rating:general" {
		t.Fatalf("got %q", got)
	}
}
