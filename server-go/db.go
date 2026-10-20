package main

import (
	"context"
	"database/sql"
	_ "embed"
	"encoding/json"
	"errors"
	"fmt"
	"os"
	"path/filepath"
	"regexp"
	"strconv"
	"strings"
	"time"
	"unicode/utf8"

	_ "modernc.org/sqlite"
)

//go:embed seed/sample_posts.json
var samplePostsJSON []byte

const (
	defaultProfileID   = "default"
	defaultProfileName = "默认配置"
	maxProfileName     = 40
	maxSettings        = 12
	maxSearchHistory   = 12
)

var defaultSettings = [][2]string{{"themeMode", "system"}, {"rating", "general"}, {"dataSource", "danbooru"}}

func iso(t time.Time) string { return t.UTC().Format("2006-01-02T15:04:05.000Z") }
func nowISO() string         { return iso(time.Now()) }

func initDatabase(path string) (*sql.DB, error) {
	if path == "" {
		cwd, _ := os.Getwd()
		path = filepath.Join(cwd, "data", "tikbooru.db")
	}
	var dsn string
	if path != ":memory:" {
		if err := os.MkdirAll(filepath.Dir(path), 0o755); err != nil {
			return nil, err
		}
		dsn = "file:" + filepath.ToSlash(path) + "?_pragma=journal_mode(WAL)&_pragma=foreign_keys(1)&_pragma=busy_timeout(5000)"
	} else {
		dsn = "file::memory:?_pragma=foreign_keys(1)"
	}
	db, err := sql.Open("sqlite", dsn)
	if err != nil {
		return nil, err
	}
	// 单连接保证串行且 :memory: 一致；事务内必须使用 tx，读完 rows 再发起下一次查询。
	db.SetMaxOpenConns(1)
	appendServerLog("INFO", "DATABASE", "Initialized SQLite database at "+path)
	if err := createTables(db); err != nil {
		return nil, err
	}
	if err := initAiTables(db); err != nil {
		return nil, err
	}
	if err := seedInitialData(db); err != nil {
		return nil, err
	}
	if err := initializeDefaultProfile(db); err != nil {
		return nil, err
	}
	return db, nil
}

func createTables(db *sql.DB) error {
	_, err := db.Exec(`
    CREATE TABLE IF NOT EXISTS posts (
      id TEXT PRIMARY KEY, title TEXT NOT NULL, artist TEXT NOT NULL, artist_avatar TEXT,
      image_url TEXT NOT NULL, preview_url TEXT NOT NULL, aspect_ratio REAL DEFAULT 0.5625,
      width INTEGER DEFAULT 1080, height INTEGER DEFAULT 1920, is_bookmarked INTEGER DEFAULT 0,
      rating TEXT DEFAULT 'general', score INTEGER DEFAULT 0, description TEXT,
      media_type TEXT DEFAULT 'image', created_at TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS tags (
      id TEXT PRIMARY KEY, name TEXT UNIQUE NOT NULL, category TEXT NOT NULL DEFAULT 'general', count INTEGER DEFAULT 0
    );
    CREATE TABLE IF NOT EXISTS post_tags (
      post_id TEXT NOT NULL, tag_id TEXT NOT NULL, PRIMARY KEY (post_id, tag_id),
      FOREIGN KEY (post_id) REFERENCES posts(id) ON DELETE CASCADE,
      FOREIGN KEY (tag_id) REFERENCES tags(id) ON DELETE CASCADE
    );
    CREATE TABLE IF NOT EXISTS profiles (
      id TEXT PRIMARY KEY, name TEXT NOT NULL, created_at TEXT NOT NULL, updated_at TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS profile_settings (
      profile_id TEXT NOT NULL, setting_key TEXT NOT NULL, setting_value TEXT NOT NULL, updated_at TEXT NOT NULL,
      PRIMARY KEY (profile_id, setting_key),
      FOREIGN KEY (profile_id) REFERENCES profiles(id) ON DELETE CASCADE
    );
    CREATE TABLE IF NOT EXISTS search_history (
      id INTEGER PRIMARY KEY AUTOINCREMENT, profile_id TEXT NOT NULL, query TEXT NOT NULL, created_at TEXT NOT NULL,
      UNIQUE (profile_id, query),
      FOREIGN KEY (profile_id) REFERENCES profiles(id) ON DELETE CASCADE
    );
    CREATE TABLE IF NOT EXISTS profile_bookmarks (
      profile_id TEXT NOT NULL, post_id TEXT NOT NULL, created_at TEXT NOT NULL,
      PRIMARY KEY (profile_id, post_id),
      FOREIGN KEY (profile_id) REFERENCES profiles(id) ON DELETE CASCADE,
      FOREIGN KEY (post_id) REFERENCES posts(id) ON DELETE CASCADE
    );
    CREATE TABLE IF NOT EXISTS app_metadata (
      key TEXT PRIMARY KEY, value TEXT NOT NULL, updated_at TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS media_cache (
      post_id TEXT PRIMARY KEY, source_url TEXT NOT NULL, local_path TEXT, status TEXT NOT NULL DEFAULT 'pending',
      content_type TEXT, size_bytes INTEGER, storage_format TEXT NOT NULL DEFAULT 'original',
      attempts INTEGER NOT NULL DEFAULT 0, error TEXT, updated_at TEXT NOT NULL,
      FOREIGN KEY (post_id) REFERENCES posts(id) ON DELETE CASCADE
    );
    CREATE INDEX IF NOT EXISTS idx_search_history_profile_created ON search_history(profile_id, created_at DESC, id DESC);
    CREATE INDEX IF NOT EXISTS idx_profile_bookmarks_profile_created ON profile_bookmarks(profile_id, created_at DESC);
  `)
	if err != nil {
		return err
	}
	// 兼容旧库：列已存在时忽略错误
	_, _ = db.Exec("ALTER TABLE posts ADD COLUMN media_type TEXT DEFAULT 'image'")
	_, _ = db.Exec("ALTER TABLE posts ADD COLUMN is_bookmarked INTEGER DEFAULT 0")
	_, _ = db.Exec("ALTER TABLE posts ADD COLUMN parent_id TEXT")
	_, _ = db.Exec("ALTER TABLE posts ADD COLUMN has_children INTEGER DEFAULT 0")
	_, _ = db.Exec("CREATE INDEX IF NOT EXISTS idx_posts_parent ON posts(parent_id)")
	return nil
}

