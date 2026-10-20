package main

import (
	"database/sql"
	"encoding/json"
	"errors"
	"net/http"
	"os"
	"path/filepath"
	"strconv"
	"strings"
)

type server struct {
	db        *sql.DB
	media     *MediaCache
	marketURL string
}

func jsonUnmarshal(b []byte, v any) error { return json.Unmarshal(b, v) }

func (s *server) fail500(w http.ResponseWriter, tag, msg string, err error) {
	appendServerLog("ERROR", tag, msg, err.Error())
	errJSON(w, 500, "Internal Server Error")
}

// ---------- profile 解析 ----------

func (s *server) requireProfile(w http.ResponseWriter, id string) (string, bool) {
	id = strings.TrimSpace(id)
	if id == "" {
		errJSON(w, 400, "Invalid profileId")
		return "", false
	}
	if p, _ := getProfileByID(s.db, id); p == nil {
		errJSON(w, 404, "Profile not found")
		return "", false
	}
	return id, true
}

// 查询参数（可选头）读取 profileId；出现但为空 -> 400，未知 -> 404
func (s *server) optionalProfile(w http.ResponseWriter, r *http.Request, useHeader bool) (string, bool) {
	raw, present := "", false
	if vs, ok := r.URL.Query()["profileId"]; ok {
		present = true
		if len(vs) > 0 {
			raw = vs[0]
		}
	} else if useHeader {
		if vs, ok := r.Header["X-Profile-Id"]; ok {
			present = true
			if len(vs) > 0 {
				raw = vs[0]
			}
		}
	}
	if !present {
		return "", true
	}
	return s.requireProfile(w, raw)
}

func (s *server) aggregate(id string) M {
	p, _ := getProfileByID(s.db, id)
	return M{"profile": p, "settings": getProfileSettings(s.db, id), "history": getSearchHistory(s.db, id), "bookmarks": getBookmarkedPosts(s.db, id)}
}

func merge(base M, extra M) M {
	for k, v := range extra {
		base[k] = v
	}
	return base
}

func (s *server) apiRoutes() http.Handler {
	mux := http.NewServeMux()

	mux.HandleFunc("GET /api/health", func(w http.ResponseWriter, r *http.Request) {
		writeJSON(w, 200, M{"status": "ok", "app": "TikBooru Backend", "version": "0.1.0", "runtime": "go", "db": "sqlite", "timestamp": nowISO()})
	})

	logPost := func(w http.ResponseWriter, r *http.Request) {
		b := readBody(r)
		level, tag := orDefault(str(b["level"]), "INFO"), orDefault(str(b["tag"]), "CLIENT")
		if b["meta"] != nil {
			appendServerLog(level, tag, str(b["message"]), b["meta"])
		} else {
			appendServerLog(level, tag, str(b["message"]))
		}
		writeJSON(w, 200, M{"ok": true, "file": filepath.Base(logPath())})
	}
	mux.HandleFunc("POST /api/log", logPost)
	mux.HandleFunc("POST /api/logs", logPost)
	mux.HandleFunc("GET /api/logs/latest", func(w http.ResponseWriter, r *http.Request) {
		b, err := os.ReadFile(logPath())
		if err != nil {
			http.Error(w, "Log file not found", 404)
			return
		}
		w.Header().Set("Content-Type", "text/plain; charset=utf-8")
		_, _ = w.Write(b)
	})

	mux.HandleFunc("GET /api/tags", func(w http.ResponseWriter, r *http.Request) {
		tags := getAllTags(s.db)
		writeJSON(w, 200, M{"success": true, "count": len(tags), "tags": tags})
	})

	s.postRoutes(mux)
	s.profileRoutes(mux)
	s.settingsRoutes(mux)
	s.danbooruRoutes(mux)
	mux.HandleFunc("GET /api/media/cache/{postId}", s.mediaCacheHandler)
	mux.HandleFunc("GET /api/media", s.mediaProxyHandler)
	mux.HandleFunc("GET /api/media/", s.mediaProxyHandler)
	s.webdavRoutes(mux)
	s.aiRoutes(mux)
	return mux
}

