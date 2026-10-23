package main

import (
	"context"
	"fmt"
	"encoding/json"
	"io"
	"net/http"
	"net/http/httptest"
	"net/url"
	"strings"
	"sync"
	"testing"
	"time"
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

func TestFilterAllowedPosts(t *testing.T) {
	posts := []M{
		{"id": "a", "tags": []M{{"name": "blood_on_face"}}},
		{"id": "b", "tags": []M{{"name": "maid"}}},
	}
	enabled := map[string]any{"blacklistEnabled": true, "blacklist": []any{"blood"}}
	if got := filterAllowedPosts(posts, enabled); len(got) != 1 || got[0]["id"] != "b" {
		t.Fatalf("blood should block blood_on_face, got %v", got)
	}
	disabled := map[string]any{"blacklistEnabled": false, "blacklist": []any{"blood"}}
	if got := filterAllowedPosts(posts, disabled); len(got) != 2 {
		t.Fatalf("disabled blacklist must keep all posts, got %v", got)
	}
	if got := filterAllowedPosts(posts, nil); len(got) != 2 {
		t.Fatalf("missing filter must keep all posts, got %v", got)
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
	if got := w.Body.String(); !strings.Contains(got, "\"configured\":false") {
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

func TestBookmarksRespectProfileRating(t *testing.T) {
	db, err := initDatabase(":memory:")
	if err != nil {
		t.Fatal(err)
	}
	_, _ = db.Exec("DELETE FROM posts")
	posts := []M{
		{"id": "safe", "title": "safe", "artist": "a", "imageUrl": "https://x/1.jpg", "previewUrl": "https://x/1.jpg", "rating": "general", "createdAt": "2026-01-02T00:00:00Z", "tags": []M{}},
		{"id": "hidden", "title": "hidden", "artist": "a", "imageUrl": "https://x/2.jpg", "previewUrl": "https://x/2.jpg", "rating": "explicit", "createdAt": "2026-01-01T00:00:00Z", "tags": []M{}},
	}
	if _, err := syncDanbooruToDB(db, posts); err != nil {
		t.Fatal(err)
	}
	for _, id := range []string{"safe", "hidden"} {
		if _, err := setBookmark(db, defaultProfileID, id, true); err != nil {
			t.Fatal(err)
		}
	}
	if _, err := setProfileSettings(db, defaultProfileID, M{"rating": "general"}); err != nil {
		t.Fatal(err)
	}
	h := withMiddleware((&server{db: db, media: newMediaCache(db, t.TempDir())}).routes())
	w := do(h, http.MethodGet, "/api/profiles/default/bookmarks", "")
	var res struct {
		Count     int
		Bookmarks []M
	}
	if w.Code != http.StatusOK || json.Unmarshal(w.Body.Bytes(), &res) != nil {
		t.Fatal(w.Code, w.Body.String())
	}
	if res.Count != 1 || len(res.Bookmarks) != 1 || str(res.Bookmarks[0]["id"]) != "safe" {
		t.Fatalf("bookmarks leaked outside profile rating: %s", w.Body.String())
	}
}

func TestBookmarkOnlinePostPersistsForBookmarksRoute(t *testing.T) {
	db, err := initDatabase(":memory:")
	if err != nil {
		t.Fatal(err)
	}
	_, _ = db.Exec("DELETE FROM posts")
	upstream := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		_, _ = w.Write([]byte(`[{"id":42,"rating":"g","image_width":100,"image_height":100,"file_url":"https://x/42.jpg","created_at":"2026-01-01T00:00:00Z","tag_string":"solo"}]`))
	}))
	defer upstream.Close()
	s := &server{db: db, media: newMediaCache(db, t.TempDir()), marketURL: upstream.URL}
	h := withMiddleware(s.routes())
	w := do(h, http.MethodPost, "/api/posts/danbooru-42/bookmark?profileId=default", `{"bookmarked":true}`)
	if w.Code != http.StatusOK {
		t.Fatalf("bookmark: code=%d body=%q", w.Code, w.Body.String())
	}
	w = do(h, http.MethodGet, "/api/profiles/default/bookmarks", "")
	if w.Code != http.StatusOK || !strings.Contains(w.Body.String(), `"id":"danbooru-42"`) {
		t.Fatalf("bookmarks: code=%d body=%q", w.Code, w.Body.String())
	}
}

func TestBookmarkFallsBackToInjectedMarketForDanbooru(t *testing.T) {
	db, err := initDatabase(":memory:")
	if err != nil {
		t.Fatal(err)
	}
	_, _ = db.Exec("DELETE FROM posts")
	var requested string
	upstream := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		requested = r.URL.Path + "?" + r.URL.RawQuery
		_, _ = w.Write([]byte(`[{"id":42,"rating":"g","image_width":100,"image_height":100,"file_url":"https://x/42.jpg","created_at":"2026-01-01T00:00:00Z","tag_string":"solo"}]`))
	}))
	defer upstream.Close()
	s := &server{db: db, media: newMediaCache(db, t.TempDir()), marketURL: upstream.URL}
	h := withMiddleware(s.routes())
	w := do(h, http.MethodPost, "/api/posts/danbooru-42/bookmark?profileId=default", `{"bookmarked":true}`)
	if w.Code != http.StatusOK {
		t.Fatalf("bookmark: code=%d body=%q", w.Code, w.Body.String())
	}
	if !strings.Contains(requested, "/danbooru/posts.json") || !strings.Contains(requested, "id%3A42") {
		t.Fatalf("market route not used: %q", requested)
	}
}