func withTx(db *sql.DB, fn func(tx *sql.Tx) error) error {
	tx, err := db.Begin()
	if err != nil {
		return err
	}
	if err := fn(tx); err != nil {
		_ = tx.Rollback()
		return err
	}
	return tx.Commit()
}

func initializeDefaultProfile(db *sql.DB) error {
	now := nowISO()
	if _, err := db.Exec(`INSERT INTO profiles (id,name,created_at,updated_at) VALUES (?,?,?,?) ON CONFLICT(id) DO NOTHING`,
		defaultProfileID, defaultProfileName, now, now); err != nil {
		return err
	}
	for _, kv := range defaultSettings {
		v, _ := json.Marshal(kv[1])
		if _, err := db.Exec(`INSERT INTO profile_settings (profile_id,setting_key,setting_value,updated_at) VALUES (?,?,?,?)
      ON CONFLICT(profile_id,setting_key) DO NOTHING`, defaultProfileID, kv[0], string(v), now); err != nil {
			return err
		}
	}
	const key = "legacy_posts_bookmarks_migrated_to_default"
	if !exists(db, "SELECT 1 FROM app_metadata WHERE key=?", key) {
		err := withTx(db, func(tx *sql.Tx) error {
			if _, err := tx.Exec(`INSERT OR IGNORE INTO profile_bookmarks (profile_id,post_id,created_at)
        SELECT ?, id, ? FROM posts WHERE is_bookmarked = 1`, defaultProfileID, now); err != nil {
				return err
			}
			_, err := tx.Exec("INSERT INTO app_metadata (key,value,updated_at) VALUES (?,?,?)", key, "1", now)
			return err
		})
		if err != nil {
			return err
		}
		appendServerLog("INFO", "DATABASE_MIGRATION", "Migrated legacy posts bookmarks into the default profile once")
	} else {
		appendServerLog("INFO", "DATABASE", "Initialized default profile and reused completed legacy bookmark migration")
	}
	return nil
}