func (s *server) routes() http.Handler {
	return s.webHandler(s.apiRoutes())
}

// ---------- posts ----------

func (s *server) postRoutes(mux *http.ServeMux) {
	mux.HandleFunc("GET /api/posts", func(w http.ResponseWriter, r *http.Request) {
		pid, ok := s.optionalProfile(w, r, true)
		if !ok {
			return
		}
		q := r.URL.Query()
		limit, _ := strconv.Atoi(q.Get("limit"))
		offset, _ := strconv.Atoi(q.Get("offset"))
		f := postFilter{Tag: q.Get("tag"), Category: q.Get("category"), Limit: limit, Offset: offset, ProfileID: pid}
		if c := q.Get("cursor"); c != "" {
			var ok bool
			if f.CursorCreatedAt, f.CursorID, ok = decodeCursor(c); !ok {
				errJSON(w, 400, "cursor 无效")
				return
			}
			f.Offset = 0
		}
		if limit > 0 {
			f.Limit = limit + 1 // 多取一条判断是否还有下一页
		}
		posts, err := getPosts(s.db, f)
		if err != nil {
			s.fail500(w, "API_POSTS", "Failed to list posts", err)
			return
		}
		nextCursor := ""
		if limit > 0 && len(posts) > limit {
			posts = posts[:limit]
			nextCursor = encodeCursor(str(posts[limit-1]["createdAt"]), str(posts[limit-1]["id"]))
		}
		writeJSON(w, 200, M{"success": true, "count": len(posts), "posts": posts, "nextCursor": nextCursor})
	})

	snapshotsOf := func(b M) ([]any, bool) {
		for _, k := range []string{"snapshots", "bookmarks", "posts"} {
			if a, ok := b[k].([]any); ok {
				return a, true
			}
		}
		return nil, false
	}
	migrate := func(w http.ResponseWriter, r *http.Request) {
		pid, ok := s.optionalProfile(w, r, true)
		if !ok {
			return
		}
		if pid == "" {
			errJSON(w, 400, "profileId is required")
			return
		}
		snaps, ok := snapshotsOf(readBody(r))
		if !ok {
			errJSON(w, 400, "snapshots must be an array")
			return
		}
		res := importBookmarkSnapshotBatch(s.db, pid, snaps)
		s.media.backfill()
		writeJSON(w, 200, M{"success": true, "profileId": pid, "imported": res["imported"]})
	}
	mux.HandleFunc("POST /api/posts/bookmarks/migrate", migrate)
	mux.HandleFunc("POST /api/posts/bookmarks/import", migrate)
	mux.HandleFunc("POST /api/posts/migrate", migrate)

	mux.HandleFunc("GET /api/posts/{id}/children", func(w http.ResponseWriter, r *http.Request) {
		pid, ok := s.optionalProfile(w, r, true)
		if !ok {
			return
		}
		posts, err := getPosts(s.db, postFilter{ParentID: r.PathValue("id"), ProfileID: pid})
		if err != nil {
			s.fail500(w, "API_POSTS", "Failed to list children", err)
			return
		}
		writeJSON(w, 200, M{"success": true, "count": len(posts), "posts": posts})
	})
	mux.HandleFunc("GET /api/posts/{id}", func(w http.ResponseWriter, r *http.Request) {
		pid, ok := s.optionalProfile(w, r, true)
		if !ok {
			return
		}
		p, err := getPostByID(s.db, r.PathValue("id"), pid)
		if err != nil {
			s.fail500(w, "API_POSTS", "Failed to get post", err)
			return
		}
		if p == nil {
			errJSON(w, 404, "Post not found")
			return
		}
		writeJSON(w, 200, M{"success": true, "post": p})
	})

	mux.HandleFunc("POST /api/posts/{id}/bookmark", func(w http.ResponseWriter, r *http.Request) {
		pid, ok := s.optionalProfile(w, r, true)
		if !ok {
			return
		}
		id := r.PathValue("id")
		b := readBody(r)
		var post M
		var err error
		if pid != "" {
			want := true
			if v, ok := b["bookmarked"].(bool); ok {
				want = v
			}
			if b["toggle"] == true || r.URL.Query().Get("toggle") == "true" {
				cur, _ := getPostByID(s.db, id, pid)
				if cur == nil {
					errJSON(w, 404, "Post not found")
					return
				}
				want = cur["isBookmarked"] != true
			}
			post, err = setBookmark(s.db, pid, id, want)
		} else {
			post, err = toggleBookmarkLegacy(s.db, id)
		}
		if err != nil {
			s.fail500(w, "API_BOOKMARK", "Failed to update bookmark", err)
			return
		}
		if post == nil {
			errJSON(w, 404, "Post not found")
			return
		}
		if post["isBookmarked"] == true {
			s.media.enqueue(id)
		}
		writeJSON(w, 200, M{"success": true, "post": post})
	})

	mux.HandleFunc("DELETE /api/posts/{id}/bookmark", func(w http.ResponseWriter, r *http.Request) {
		pid, ok := s.optionalProfile(w, r, true)
		if !ok {
			return
		}
		if pid == "" {
			errJSON(w, 400, "profileId is required")
			return
		}
		post, err := setBookmark(s.db, pid, r.PathValue("id"), false)
		if err != nil {
			s.fail500(w, "API_BOOKMARK", "Failed to remove bookmark", err)
			return
		}
		if post == nil {
			errJSON(w, 404, "Post not found")
			return
		}
		writeJSON(w, 200, M{"success": true, "post": post})
	})
}

