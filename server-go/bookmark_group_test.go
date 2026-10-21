package main

import (
	"encoding/json"
	"net/http"
	"testing"
)

func TestBookmarkFamilyRemovalIsScopedAndKeepsOtherGroups(t *testing.T) {
	db, err := initDatabase(":memory:")
	if err != nil {
		t.Fatal(err)
	}
	defer db.Close()
	other, err := createProfile(db, "另一个用户")
	if err != nil {
		t.Fatal(err)
	}
	otherID := str(other["id"])
	items := []M{}
	for _, id := range []string{"group-parent", "group-child", "group-sibling", "unrelated"} {
		post := M{"id": id, "title": id, "imageUrl": "https://x/original.png", "rating": "general", "tags": []M{}}
		if id == "group-child" || id == "group-sibling" {
			post["parentId"] = "group-parent"
		}
		items = append(items, post)
	}
	if _, err := syncDanbooruToDB(db, items); err != nil {
		t.Fatal(err)
	}
	for _, profile := range []string{defaultProfileID, otherID} {
		for _, item := range items {
			if _, err := setBookmark(db, profile, str(item["id"]), true); err != nil {
				t.Fatal(err)
			}
		}
	}
	h := (&server{db: db}).routes()
	w := do(h, http.MethodPost, "/api/posts/group-child/bookmark?profileId=default", `{"bookmarked":false,"family":true}`)
	if w.Code != http.StatusOK {
		t.Fatalf("status=%d body=%s", w.Code, w.Body.String())
	}
	var response struct {
		Post M
	}
	if err := json.Unmarshal(w.Body.Bytes(), &response); err != nil || response.Post["isBookmarked"] != false {
		t.Fatalf("unexpected response: %s", w.Body.String())
	}
	for _, id := range []string{"group-parent", "group-child", "group-sibling"} {
		if exists(db, "SELECT 1 FROM profile_bookmarks WHERE profile_id=? AND post_id=?", defaultProfileID, id) {
			t.Fatalf("family member %s remained bookmarked", id)
		}
	}
	if !exists(db, "SELECT 1 FROM profile_bookmarks WHERE profile_id=? AND post_id=?", defaultProfileID, "unrelated") {
		t.Fatal("unrelated group was removed")
	}
	for _, item := range items {
		if !exists(db, "SELECT 1 FROM profile_bookmarks WHERE profile_id=? AND post_id=?", otherID, str(item["id"])) {
			t.Fatal("another profile was changed")
		}
	}
	// 不带 family 的旧接口仍然只取消单个帖子。
	for _, id := range []string{"group-parent", "group-child"} {
		if _, err := setBookmark(db, defaultProfileID, id, true); err != nil {
			t.Fatal(err)
		}
	}
	w = do(h, http.MethodPost, "/api/posts/group-child/bookmark?profileId=default", `{"bookmarked":false}`)
	if w.Code != 200 || !exists(db, "SELECT 1 FROM profile_bookmarks WHERE profile_id=? AND post_id=?", defaultProfileID, "group-parent") {
		t.Fatal("single-post bookmark semantics changed")
	}
}

func TestBookmarkFamilyRemovalRejectsHiddenAndUnknownPosts(t *testing.T) {
	db, err := initDatabase(":memory:")
	if err != nil {
		t.Fatal(err)
	}
	defer db.Close()
	if _, err := syncDanbooruToDB(db, []M{{"id": "hidden-group", "imageUrl": "https://x/original.png", "rating": "explicit", "tags": []M{}}}); err != nil {
		t.Fatal(err)
	}
	h := (&server{db: db}).routes()
	for _, path := range []string{"/api/posts/hidden-group/bookmark?profileId=default", "/api/posts/missing/bookmark?profileId=default", "/api/posts/hidden-group/bookmark?profileId=missing"} {
		w := do(h, http.MethodPost, path, `{"bookmarked":false,"family":true}`)
		if w.Code != http.StatusNotFound {
			t.Fatalf("POST %s: status=%d", path, w.Code)
		}
	}
}