func seedInitialData(db *sql.DB) error {
	var n int
	_ = db.QueryRow("SELECT COUNT(*) FROM posts").Scan(&n)
	if n > 0 {
		return nil
	}
	appendServerLog("INFO", "DATABASE", "Seeding initial Booru dataset into SQLite")
	var posts []M
	if err := json.Unmarshal(samplePostsJSON, &posts); err != nil {
		return err
	}
	return withTx(db, func(tx *sql.Tx) error {
		for _, p := range posts {
			mt := orDefault(str(p["mediaType"]), "image")
			bm := 0
			if b, _ := p["isBookmarked"].(bool); b {
				bm = 1
			}
			if _, err := tx.Exec(`INSERT INTO posts (id,title,artist,artist_avatar,image_url,preview_url,aspect_ratio,width,height,is_bookmarked,rating,score,description,media_type,created_at)
        VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`, str(p["id"]), str(p["title"]), str(p["artist"]), str(p["artistAvatar"]),
				str(p["imageUrl"]), str(p["previewUrl"]), num(p["aspectRatio"]), int64(num(p["width"])), int64(num(p["height"])), bm,
				str(p["rating"]), int64(num(p["score"])), str(p["description"]), mt, str(p["createdAt"])); err != nil {
				return err
			}
			tags, _ := p["tags"].([]any)
			for _, t := range tags {
				tm, _ := t.(map[string]any)
				if _, err := tx.Exec(`INSERT INTO tags (id,name,category,count) VALUES (?,?,?,?) ON CONFLICT(name) DO NOTHING`,
					str(tm["id"]), str(tm["name"]), str(tm["category"]), int64(num(tm["count"]))); err != nil {
					return err
				}
				var tid string
				if tx.QueryRow("SELECT id FROM tags WHERE name=?", str(tm["name"])).Scan(&tid) == nil {
					if _, err := tx.Exec("INSERT OR IGNORE INTO post_tags (post_id,tag_id) VALUES (?,?)", str(p["id"]), tid); err != nil {
						return err
					}
				}
			}
		}
		return nil
	})
}

func orDefault(s, d string) string {
	if s == "" {
		return d
	}
	return s
}

// ---------- 作品 ----------

type postFilter struct {
	Tag, Category, ProfileID  string
	Rating                    string
	Limit, Offset             int
	CursorCreatedAt, CursorID string // 游标：返回排在 (createdAt,id) 之后的作品
	ParentID                  string
}

var wsRe = regexp.MustCompile(`\s+`)

func getPosts(q querier, f postFilter) ([]M, error) {
	query := "SELECT p.* FROM posts p"
	args := []any{}
	if f.Tag != "" {
		var conds []string
		for _, t := range wsRe.Split(strings.TrimSpace(f.Tag), -1) {
			t = strings.TrimSpace(strings.TrimPrefix(t, "~"))
			if t == "" || strings.HasPrefix(t, "order:") || strings.HasPrefix(t, "rating:") || strings.HasPrefix(t, "sort:") {
				continue
			}
			conds = append(conds, "EXISTS (SELECT 1 FROM post_tags pt JOIN tags t ON pt.tag_id=t.id WHERE pt.post_id=p.id AND t.name = ?)")
			args = append(args, t)
		}
		if len(conds) > 0 {
			query += " WHERE " + strings.Join(conds, " AND ")
		}
	}
	if f.Category != "" {
		kw := " WHERE "
		if strings.Contains(query, " WHERE ") {
			kw = " AND "
		}
		query += kw + "EXISTS (SELECT 1 FROM post_tags pt JOIN tags t ON pt.tag_id=t.id WHERE pt.post_id=p.id AND t.category = ?)"
		args = append(args, f.Category)
	}
	if f.ParentID != "" {
		kw := " WHERE "
		if strings.Contains(query, " WHERE ") {
			kw = " AND "
		}
		query += kw + "p.parent_id = ?"
		args = append(args, f.ParentID)
	}
	if f.CursorID != "" {
		kw := " WHERE "
		if strings.Contains(query, " WHERE ") {
			kw = " AND "
		}
		query += kw + "(p.created_at < ? OR (p.created_at = ? AND p.id < ?))"
		args = append(args, f.CursorCreatedAt, f.CursorCreatedAt, f.CursorID)
	}
	if f.Rating != "" && f.Rating != "all" {
		kw := " WHERE "
		if strings.Contains(query, " WHERE ") {
			kw = " AND "
		}
		query += kw + "p.rating = ?"
		args = append(args, f.Rating)
	}
	query += " ORDER BY p.created_at DESC, p.id DESC"
	if f.Limit > 0 {
		query += " LIMIT ?"
		args = append(args, f.Limit)
		if f.Offset > 0 {
			query += " OFFSET ?"
			args = append(args, f.Offset)
		}
	}
	rows, err := queryMaps(q, query, args...)
	if err != nil {
		return nil, err
	}
	return formatPosts(q, rows, f.ProfileID), nil
}