// ---------- profiles ----------

func readSettingsBody(b M) M {
	if b == nil {
		return nil
	}
	if m, ok := b["settings"].(map[string]any); ok {
		return m
	}
	return b
}

func (s *server) writeSettings(w http.ResponseWriter, r *http.Request, pid string) {
	settings := readSettingsBody(readBody(r))
	if settings == nil {
		errJSON(w, 400, "settings must be an object")
		return
	}
	updated, err := setProfileSettings(s.db, pid, settings)
	if err != nil {
		if err.Error() == "SETTINGS_LIMIT_EXCEEDED" || err.Error() == "INVALID_SETTING" {
			errJSON(w, 400, err.Error())
			return
		}
		s.fail500(w, "API_PROFILE_SETTINGS", "Failed to update settings for "+pid, err)
		return
	}
	writeJSON(w, 200, M{"success": true, "profileId": pid, "settings": updated})
}

func (s *server) profileRoutes(mux *http.ServeMux) {
	prof := func(fn func(w http.ResponseWriter, r *http.Request, pid string)) http.HandlerFunc {
		return func(w http.ResponseWriter, r *http.Request) {
			pid, ok := s.requireProfile(w, r.PathValue("profileId"))
			if !ok {
				return
			}
			fn(w, r, pid)
		}
	}

	mux.HandleFunc("GET /api/profiles", func(w http.ResponseWriter, r *http.Request) {
		ps, err := getProfiles(s.db)
		if err != nil {
			s.fail500(w, "API_PROFILES", "Failed to list profiles", err)
			return
		}
		writeJSON(w, 200, M{"success": true, "profiles": ps})
	})
	mux.HandleFunc("POST /api/profiles", func(w http.ResponseWriter, r *http.Request) {
		name, ok := readBody(r)["name"].(string)
		if !ok {
			errJSON(w, 400, "Profile name is required")
			return
		}
		p, err := createProfile(s.db, name)
		if err != nil {
			if err.Error() == "PROFILE_NAME_REQUIRED" || err.Error() == "PROFILE_NAME_TOO_LONG" {
				errJSON(w, 400, "Profile name must be 1-40 Unicode characters")
				return
			}
			s.fail500(w, "API_PROFILE_CREATE", "Failed to create profile", err)
			return
		}
		writeJSON(w, 201, merge(M{"success": true}, s.aggregate(str(p["id"]))))
	})

	mux.HandleFunc("GET /api/profiles/{profileId}/settings", prof(func(w http.ResponseWriter, r *http.Request, pid string) {
		writeJSON(w, 200, M{"success": true, "profileId": pid, "settings": getProfileSettings(s.db, pid)})
	}))
	for _, m := range []string{"PUT", "PATCH", "POST"} {
		mux.HandleFunc(m+" /api/profiles/{profileId}/settings", prof(s.writeSettings))
	}
	mux.HandleFunc("DELETE /api/profiles/{profileId}/settings/{key}", prof(func(w http.ResponseWriter, r *http.Request, pid string) {
		key := strings.TrimSpace(r.PathValue("key"))
		if key == "" {
			errJSON(w, 400, "Invalid setting key")
			return
		}
		writeJSON(w, 200, M{"success": true, "deleted": deleteProfileSetting(s.db, pid, key), "settings": getProfileSettings(s.db, pid)})
	}))
	mux.HandleFunc("DELETE /api/profiles/{profileId}/settings", prof(func(w http.ResponseWriter, r *http.Request, pid string) {
		writeJSON(w, 200, M{"success": true, "deleted": clearProfileSettings(s.db, pid), "settings": M{}})
	}))

	mux.HandleFunc("GET /api/profiles/{profileId}/history", prof(func(w http.ResponseWriter, r *http.Request, pid string) {
		writeJSON(w, 200, M{"success": true, "profileId": pid, "history": getSearchHistory(s.db, pid)})
	}))
	mux.HandleFunc("POST /api/profiles/{profileId}/history", prof(func(w http.ResponseWriter, r *http.Request, pid string) {
		b := readBody(r)
		query := ""
		for _, k := range []string{"query", "term", "tag"} {
			if v, ok := b[k].(string); ok {
				query = v
				break
			}
		}
		h, err := addSearchHistory(s.db, pid, query)
		if err != nil {
			if err.Error() == "HISTORY_QUERY_REQUIRED" {
				errJSON(w, 400, "Search query is required")
				return
			}
			s.fail500(w, "API_SEARCH_HISTORY", "Failed to save history for "+pid, err)
			return
		}
		writeJSON(w, 201, M{"success": true, "profileId": pid, "history": h})
	}))
	mux.HandleFunc("PUT /api/profiles/{profileId}/history", prof(func(w http.ResponseWriter, r *http.Request, pid string) {
		raw, ok := readBody(r)["history"].([]any)
		if !ok {
			errJSON(w, 400, "history must be an array")
			return
		}
		h, err := replaceSearchHistory(s.db, pid, raw)
		if err != nil {
			s.fail500(w, "API_SEARCH_HISTORY", "Failed to replace history for "+pid, err)
			return
		}
		writeJSON(w, 200, M{"success": true, "profileId": pid, "history": h})
	}))
	mux.HandleFunc("DELETE /api/profiles/{profileId}/history/{entryId}", prof(func(w http.ResponseWriter, r *http.Request, pid string) {
		e := strings.TrimSpace(r.PathValue("entryId"))
		if e == "" {
			errJSON(w, 400, "Invalid history entry")
			return
		}
		writeJSON(w, 200, M{"success": true, "deleted": deleteSearchHistory(s.db, pid, e), "history": getSearchHistory(s.db, pid)})
	}))
	mux.HandleFunc("DELETE /api/profiles/{profileId}/history", prof(func(w http.ResponseWriter, r *http.Request, pid string) {
		writeJSON(w, 200, M{"success": true, "deleted": clearSearchHistory(s.db, pid), "history": []any{}})
	}))

	mux.HandleFunc("GET /api/profiles/{profileId}/bookmarks", prof(func(w http.ResponseWriter, r *http.Request, pid string) {
		bs := getBookmarkedPosts(s.db, pid)
		writeJSON(w, 200, M{"success": true, "profileId": pid, "count": len(bs), "bookmarks": bs})
	}))
	importBookmarks := prof(func(w http.ResponseWriter, r *http.Request, pid string) {
		b := readBody(r)
		var snaps []any
		found := false
		for _, k := range []string{"snapshots", "bookmarks", "posts"} {
			if a, ok := b[k].([]any); ok {
				snaps, found = a, true
				break
			}
		}
		if !found {
			errJSON(w, 400, "snapshots must be an array")
			return
		}
		res := importBookmarkSnapshotBatch(s.db, pid, snaps)
		s.media.backfill()
		writeJSON(w, 200, merge(M{"success": true, "profileId": pid, "bookmarks": getBookmarkedPosts(s.db, pid)}, res))
	})
	mux.HandleFunc("POST /api/profiles/{profileId}/bookmarks/import", importBookmarks)
	mux.HandleFunc("POST /api/profiles/{profileId}/bookmarks/migrate", importBookmarks)

	mux.HandleFunc("POST /api/profiles/{profileId}/migration/preview", prof(func(w http.ResponseWriter, r *http.Request, pid string) {
		b := readBody(r)
		if ids, ok := b["snapshotIds"].([]any); ok {
			seen := map[string]bool{}
			var valid []any
			for _, i := range ids {
				id := strings.TrimSpace(str(i))
				if id != "" && !seen[id] {
					seen[id] = true
					valid = append(valid, id)
				}
			}
			already := countImportedBookmarkIDs(s.db, pid, valid)
			writeJSON(w, 200, M{"success": true, "profileId": pid, "preview": M{"total": len(valid), "valid": len(valid), "duplicates": 0,
				"invalid": 0, "alreadyImported": already, "expectedNew": max(0, len(valid)-already), "batchSize": 25}})
			return
		}
		for _, k := range []string{"snapshots", "bookmarks", "posts"} {
			if a, ok := b[k].([]any); ok {
				writeJSON(w, 200, M{"success": true, "profileId": pid, "preview": previewBookmarkSnapshots(s.db, pid, a)})
				return
			}
		}
		errJSON(w, 400, "snapshots must be an array")
	}))

	mux.HandleFunc("GET /api/profiles/{profileId}", prof(func(w http.ResponseWriter, r *http.Request, pid string) {
		writeJSON(w, 200, merge(M{"success": true}, s.aggregate(pid)))
	}))
}