func TestBookmarkRejectsMismatchedOnlineID(t *testing.T) {
	db, err := initDatabase(":memory:")
	if err != nil {
		t.Fatal(err)
	}
	_, _ = db.Exec("DELETE FROM posts")
	upstream := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		_, _ = w.Write([]byte(`[{"id":999,"rating":"g","image_width":100,"image_height":100,"file_url":"https://x/999.jpg","created_at":"2026-01-01T00:00:00Z","tag_string":"solo"}]`))
	}))
	defer upstream.Close()
	s := &server{db: db, media: newMediaCache(db, t.TempDir()), marketURL: upstream.URL}
	h := withMiddleware(s.routes())
	w := do(h, http.MethodPost, "/api/posts/danbooru-42/bookmark?profileId=default", `{"bookmarked":true}`)
	if w.Code != http.StatusNotFound {
		t.Fatalf("mismatched id: code=%d body=%q", w.Code, w.Body.String())
	}
	if exists(db, "SELECT 1 FROM profile_bookmarks WHERE profile_id=? AND post_id=?", defaultProfileID, "danbooru-999") {
		t.Fatal("mismatched post was written")
	}
}
func TestBookmarkRejectedByRatingDoesNotWrite(t *testing.T) {
	db, err := initDatabase(":memory:")
	if err != nil {
		t.Fatal(err)
	}
	post := M{"id": "hidden", "title": "hidden", "artist": "a", "imageUrl": "https://x/h.jpg", "previewUrl": "https://x/h.jpg", "rating": "explicit", "createdAt": "2026-01-01T00:00:00Z", "tags": []M{}}
	if _, err := syncDanbooruToDB(db, []M{post}); err != nil {
		t.Fatal(err)
	}
	p, err := setBookmark(db, defaultProfileID, "hidden", true)
	if err != nil {
		t.Fatal(err)
	}
	if p != nil || exists(db, "SELECT 1 FROM profile_bookmarks WHERE profile_id=? AND post_id=?", defaultProfileID, "hidden") {
		t.Fatal("disallowed bookmark was written")
	}
}