func allowedRating(q querier, profileID string) string {
	if profileID == "" {
		return ""
	}
	return orDefault(str(getProfileSettings(q, profileID)["rating"]), "general")
}

func getPostByID(q querier, id, profileID string) (M, error) {
	row, err := queryMap(q, "SELECT * FROM posts WHERE id = ?", id)
	if err != nil || row == nil {
		return nil, err
	}
	if rating := allowedRating(q, profileID); rating != "" && !postRatingAllowed(str(row["rating"]), rating) {
		return nil, nil
	}
	return formatPost(q, row, profileID), nil
}

func formatPosts(q querier, rows []M, profileID string) []M {
	out := make([]M, 0, len(rows))
	for _, r := range rows {
		out = append(out, formatPost(q, r, profileID))
	}
	return out
}

func formatPost(q querier, p M, profileID string) M {
	id := str(p["id"])
	tags, _ := queryMaps(q, `SELECT t.id,t.name,t.category,t.count FROM tags t JOIN post_tags pt ON t.id=pt.tag_id WHERE pt.post_id=?`, id)
	var bookmarked bool
	if profileID != "" {
		bookmarked = exists(q, "SELECT 1 FROM profile_bookmarks WHERE profile_id=? AND post_id=?", profileID, id)
	} else {
		bookmarked = num(p["is_bookmarked"]) != 0
	}
	cache, _ := queryMap(q, "SELECT status,size_bytes,storage_format FROM media_cache WHERE post_id=?", id)
	imageURL := str(p["image_url"])
	post := M{
		"id": id, "title": p["title"], "artist": p["artist"], "artistAvatar": p["artist_avatar"],
		"previewUrl": p["preview_url"], "cacheSize": 0, "aspectRatio": p["aspect_ratio"], "width": p["width"], "height": p["height"],
		"isBookmarked": bookmarked, "rating": p["rating"], "score": p["score"], "description": p["description"],
		"createdAt": p["created_at"], "tags": tags,
		"parentId": p["parent_id"], "hasChildren": num(p["has_children"]) != 0, "mediaType": orDefault(str(p["media_type"]), "image"),
	}
	if cache != nil {
		post["cacheStatus"] = cache["status"]
		post["cacheFormat"] = cache["storage_format"]
		if cache["size_bytes"] != nil {
			post["cacheSize"] = cache["size_bytes"]
		}
		if str(cache["status"]) == "ready" {
			imageURL = "/api/media/cache/" + urlPathEscape(id)
		}
	}
	post["imageUrl"] = imageURL
	return post
}

func toggleBookmarkLegacy(q querier, postID string) (M, error) {
	post, err := getPostByID(q, postID, "")
	if err != nil || post == nil {
		return nil, err
	}
	next := 1
	if post["isBookmarked"] == true {
		next = 0
	}
	if _, err := q.Exec("UPDATE posts SET is_bookmarked=? WHERE id=?", next, postID); err != nil {
		return nil, err
	}
	appendServerLog("INFO", "DB_BOOKMARK", fmt.Sprintf("Updated bookmark status for post %s: %v", postID, next == 1))
	return getPostByID(q, postID, "")
}

// ---------- 配置 ----------

func getProfiles(q querier) ([]M, error) {
	return queryMaps(q, "SELECT id,name,created_at AS createdAt,updated_at AS updatedAt FROM profiles ORDER BY created_at ASC, id ASC")
}

func getProfileByID(q querier, id string) (M, error) {
	return queryMap(q, "SELECT id,name,created_at AS createdAt,updated_at AS updatedAt FROM profiles WHERE id=?", id)
}

func createProfile(q querier, name string) (M, error) {
	name = strings.TrimSpace(name)
	if name == "" {
		return nil, errors.New("PROFILE_NAME_REQUIRED")
	}
	if utf8.RuneCountInString(name) > maxProfileName {
		return nil, errors.New("PROFILE_NAME_TOO_LONG")
	}
	id := fmt.Sprintf("profile-%d-%s", time.Now().UnixMilli(), randBase36(8))
	now := nowISO()
	if _, err := q.Exec("INSERT INTO profiles (id,name,created_at,updated_at) VALUES (?,?,?,?)", id, name, now, now); err != nil {
		return nil, err
	}
	for _, kv := range defaultSettings {
		v, _ := json.Marshal(kv[1])
		if _, err := q.Exec("INSERT INTO profile_settings (profile_id,setting_key,setting_value,updated_at) VALUES (?,?,?,?)", id, kv[0], string(v), now); err != nil {
			return nil, err
		}
	}
	appendServerLog("INFO", "PROFILE_CREATE", "Created profile "+id)
	return getProfileByID(q, id)
}