// ---------- /api/settings（profileId 来自查询参数）----------

func (s *server) settingsRoutes(mux *http.ServeMux) {
	withPID := func(fn func(w http.ResponseWriter, r *http.Request, pid string)) http.HandlerFunc {
		return func(w http.ResponseWriter, r *http.Request) {
			if _, present := r.URL.Query()["profileId"]; !present {
				errJSON(w, 400, "profileId is required")
				return
			}
			if pid, ok := s.requireProfile(w, r.URL.Query().Get("profileId")); ok {
				fn(w, r, pid)
			}
		}
	}
	mux.HandleFunc("GET /api/settings", withPID(func(w http.ResponseWriter, r *http.Request, pid string) {
		writeJSON(w, 200, M{"success": true, "profileId": pid, "settings": getProfileSettings(s.db, pid)})
	}))
	for _, m := range []string{"PUT", "PATCH", "POST"} {
		mux.HandleFunc(m+" /api/settings", withPID(s.writeSettings))
	}
	mux.HandleFunc("DELETE /api/settings/{key}", withPID(func(w http.ResponseWriter, r *http.Request, pid string) {
		key := strings.TrimSpace(r.PathValue("key"))
		writeJSON(w, 200, M{"success": true, "deleted": deleteProfileSetting(s.db, pid, key), "settings": getProfileSettings(s.db, pid)})
	}))
	mux.HandleFunc("DELETE /api/settings", withPID(func(w http.ResponseWriter, r *http.Request, pid string) {
		writeJSON(w, 200, M{"success": true, "deleted": clearProfileSettings(s.db, pid), "settings": M{}})
	}))
}