func TestProviderModelAddRemoveAndMainModel(t *testing.T) {
	db, err := initDatabase(":memory:")
	if err != nil {
		t.Fatal(err)
	}
	h := withMiddleware((&server{db: db, media: newMediaCache(db, t.TempDir())}).routes())
	if _, err := db.Exec(`INSERT INTO ai_providers(id,name,baseUrl,apiKey) VALUES('p','P','http://x','');
		INSERT INTO ai_models(providerId,id,name) VALUES('p','m1','m1'),('p','m2','m2')`); err != nil {
		t.Fatal(err)
	}
	manual := func(id string) int {
		v := -1
		_ = db.QueryRow("SELECT manual FROM ai_models WHERE providerId='p' AND id=?", id).Scan(&v)
		return v
	}
	if w := do(h, "PUT", "/api/ai/providers/p/models", `{"id":"m1"}`); w.Code != 200 || manual("m1") != 1 {
		t.Fatal(w.Body.String(), manual("m1"))
	}
	if w := do(h, "PUT", "/api/profiles/default/chat", `{"providerId":"p","modelId":"m1"}`); w.Code != 200 {
		t.Fatal(w.Body.String())
	}
	if w := do(h, "PUT", "/api/profiles/default/chat", `{"providerId":"","modelId":""}`); w.Code != 200 || strings.Contains(w.Body.String(), `"modelId":"m1"`) {
		t.Fatal("清除主模型失败", w.Body.String())
	}
	do(h, "PUT", "/api/profiles/default/chat", `{"providerId":"p","modelId":"m1"}`)
	if w := do(h, "DELETE", "/api/ai/providers/p/models/m1", ""); w.Code != 200 || manual("m1") != 0 {
		t.Fatal(w.Body.String(), manual("m1"))
	}
	if w := do(h, "GET", "/api/profiles/default/chat", ""); strings.Contains(w.Body.String(), `"modelId":"m1"`) {
		t.Fatal("主模型未清空", w.Body.String())
	}
	// 不在拉取列表中的手动模型移除后彻底删除
	do(h, "PUT", "/api/ai/providers/p/models", `{"id":"custom"}`)
	do(h, "DELETE", "/api/ai/providers/p/models/custom", "")
	if manual("custom") != -1 {
		t.Fatal("手动模型未删除")
	}
}

func TestVerifyModelReturnsReplyAndLatency(t *testing.T) {
	fake := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.URL.Path != "/v1/chat/completions" || r.Header.Get("Authorization") != "Bearer sk" {
			w.WriteHeader(401)
			return
		}
		w.Header().Set("Content-Type", "text/event-stream")
		_, _ = io.WriteString(w, "data: {\"choices\":[{\"delta\":{\"content\":\"ok\"}}]}\n\ndata: {\"choices\":[{\"delta\":{},\"finish_reason\":\"stop\"}]}\n\ndata: [DONE]\n\n")
	}))
	defer fake.Close()
	db, err := initDatabase(":memory:")
	if err != nil {
		t.Fatal(err)
	}
	h := withMiddleware((&server{db: db, media: newMediaCache(db, t.TempDir())}).routes())
	if _, err := db.Exec(`INSERT INTO ai_providers(id,name,baseUrl,apiKey) VALUES('p','P',?,'sk'); INSERT INTO ai_models(providerId,id,name,manual) VALUES('p','m','m',1)`, fake.URL+"/v1"); err != nil {
		t.Fatal(err)
	}
	w := do(h, "POST", "/api/ai/providers/p/models/verify", `{"id":"m","capability":"chat"}`)
	if w.Code != 200 || !strings.Contains(w.Body.String(), `"reply":"ok"`) || !strings.Contains(w.Body.String(), `"latencyMs":`) || !strings.Contains(w.Body.String(), `"value":"supported"`) {
		t.Fatal(w.Code, w.Body.String())
	}
	_, _ = db.Exec("UPDATE ai_providers SET apiKey='bad'")
	if w := do(h, "POST", "/api/ai/providers/p/models/verify", `{"id":"m","capability":"chat"}`); w.Code != 502 || !strings.Contains(w.Body.String(), "鉴权失败") {
		t.Fatal(w.Code, w.Body.String())
	}
}