func getProfileSettings(q querier, profileID string) M {
	rows, _ := queryMaps(q, "SELECT setting_key,setting_value FROM profile_settings WHERE profile_id=?", profileID)
	out := M{}
	for _, r := range rows {
		var v any
		if json.Unmarshal([]byte(str(r["setting_value"])), &v) != nil {
			v = r["setting_value"]
		}
		out[str(r["setting_key"])] = v
	}
	return out
}

func utf16Len(s string) int {
	n := 0
	for _, r := range s {
		if r >= 0x10000 {
			n += 2
		} else {
			n++
		}
	}
	return n
}

func setProfileSettings(db *sql.DB, profileID string, settings M) (M, error) {
	var current int
	_ = db.QueryRow("SELECT COUNT(*) FROM profile_settings WHERE profile_id=?", profileID).Scan(&current)
	newKeys := 0
	for k := range settings {
		if !exists(db, "SELECT 1 FROM profile_settings WHERE profile_id=? AND setting_key=?", profileID, k) {
			newKeys++
		}
	}
	if current+newKeys > maxSettings {
		return nil, errors.New("SETTINGS_LIMIT_EXCEEDED")
	}
	now := nowISO()
	err := withTx(db, func(tx *sql.Tx) error {
		for key, value := range settings {
			nk := strings.TrimSpace(key)
			if nk == "" || utf16Len(nk) > 80 || value == nil {
				return errors.New("INVALID_SETTING")
			}
			if nk == "aiSystemPrompt" {
				s, ok := value.(string)
				if !ok || utf16Len(s) > 8000 {
					return errors.New("INVALID_SETTING")
				}
				value = strings.TrimSpace(s)
			}
			b, _ := json.Marshal(value)
			if _, err := tx.Exec(`INSERT INTO profile_settings (profile_id,setting_key,setting_value,updated_at) VALUES (?,?,?,?)
        ON CONFLICT(profile_id,setting_key) DO UPDATE SET setting_value=excluded.setting_value,updated_at=excluded.updated_at`,
				profileID, nk, string(b), now); err != nil {
				return err
			}
		}
		return nil
	})
	if err != nil {
		return nil, err
	}
	appendServerLog("INFO", "PROFILE_SETTINGS", fmt.Sprintf("Updated %d settings for profile %s", len(settings), profileID))
	return getProfileSettings(db, profileID), nil
}

func deleteProfileSetting(q querier, profileID, key string) bool {
	r, err := q.Exec("DELETE FROM profile_settings WHERE profile_id=? AND setting_key=?", profileID, strings.TrimSpace(key))
	if err != nil {
		return false
	}
	n, _ := r.RowsAffected()
	return n > 0
}

func clearProfileSettings(q querier, profileID string) int64 {
	r, err := q.Exec("DELETE FROM profile_settings WHERE profile_id=?", profileID)
	if err != nil {
		return 0
	}
	n, _ := r.RowsAffected()
	return n
}

// ---------- 搜索历史 ----------

func getSearchHistory(q querier, profileID string) []M {
	rows, _ := queryMaps(q, `SELECT id,profile_id AS profileId,query,created_at AS createdAt FROM search_history
    WHERE profile_id=? ORDER BY created_at DESC, id DESC LIMIT ?`, profileID, maxSearchHistory)
	return rows
}

func addSearchHistory(db *sql.DB, profileID, query string) ([]M, error) {
	query = strings.TrimSpace(query)
	if query == "" {
		return nil, errors.New("HISTORY_QUERY_REQUIRED")
	}
	now := nowISO()
	err := withTx(db, func(tx *sql.Tx) error {
		if _, err := tx.Exec(`INSERT INTO search_history (profile_id,query,created_at) VALUES (?,?,?)
      ON CONFLICT(profile_id,query) DO UPDATE SET created_at=excluded.created_at`, profileID, query, now); err != nil {
			return err
		}
		_, err := tx.Exec(`DELETE FROM search_history WHERE profile_id=? AND id NOT IN
      (SELECT id FROM search_history WHERE profile_id=? ORDER BY created_at DESC, id DESC LIMIT ?)`, profileID, profileID, maxSearchHistory)
		return err
	})
	if err != nil {
		return nil, err
	}
	appendServerLog("INFO", "SEARCH_HISTORY", "Saved search history for profile "+profileID)
	return getSearchHistory(db, profileID), nil
}

