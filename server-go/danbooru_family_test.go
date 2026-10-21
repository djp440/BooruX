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

func TestDanbooruOriginalMediaNeverUsesSample(t *testing.T) {
	for _, tc := range []struct {
		name string
		raw  M
		want string
	}{
		{"file before sample", M{"file_url": "https://x/original.png", "large_file_url": "https://x/sample.jpg"}, "https://x/original.png"},
		{"original variant", M{"file_url": "https://x/file.jpg", "media_asset": M{"variants": []any{M{"type": "original", "url": "https://x/original.png"}, M{"type": "sample", "url": "https://x/sample.jpg"}}}}, "https://x/original.png"},
		{"md5 original", M{"md5": "abcdef0123456789abcdef0123456789", "file_ext": "png", "large_file_url": "https://x/sample.jpg"}, "/api/media?url=https%3A%2F%2Fcdn.donmai.us%2Foriginal%2Fab%2Fcd%2Fabcdef0123456789abcdef0123456789.png"},
		{"preview is not original", M{"preview_file_url": "https://x/preview.jpg", "large_file_url": "https://x/sample.jpg"}, ""},
	} {
		t.Run(tc.name, func(t *testing.T) {
			got, _ := extractDanbooruURLs(tc.raw)
			if got != tc.want {
				t.Fatalf("got %q, want %q", got, tc.want)
			}
		})
	}
}

func TestDanbooruFamilyFetchesEveryPageAndFiltersMembers(t *testing.T) {
	post := func(id, parent int, rating string) M {
		return M{"id": id, "parent_id": parent, "rating": rating, "file_url": fmt.Sprintf("https://x/original/%d.png", id)}
	}
	var requested []string
	upstream := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		q := r.URL.Query()
		requested = append(requested, q.Get("tags")+"|"+q.Get("page"))
		if q.Get("limit") != "100" || !strings.Contains(q.Get("tags"), "rating:general") {
			t.Errorf("unexpected query: %s", r.URL.RawQuery)
		}
		switch {
		case strings.HasPrefix(q.Get("tags"), "id:"):
			writeJSON(w, 200, []M{post(1, 0, "g")})
		case q.Get("page") == "":
			items := []M{}
			for id := 201; id >= 102; id-- {
				items = append(items, post(id, 1, "g"))
			}
			writeJSON(w, 200, items)
		case q.Get("page") == "b102":
			deleted := post(98, 1, "g")
			deleted["is_deleted"] = true
			writeJSON(w, 200, []M{post(101, 1, "g"), post(201, 1, "g"), post(1, 0, "g"), post(100, 1, "e"), post(99, 2, "g"), deleted})
		default:
			t.Errorf("unexpected page: %s", q.Get("page"))
			writeJSON(w, 200, []M{})
		}
	}))
	defer upstream.Close()
	posts, err := fetchDanbooruFamily(context.Background(), upstream.URL, "1", "general")
	if err != nil || len(posts) != 102 || str(posts[0]["id"]) != "danbooru-1" || str(posts[len(posts)-1]["id"]) != "danbooru-101" {
		t.Fatalf("posts=%d, err=%v", len(posts), err)
	}
	if len(requested) != 3 {
		t.Fatalf("requests=%v", requested)
	}
}

func TestDanbooruFamilyDoesNotHideUpstreamFailure(t *testing.T) {
	upstream := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.WriteHeader(http.StatusServiceUnavailable)
	}))
	defer upstream.Close()
	if _, err := fetchDanbooruFamily(context.Background(), upstream.URL, "1", "general"); err == nil {
		t.Fatal("expected an upstream error, not an empty successful family")
	}
}

func TestDanbooruFamilyRouteValidatesAndFiltersLocalMembers(t *testing.T) {
	db, err := initDatabase(":memory:")
	if err != nil {
		t.Fatal(err)
	}
	defer db.Close()
	items := []M{
		{"id": "danbooru-1", "imageUrl": "https://x/original/1.png", "rating": "general", "tags": []M{}},
		{"id": "danbooru-2", "parentId": "danbooru-1", "imageUrl": "https://x/original/2.png", "rating": "general", "tags": []M{}},
		{"id": "danbooru-3", "parentId": "danbooru-1", "imageUrl": "https://x/original/3.png", "rating": "explicit", "tags": []M{}},
	}
	if _, err := syncDanbooruToDB(db, items); err != nil {
		t.Fatal(err)
	}
	if _, err := setProfileSettings(db, defaultProfileID, M{"dataSource": "sqlite", "rating": "general"}); err != nil {
		t.Fatal(err)
	}
	h := (&server{db: db}).routes()
	for _, tc := range []struct {
		path string
		code int
	}{
		{"/api/danbooru/posts/invalid/family?profileId=default", 400},
		{"/api/danbooru/posts/0/family?profileId=default", 400},
		{"/api/danbooru/posts/1/family?profileId=missing", 404},
		{"/api/danbooru/posts/danbooru-1/family?profileId=default", 200},
	} {
		w := do(h, http.MethodGet, tc.path, "")
		if w.Code != tc.code {
			t.Fatalf("GET %s: status=%d", tc.path, w.Code)
		}
		if tc.code == 200 {
			var body struct {
				Source string
				Posts  []M
			}
			if err := json.Unmarshal(w.Body.Bytes(), &body); err != nil {
				t.Fatal(err)
			}
			if body.Source != "sqlite" || len(body.Posts) != 2 || str(body.Posts[0]["id"]) != "danbooru-1" || str(body.Posts[1]["id"]) != "danbooru-2" {
				t.Fatalf("unexpected local family: %s", w.Body.String())
			}
		}
	}
}

func TestTimelinePreservesOriginalURLWithConvertedCache(t *testing.T) {
	db, err := initDatabase(":memory:")
	if err != nil {
		t.Fatal(err)
	}
	defer db.Close()
	original := "https://cdn.donmai.us/original/ab/cd/test.png"
	_, err = syncDanbooruToDB(db, []M{{"id": "danbooru-1", "imageUrl": original, "rating": "general", "tags": []M{}}})
	if err != nil {
		t.Fatal(err)
	}
	_, err = db.Exec("INSERT INTO media_cache(post_id,source_url,status,storage_format,updated_at) VALUES(?,?,'ready','webp',?)", "danbooru-1", original, nowISO())
	if err != nil {
		t.Fatal(err)
	}
	local, err := getPostByID(db, "danbooru-1", "")
	if err != nil {
		t.Fatal(err)
	}
	s := &server{db: db}
	for _, input := range []M{local, {"id": "danbooru-1", "imageUrl": original}} {
		post := s.applyBookmarkState([]M{input}, "")[0]
		if post["originalUrl"] != original || post["imageUrl"] != "/api/media/cache/danbooru-1" {
			t.Fatalf("original and cache URLs were conflated: %v", post)
		}
	}
}