// 假供应商：用户要“找猫”且尚无工具结果时返回 search_posts 工具调用，否则流式回复文本。
func fakeAgentProvider(t *testing.T, bodies *[]string, mu *sync.Mutex) *httptest.Server {
	return httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		b, _ := io.ReadAll(r.Body)
		mu.Lock()
		*bodies = append(*bodies, string(b))
		mu.Unlock()
		w.Header().Set("Content-Type", "text/event-stream")
		frames := []string{`{"choices":[{"delta":{"content":"完成"}}]}`, `{"choices":[{"delta":{},"finish_reason":"stop"}]}`}
		if strings.Contains(string(b), "找猫") && !strings.Contains(string(b), `"role":"tool"`) {
			frames = []string{`{"choices":[{"delta":{"tool_calls":[{"index":0,"id":"c1","function":{"name":"search_posts","arguments":"{\"tags\":\"cat\"}"}}]}}]}`,
				`{"choices":[{"delta":{},"finish_reason":"tool_calls"}]}`}
		}
		for _, f := range append(frames, "[DONE]") {
			_, _ = io.WriteString(w, "data: "+f+"\n\n")
		}
	}))
}

func waitRun(t *testing.T, h http.Handler, cid string) M {
	t.Helper()
	for i := 0; i < 100; i++ {
		var snap M
		_ = json.Unmarshal(do(h, "GET", "/api/profiles/default/conversations/"+cid, "").Body.Bytes(), &snap)
		runs, _ := snap["runs"].([]any)
		if len(runs) > 0 {
			if st := str(runs[len(runs)-1].(map[string]any)["status"]); st != "pending" && st != "running" {
				return snap
			}
		}
		time.Sleep(20 * time.Millisecond)
	}
	t.Fatal("任务未结束")
	return nil
}

func TestConversationAgentFlowIsolationAndDelete(t *testing.T) {
	var bodies []string
	var mu sync.Mutex
	fake := fakeAgentProvider(t, &bodies, &mu)
	defer fake.Close()
	db, err := initDatabase(":memory:")
	if err != nil {
		t.Fatal(err)
	}
	h := withMiddleware((&server{db: db, media: newMediaCache(db, t.TempDir())}).routes())
	if _, err := setProfileSettings(db, defaultProfileID, M{"dataSource": "sqlite"}); err != nil {
		t.Fatal(err)
	}
	if _, err := db.Exec(`INSERT INTO ai_providers(id,name,baseUrl,apiKey) VALUES('p','P',?,''); INSERT INTO ai_models(providerId,id,name,manual) VALUES('p','m','m',1)`, fake.URL+"/v1"); err != nil {
		t.Fatal(err)
	}
	do(h, "PUT", "/api/profiles/default/chat", `{"providerId":"p","modelId":"m"}`)
	newConv := func() string {
		var out struct{ Conversation M }
		w := do(h, "POST", "/api/profiles/default/conversations", "")
		_ = json.Unmarshal(w.Body.Bytes(), &out)
		if w.Code != 201 {
			t.Fatal(w.Body.String())
		}
		return str(out.Conversation["id"])
	}
	a, b := newConv(), newConv()
	if w := do(h, "POST", "/api/profiles/default/conversations/"+a+"/runs", `{"text":"帮我找猫的图片","requestId":"r1"}`); w.Code != 201 {
		t.Fatal(w.Body.String())
	}
	snap := waitRun(t, h, a)
	if calls, _ := snap["calls"].([]any); len(calls) != 1 || str(calls[0].(map[string]any)["name"]) != "search_posts" {
		t.Fatal("工具未调用", snap["calls"])
	}
	if s := str(snap["conversation"].(map[string]any)["title"]); s != "帮我找猫的图片" {
		t.Fatal("标题", s)
	}
	if !strings.Contains(fmt.Sprint(snap["messages"]), "完成") {
		t.Fatal("缺少最终回复", snap["messages"])
	}
	// B 的上下文不应包含 A 的消息
	do(h, "POST", "/api/profiles/default/conversations/"+b+"/runs", `{"text":"你好","requestId":"r2"}`)
	waitRun(t, h, b)
	mu.Lock()
	last := bodies[len(bodies)-1]
	mu.Unlock()
	if strings.Contains(last, "找猫") || !strings.Contains(last, "你好") {
		t.Fatal("会话串话", last)
	}
	// 其他会话的 run 不能通过本会话路径访问
	var runA string
	_ = db.QueryRow("SELECT id FROM ai_runs WHERE conversationId=?", a).Scan(&runA)
	if w := do(h, "POST", "/api/profiles/default/conversations/"+b+"/runs/"+runA+"/retry", ""); w.Code != 404 {
		t.Fatal(w.Code)
	}
	if w := do(h, "GET", "/api/profiles/default/conversations", ""); !strings.Contains(w.Body.String(), `"status":"completed"`) {
		t.Fatal(w.Body.String())
	}
	if w := do(h, "PATCH", "/api/profiles/default/conversations/"+a, `{"title":"  猫猫  "}`); !strings.Contains(w.Body.String(), `"title":"猫猫"`) {
		t.Fatal(w.Body.String())
	}
	if w := do(h, "DELETE", "/api/profiles/default/conversations/"+a, ""); w.Code != 200 {
		t.Fatal(w.Body.String())
	}
	var n int
	_ = db.QueryRow("SELECT COUNT(*) FROM ai_messages WHERE runId=?", runA).Scan(&n)
	if n != 0 || do(h, "GET", "/api/profiles/default/conversations/"+a, "").Code != 404 {
		t.Fatal("会话未删除干净", n)
	}
}