func replaceSearchHistory(db *sql.DB, profileID string, queries []any) ([]M, error) {
	seen := map[string]bool{}
	var norm []string
	for _, q := range queries {
		s := strings.TrimSpace(str(q))
		if s != "" && !seen[s] {
			seen[s] = true
			norm = append(norm, s)
		}
	}
	if len(norm) > maxSearchHistory {
		norm = norm[:maxSearchHistory]
	}
	now := time.Now()
	err := withTx(db, func(tx *sql.Tx) error {
		if _, err := tx.Exec("DELETE FROM search_history WHERE profile_id=?", profileID); err != nil {
			return err
		}
		for i := range norm {
			q := norm[len(norm)-1-i]
			if _, err := tx.Exec("INSERT INTO search_history (profile_id,query,created_at) VALUES (?,?,?)", profileID, q, iso(now.Add(time.Duration(i)*time.Millisecond))); err != nil {
				return err
			}
		}
		return nil
	})
	if err != nil {
		return nil, err
	}
	appendServerLog("INFO", "SEARCH_HISTORY", "Replaced search history for profile "+profileID)
	return getSearchHistory(db, profileID), nil
}

var digitsRe = regexp.MustCompile(`^\d+$`)

func deleteSearchHistory(q querier, profileID, idOrQuery string) bool {
	var r sql.Result
	var err error
	if digitsRe.MatchString(idOrQuery) {
		n, _ := strconv.ParseInt(idOrQuery, 10, 64)
		r, err = q.Exec("DELETE FROM search_history WHERE profile_id=? AND id=?", profileID, n)
	} else {
		r, err = q.Exec("DELETE FROM search_history WHERE profile_id=? AND query=?", profileID, strings.TrimSpace(idOrQuery))
	}
	if err != nil {
		return false
	}
	n, _ := r.RowsAffected()
	return n > 0
}

func clearSearchHistory(q querier, profileID string) int64 {
	r, err := q.Exec("DELETE FROM search_history WHERE profile_id=?", profileID)
	if err != nil {
		return 0
	}
	n, _ := r.RowsAffected()
	return n
}

// ---------- 收藏 ----------

const bookmarkSelect = `SELECT p.* FROM posts p JOIN profile_bookmarks pb ON pb.post_id=p.id WHERE pb.profile_id=?
  ORDER BY pb.created_at DESC, p.created_at DESC, p.id DESC`

func getBookmarkedPosts(q querier, profileID string) []M {
	rows, _ := queryMaps(q, bookmarkSelect, profileID)
	return filterBookmarkedPosts(formatPosts(q, rows, profileID), getProfileSettings(q, profileID))
}

func filterBookmarkedPosts(posts []M, settings M) []M {
	out := make([]M, 0, len(posts))
	for _, post := range posts {
		if (settings["rating"] == "all" || str(post["rating"]) == orDefault(str(settings["rating"]), "general")) && isPostAllowed(post, settings["tagFilter"]) {
			out = append(out, post)
		}
	}
	return out
}

func getBookmarkSnapshots(q querier, profileID string) []M {
	rows, _ := queryMaps(q, bookmarkSelect, profileID)
	out := make([]M, 0, len(rows))
	for _, p := range rows {
		tags, _ := queryMaps(q, `SELECT t.name,t.category,t.count FROM tags t JOIN post_tags pt ON pt.tag_id=t.id WHERE pt.post_id=?`, p["id"])
		out = append(out, M{
			"id": p["id"], "title": p["title"], "artist": p["artist"], "artistAvatar": p["artist_avatar"],
			"imageUrl": p["image_url"], "previewUrl": p["preview_url"], "aspectRatio": p["aspect_ratio"],
			"width": p["width"], "height": p["height"], "rating": p["rating"], "score": p["score"],
			"description": p["description"], "mediaType": p["media_type"], "createdAt": p["created_at"], "tags": tags,
		})
	}
	return out
}