// ---------- danbooru ----------

func (s *server) applyBookmarkState(posts []M, pid string) []M {
	out := make([]M, 0, len(posts))
	for _, p := range posts {
		local, _ := getPostByID(s.db, str(p["id"]), pid)
		if local == nil {
			out = append(out, p)
			continue
		}
		n := M{}
		for k, v := range p {
			n[k] = v
		}
		n["isBookmarked"] = local["isBookmarked"] == true
		if u := str(local["imageUrl"]); u != "" {
			n["imageUrl"] = u
		}
		n["cacheStatus"], n["cacheSize"] = local["cacheStatus"], local["cacheSize"]
		out = append(out, n)
	}
	return out
}

func (s *server) danbooruRoutes(mux *http.ServeMux) {
	atoi := func(v string, d int) int {
		if n, err := strconv.Atoi(v); err == nil {
			return n
		}
		return d
	}
	mux.HandleFunc("GET /api/danbooru/posts", func(w http.ResponseWriter, r *http.Request) {
		pid, ok := s.optionalProfile(w, r, false)
		if !ok {
			return
		}
		q := r.URL.Query()
		settings := getProfileSettings(s.db, pid)
		rating := orDefault(str(settings["rating"]), "general")
		localOnly := str(settings["dataSource"]) == "sqlite"
		page := atoi(q.Get("page"), 1)
		limit := atoi(q.Get("limit"), 20)
		limit = min(max(limit, 1), 100)
		// cursor："d:<id>" 为 Danbooru 在线游标；其他值为本地库游标（base64url）
		cursor, beforeID, localCursor := q.Get("cursor"), "", ""
		if id, isOnline := strings.CutPrefix(cursor, "d:"); isOnline {
			if _, err := strconv.ParseUint(id, 10, 64); err != nil {
				errJSON(w, 400, "cursor 无效")
				return
			}
			beforeID = id
		} else if cursor != "" {
			if _, _, ok := decodeCursor(cursor); !ok {
				errJSON(w, 400, "cursor 无效")
				return
			}
			localCursor = cursor
		}
		var posts []M
		var err error
		source, fallback := "sqlite", ""
		if localCursor == "" && !localOnly {
			source = "danbooru"
			base := s.marketURL
			if base != "" {
				base += "/danbooru"
			}
			if base != "" && !strings.HasSuffix(base, "/posts.json") {
				base += "/posts.json"
			}
			posts, err = fetchDanbooruPosts(r.Context(), danbooruOptions{BaseURL: base, Tags: q.Get("tags"), Rating: rating, Page: page, Limit: limit, BeforeID: beforeID, ThrowOnFailure: true, OnSource: func(s string) { source = s }})
			if source != "danbooru" && err == nil {
				err = errors.New("Online Source 不可用，使用 Local Cache")
			}
			if err == nil {
				var filtered bool
				if posts, filtered = filterPostsByRating(posts, rating); filtered {
					fallback = "rating-filtered"
					err = errors.New("online source returned posts outside profile rating")
				}
				if err == nil && len(posts) > 0 {
					_, _ = syncDanbooruToDB(s.db, posts)
				}
			}
		}
		nextCursor := ""
		if localCursor == "" && err == nil && !localOnly && source == "danbooru" && len(posts) > 0 && len(posts) >= limit {
			nextCursor = "d:" + strings.TrimPrefix(str(posts[len(posts)-1]["id"]), "danbooru-")
		}
		if localCursor != "" || localOnly || err != nil {
			if err != nil {
				appendServerLog("WARN", "DANBOORU_ROUTE", "Live fetch failed, falling back to local SQLite cache", err.Error())
				if fallback == "" {
					fallback = "online-unavailable"
				}
			}
			source = "sqlite"
			f := postFilter{Tag: q.Get("tags"), Rating: rating, Limit: limit, Offset: max(0, (page-1)*limit), ProfileID: pid}
			if beforeID != "" {
				localCursor, _ = s.cursorFromDanbooruID(beforeID)
				if localCursor == "" { // 本地没有该作品，无法定位，视为到底
					writeJSON(w, 200, M{"success": true, "source": source, "fallback": fallback, "count": 0, "posts": []M{}, "nextCursor": ""})
					return
				}
			}
			if localCursor != "" {
				f.CursorCreatedAt, f.CursorID, _ = decodeCursor(localCursor)
				f.Offset, f.Limit = 0, limit+1
			}
			if localCursor == "" {
				f.Limit = limit + 1
			}
			posts, err = getPosts(s.db, f)
			if err != nil {
				appendServerLog("ERROR", "DANBOORU_ROUTE", "Failed to handle Danbooru posts request", err.Error())
				errJSON(w, 500, "Failed to fetch Danbooru posts")
				return
			}
			nextCursor = ""
			if len(posts) > limit {
				posts = posts[:limit]
				nextCursor = encodeCursor(str(posts[limit-1]["createdAt"]), str(posts[limit-1]["id"]))
			}
		}
		posts = s.applyBookmarkState(posts, pid)
		writeJSON(w, 200, M{"success": true, "source": source, "fallback": fallback, "count": len(posts), "posts": posts, "nextCursor": nextCursor})
	})
	mux.HandleFunc("GET /api/danbooru/trending", func(w http.ResponseWriter, r *http.Request) {
		pid, ok := s.optionalProfile(w, r, false)
		if !ok {
			return
		}
		q := r.URL.Query()
		settings := getProfileSettings(s.db, pid)
		posts, err := fetchDanbooruPosts(r.Context(), danbooruOptions{Tags: "order:rank", Rating: orDefault(str(settings["rating"]), "general"), Page: atoi(q.Get("page"), 1), Limit: atoi(q.Get("limit"), 20)})
		if err == nil && len(posts) > 0 {
			_, _ = syncDanbooruToDB(s.db, posts)
		}
		if err != nil {
			posts, err = getPosts(s.db, postFilter{Limit: 20, ProfileID: pid})
			if err != nil {
				errJSON(w, 500, "Failed to fetch trending posts")
				return
			}
		}
		posts = s.applyBookmarkState(posts, pid)
		writeJSON(w, 200, M{"success": true, "count": len(posts), "posts": posts})
	})
	mux.HandleFunc("POST /api/danbooru/sync", func(w http.ResponseWriter, r *http.Request) {
		b := readBody(r)
		count := 20
		if b["count"] != nil {
			count = int(num(b["count"]))
		}
		posts, err := fetchDanbooruPosts(r.Context(), danbooruOptions{Tags: "order:rank", Rating: orDefault(str(b["rating"]), "general"), Limit: min(count, 50)})
		if err == nil {
			var n int
			n, err = syncDanbooruToDB(s.db, posts)
			if err == nil {
				writeJSON(w, 200, M{"success": true, "synced": n, "postsCount": len(posts)})
				return
			}
		}
		appendServerLog("ERROR", "DANBOORU_SYNC", "Manual sync failed", err.Error())
		errJSON(w, 500, "Sync failed")
	})
}

func filterPostsByRating(posts []M, allowed string) ([]M, bool) {
	out := make([]M, 0, len(posts))
	for _, p := range posts {
		if postRatingAllowed(str(p["rating"]), orDefault(allowed, "general")) {
			out = append(out, p)
		}
	}
	return out, len(out) != len(posts)
}

func postRatingAllowed(postRating, allowed string) bool {
	if allowed == "all" {
		return true
	}
	return postRating == allowed
}

// cursorFromDanbooruID 把在线游标（Danbooru id）还原为本地库游标；本地没有该作品时返回 false。
func (s *server) cursorFromDanbooruID(id string) (string, bool) {
	var createdAt string
	if s.db.QueryRow("SELECT created_at FROM posts WHERE id=?", "danbooru-"+id).Scan(&createdAt) != nil {
		return "", false
	}
	return encodeCursor(createdAt, "danbooru-"+id), true
}