func TestMigrateLegacyRunsIntoConversation(t *testing.T) {
	db, err := initDatabase(":memory:")
	if err != nil {
		t.Fatal(err)
	}
	if _, err := db.Exec(`INSERT INTO ai_runs(id,profileId,requestId,status,providerId,modelId,providerName,modelName) VALUES('r','default','q','completed','p','m','P','M')`); err != nil {
		t.Fatal(err)
	}
	if err := migrateConversations(db); err != nil {
		t.Fatal(err)
	}
	var title string
	if err := db.QueryRow("SELECT c.title FROM ai_conversations c JOIN ai_runs r ON r.conversationId=c.id WHERE r.id='r'").Scan(&title); err != nil || title != "此前的对话" {
		t.Fatal(title, err)
	}
}

func TestRunQuotesPosts(t *testing.T) {
	var bodies []string
	var mu sync.Mutex
	fake := fakeAgentProvider(t, &bodies, &mu)
	defer fake.Close()
	db, err := initDatabase(":memory:")
	if err != nil {
		t.Fatal(err)
	}
	h := withMiddleware((&server{db: db, media: newMediaCache(db, t.TempDir())}).routes())
	if _, err := setProfileSettings(db, defaultProfileID, M{"dataSource": "sqlite"}); err != nil {
		t.Fatal(err)
	}
	if _, err := db.Exec(`INSERT INTO ai_providers(id,name,baseUrl,apiKey) VALUES('p','P',?,''); INSERT INTO ai_models(providerId,id,name,manual) VALUES('p','m','m',1);
      INSERT INTO posts(id,title,artist,image_url,preview_url,rating,created_at) VALUES('q1','t','a','http://x/i.jpg','http://x/p.jpg','general','2026-01-01')`, fake.URL+"/v1"); err != nil {
		t.Fatal(err)
	}
	do(h, "PUT", "/api/profiles/default/chat", `{"providerId":"p","modelId":"m"}`)
	var out struct{ Conversation M }
	_ = json.Unmarshal(do(h, "POST", "/api/profiles/default/conversations", "").Body.Bytes(), &out)
	cid := str(out.Conversation["id"])
	runs := "/api/profiles/default/conversations/" + cid + "/runs"
	if w := do(h, "POST", runs, `{"text":"","postIds":["missing"],"requestId":"r0"}`); w.Code != 409 {
		t.Fatal("不存在的作品应被拒绝", w.Code)
	}
	if w := do(h, "POST", runs, `{"text":"","postIds":["q1"],"requestId":"r1"}`); w.Code != 201 {
		t.Fatal(w.Body.String())
	}
	snap := waitRun(t, h, cid)
	mu.Lock()
	last := bodies[len(bodies)-1]
	mu.Unlock()
	if !strings.Contains(last, "引用作品：q1") {
		t.Fatal("模型未收到引用", last)
	}
	if !strings.Contains(fmt.Sprint(snap["messages"]), "http://x/p.jpg") {
		t.Fatal("消息缺少引用缩略图", snap["messages"])
	}
}