func setBookmark(q querier, profileID, postID string, bookmarked bool) (M, error) {
	prof, _ := getProfileByID(q, profileID)
	post, _ := getPostByID(q, postID, profileID)
	if prof == nil || post == nil {
		return nil, nil
	}
	var err error
	if bookmarked {
		_, err = q.Exec("INSERT OR IGNORE INTO profile_bookmarks (profile_id,post_id,created_at) VALUES (?,?,?)", profileID, postID, nowISO())
	} else {
		_, err = q.Exec("DELETE FROM profile_bookmarks WHERE profile_id=? AND post_id=?", profileID, postID)
	}
	if err != nil {
		return nil, err
	}
	appendServerLog("INFO", "PROFILE_BOOKMARK", fmt.Sprintf("Set bookmark %v for %s in %s", bookmarked, postID, profileID))
	return getPostByID(q, postID, profileID)
}

func normalizeSnapshot(raw any) M {
	c, ok := raw.(map[string]any)
	if !ok {
		return nil
	}
	id := strings.TrimSpace(str(c["id"]))
	imageURL := strings.TrimSpace(str(c["imageUrl"]))
	if id == "" || imageURL == "" {
		return nil
	}
	out := M{}
	for k, v := range c {
		out[k] = v
	}
	out["id"], out["imageUrl"] = id, imageURL
	out["previewUrl"] = orDefault(str(c["previewUrl"]), imageURL)
	tags := []any{}
	if arr, ok := c["tags"].([]any); ok {
		for _, t := range arr {
			if tm, ok := t.(map[string]any); ok && strings.TrimSpace(str(tm["name"])) != "" {
				tags = append(tags, tm)
			}
		}
	}
	out["tags"] = tags
	return out
}

func previewBookmarkSnapshots(q querier, profileID string, snaps []any) M {
	seen := map[string]bool{}
	valid, dup, invalid, already := 0, 0, 0, 0
	for _, raw := range snaps {
		s := normalizeSnapshot(raw)
		if s == nil {
			invalid++
			continue
		}
		id := str(s["id"])
		if seen[id] {
			dup++
			continue
		}
		seen[id] = true
		valid++
		if exists(q, "SELECT 1 FROM profile_bookmarks WHERE profile_id=? AND post_id=?", profileID, id) {
			already++
		}
	}
	expected := valid - already
	if expected < 0 {
		expected = 0
	}
	return M{"total": len(snaps), "valid": valid, "duplicates": dup, "invalid": invalid,
		"alreadyImported": already, "expectedNew": expected, "batchSize": 25}
}

func countImportedBookmarkIDs(q querier, profileID string, ids []any) int {
	seen := map[string]bool{}
	n := 0
	for _, i := range ids {
		id := strings.TrimSpace(str(i))
		if id == "" || seen[id] {
			continue
		}
		seen[id] = true
		if exists(q, "SELECT 1 FROM profile_bookmarks WHERE profile_id=? AND post_id=?", profileID, id) {
			n++
		}
	}
	return n
}

func importBookmarkSnapshotBatch(db *sql.DB, profileID string, snaps []any) M {
	if p, _ := getProfileByID(db, profileID); p == nil {
		return M{"imported": 0, "skipped": 0, "failed": len(snaps), "errors": []string{"Profile not found"}}
	}
	imported, skipped, failed := 0, 0, 0
	errs := []string{}
	seen := map[string]bool{}
	now := nowISO()
	err := withTx(db, func(tx *sql.Tx) error {
		for _, raw := range snaps {
			s := normalizeSnapshot(raw)
			if s == nil {
				failed++
				errs = append(errs, "作品快照缺少有效 id 或 imageUrl")
				continue
			}
			id := str(s["id"])
			if seen[id] || exists(tx, "SELECT 1 FROM profile_bookmarks WHERE profile_id=? AND post_id=?", profileID, id) {
				skipped++
				continue
			}
			seen[id] = true
			w, h := num(s["width"]), num(s["height"])
			if w == 0 {
				w = 1080
			}
			if h == 0 {
				h = 1920
			}
			ar := num(s["aspectRatio"])
			if ar == 0 {
				ar = w / h
			}
			if _, err := tx.Exec(`INSERT INTO posts (id,title,artist,artist_avatar,image_url,preview_url,aspect_ratio,width,height,is_bookmarked,rating,score,description,media_type,created_at)
        VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)
        ON CONFLICT(id) DO UPDATE SET title=excluded.title,artist=excluded.artist,artist_avatar=excluded.artist_avatar,image_url=excluded.image_url,
        preview_url=excluded.preview_url,aspect_ratio=excluded.aspect_ratio,width=excluded.width,height=excluded.height,rating=excluded.rating,
        score=excluded.score,description=excluded.description,media_type=excluded.media_type,created_at=excluded.created_at`,
				id, orDefault(str(s["title"]), id), orDefault(str(s["artist"]), "Unknown"), str(s["artistAvatar"]), str(s["imageUrl"]), str(s["previewUrl"]),
				ar, int64(w), int64(h), 0, orDefault(str(s["rating"]), "general"), int64(num(s["score"])), str(s["description"]),
				orDefault(str(s["mediaType"]), "image"), orDefault(str(s["createdAt"]), now)); err != nil {
				return err
			}
			for _, t := range s["tags"].([]any) {
				tm := t.(map[string]any)
				name := strings.TrimSpace(str(tm["name"]))
				if name == "" {
					continue
				}
				tid := orDefault(str(tm["id"]), "tag-"+name)
				if _, err := tx.Exec(`INSERT INTO tags (id,name,category,count) VALUES (?,?,?,?)
          ON CONFLICT(name) DO UPDATE SET category=excluded.category,count=excluded.count`,
					tid, name, orDefault(str(tm["category"]), "general"), int64(num(tm["count"]))); err != nil {
					return err
				}
				var rid string
				if tx.QueryRow("SELECT id FROM tags WHERE name=?", name).Scan(&rid) == nil {
					if _, err := tx.Exec("INSERT OR IGNORE INTO post_tags (post_id,tag_id) VALUES (?,?)", id, rid); err != nil {
						return err
					}
				}
			}
			if _, err := tx.Exec("INSERT OR IGNORE INTO profile_bookmarks (profile_id,post_id,created_at) VALUES (?,?,?)", profileID, id, now); err != nil {
				return err
			}
			imported++
		}
		return nil
	})
	if err != nil {
		return M{"imported": 0, "skipped": 0, "failed": len(snaps), "errors": []string{err.Error()}}
	}
	appendServerLog("INFO", "PROFILE_BOOKMARK_IMPORT", fmt.Sprintf("Imported %d, skipped %d, failed %d bookmark snapshots for %s", imported, skipped, failed, profileID))
	return M{"imported": imported, "skipped": skipped, "failed": failed, "errors": errs}
}

// ---------- 其它 ----------

func getAllTags(q querier) []M {
	rows, _ := queryMaps(q, "SELECT id,name,category,count FROM tags ORDER BY count DESC")
	return rows
}

type WebDAVConfig struct {
	URL        string  `json:"url"`
	Username   *string `json:"username,omitempty"`
	Password   *string `json:"password,omitempty"`
	RemotePath *string `json:"remotePath,omitempty"`
}

func getWebDAVConfig(q querier) *WebDAVConfig {
	var v string
	if q.QueryRow("SELECT value FROM app_metadata WHERE key=?", "webdav_config").Scan(&v) != nil || v == "" {
		return nil
	}
	var c WebDAVConfig
	if json.Unmarshal([]byte(v), &c) != nil {
		return nil
	}
	return &c
}

func setWebDAVConfig(q querier, c WebDAVConfig) error {
	b, _ := json.Marshal(c)
	_, err := q.Exec(`INSERT INTO app_metadata (key,value,updated_at) VALUES (?,?,?)
    ON CONFLICT(key) DO UPDATE SET value=excluded.value,updated_at=excluded.updated_at`, "webdav_config", string(b), nowISO())
	if err == nil {
		appendServerLog("INFO", "DATABASE", "Saved WebDAV configuration to app_metadata")
	}
	return err
}

// rememberPostForBookmark backfills an online post before a profile bookmark is written.
func rememberForBookmark(db *sql.DB, post M) (M, error) {
	if _, err := syncDanbooruToDB(db, []M{post}); err != nil {
		return nil, err
	}
	return post, nil
}

func fetchAndRememberForBookmark(ctx context.Context, db *sql.DB, id string) (M, error) {
	rawID, source := id, "danbooru"
	if prefix, suffix, ok := strings.Cut(id, "-"); ok {
		source, rawID = prefix, suffix
	}
	if source != "danbooru" {
		return nil, nil
	}
	posts, err := fetchDanbooruPosts(ctx, danbooruOptions{Tags: "id:" + rawID, Limit: 1, Rating: "all", ThrowOnFailure: true})
	if err != nil || len(posts) == 0 {
		return nil, err
	}
	return rememberForBookmark(db, posts[0])
}

func rememberPostForBookmark(ctx context.Context, db *sql.DB, profileID, id string) (M, error) {
	post, err := fetchAndRememberForBookmark(ctx, db, id)
	if err != nil || post == nil {
		return nil, err
	}
	return setBookmark(db, profileID, id, true)
}
