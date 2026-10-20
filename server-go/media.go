package main

import (
	"context"
	"crypto/sha256"
	"database/sql"
	"encoding/hex"
	"errors"
	"fmt"
	"image"
	"image/gif"
	"image/jpeg"
	"image/png"
	"io"
	"net/http"
	"net/url"
	"os"
	"path"
	"path/filepath"
	"regexp"
	"strconv"
	"strings"
	"sync"
	"time"

	"github.com/HugoSmits86/nativewebp"
	xdraw "golang.org/x/image/draw"
	_ "golang.org/x/image/webp"
)

var defaultMediaHosts = []string{
	"cdn.donmai.us", "danbooru.donmai.us", "safebooru.org", "yande.re", "images.unsplash.com",
	"files.yande.re", "media.giphy.com", "commondatastorage.googleapis.com",
}

const mediaUA = "TikBooru/1.0 (+https://github.com/tikbooru/tikbooru)"

type MediaCache struct {
	db           *sql.DB
	cacheDir     string
	hosts        []string
	concurrency  int
	imageFormat  string
	client       *http.Client
	mu           sync.Mutex
	queued       map[string]bool
	queue        []string
	active       int
	idleWaiters  []chan struct{}
	retryBackoff time.Duration
}

type cachedFile struct {
	Path, Status, ContentType, StorageFormat string
	Size                                     int64
}

func newMediaCache(db *sql.DB, cacheDir string) *MediaCache {
	if cacheDir == "" {
		cwd, _ := os.Getwd()
		cacheDir = filepath.Join(cwd, "data", "media-cache")
	}
	format := "original"
	if os.Getenv("MEDIA_CACHE_IMAGE_FORMAT") == "webp" {
		format = "webp"
	}
	return &MediaCache{db: db, cacheDir: cacheDir, hosts: defaultMediaHosts, concurrency: 2, imageFormat: format,
		queued: map[string]bool{}, retryBackoff: 250 * time.Millisecond,
		client: &http.Client{CheckRedirect: func(*http.Request, []*http.Request) error { return http.ErrUseLastResponse }}}
}

func unwrapMediaURL(v string) string {
	if !strings.HasPrefix(v, "/api/media?") {
		return v
	}
	q, err := url.ParseQuery(v[strings.Index(v, "?")+1:])
	if err != nil || q.Get("url") == "" {
		return v
	}
	return q.Get("url")
}

var extOkRe = regexp.MustCompile(`^\.[a-z0-9]{1,8}$`)

func extensionFor(rawURL, contentType string) string {
	m := map[string]string{"image/jpeg": ".jpg", "image/png": ".png", "image/gif": ".gif", "image/webp": ".webp", "video/mp4": ".mp4", "video/webm": ".webm"}
	if e, ok := m[contentType]; ok {
		return e
	}
	if u, err := url.Parse(rawURL); err == nil {
		if e := strings.ToLower(path.Ext(u.Path)); extOkRe.MatchString(e) {
			return e
		}
	}
	return ".bin"
}

func (m *MediaCache) enqueue(postID string) {
	if postID == "" {
		return
	}
	m.mu.Lock()
	if m.queued[postID] {
		m.mu.Unlock()
		return
	}
	m.queued[postID] = true
	m.queue = append(m.queue, postID)
	m.mu.Unlock()
	go m.pump()
}

func (m *MediaCache) backfill() {
	rows, err := queryMaps(m.db, "SELECT DISTINCT post_id AS postId FROM profile_bookmarks")
	if err != nil {
		return
	}
	for _, r := range rows {
		m.enqueue(str(r["postId"]))
	}
	appendServerLog("INFO", "MEDIA_CACHE", fmt.Sprintf("Scheduled %d bookmarked media files for backfill", len(rows)))
}

func (m *MediaCache) waitForIdle() {
	m.mu.Lock()
	if m.active == 0 && len(m.queue) == 0 {
		m.mu.Unlock()
		return
	}
	ch := make(chan struct{})
	m.idleWaiters = append(m.idleWaiters, ch)
	m.mu.Unlock()
	<-ch
}

func (m *MediaCache) pump() {
	m.mu.Lock()
	for m.active < m.concurrency && len(m.queue) > 0 {
		id := m.queue[0]
		m.queue = m.queue[1:]
		m.active++
		go func() {
			m.cachePost(id)
			m.mu.Lock()
			m.active--
			delete(m.queued, id)
			m.mu.Unlock()
			m.pump()
			m.mu.Lock()
			if m.active == 0 && len(m.queue) == 0 {
				for _, w := range m.idleWaiters {
					close(w)
				}
				m.idleWaiters = nil
			}
			m.mu.Unlock()
		}()
	}
	m.mu.Unlock()
}

func (m *MediaCache) getCachedFile(postID string) *cachedFile {
	row, _ := queryMap(m.db, "SELECT local_path,status,content_type,size_bytes,storage_format FROM media_cache WHERE post_id=?", postID)
	if row == nil {
		return nil
	}
	f := &cachedFile{Path: str(row["local_path"]), Status: str(row["status"]), ContentType: orDefault(str(row["content_type"]), "application/octet-stream"),
		Size: int64(num(row["size_bytes"])), StorageFormat: str(row["storage_format"])}
	if _, err := os.Stat(f.Path); f.Path == "" || err != nil {
		if f.Status == "ready" {
			f.Status = "failed"
		}
	}
	return f
}

func (m *MediaCache) thumbPath(postID string) string {
	sum := sha256.Sum256([]byte(postID))
	return filepath.Join(m.cacheDir, hex.EncodeToString(sum[:])+".thumb.webp")
}

func makeThumbnail(src, dst string) error {
	f, err := os.Open(src)
	if err != nil {
		return err
	}
	defer f.Close()
	img, _, err := image.Decode(f)
	if err != nil {
		return err
	}
	b := img.Bounds()
	if b.Dx() > 640 {
		h := b.Dy() * 640 / b.Dx()
		if h < 1 {
			h = 1
		}
		out := image.NewRGBA(image.Rect(0, 0, 640, h))
		xdraw.CatmullRom.Scale(out, out.Bounds(), img, b, xdraw.Over, nil)
		img = out
	}
	tmp := dst + "." + randBase36(6) + ".part"
	o, err := os.Create(tmp)
	if err != nil {
		return err
	}
	if err := nativewebp.Encode(o, img, nil); err != nil {
		o.Close()
		os.Remove(tmp)
		return err
	}
	o.Close()
	return os.Rename(tmp, dst)
}

func (m *MediaCache) getThumbnailFile(postID string) *cachedFile {
	c := m.getCachedFile(postID)
	if c == nil || c.Status != "ready" || c.Path == "" || !strings.HasPrefix(c.ContentType, "image/") || c.ContentType == "image/gif" {
		return nil
	}
	tp := m.thumbPath(postID)
	if s, err := os.Stat(tp); err == nil && s.Size() > 0 {
		return &cachedFile{Path: tp, ContentType: "image/webp", Size: s.Size()}
	}
	if err := makeThumbnail(c.Path, tp); err != nil {
		appendServerLog("WARN", "MEDIA_CACHE", "On-demand thumbnail generation failed for "+postID, err.Error())
		return nil
	}
	s, err := os.Stat(tp)
	if err != nil {
		return nil
	}
	return &cachedFile{Path: tp, ContentType: "image/webp", Size: s.Size()}
}

func (m *MediaCache) isAllowed(raw string) bool {
	u, err := url.Parse(raw)
	if err != nil {
		return false
	}
	h := strings.ToLower(u.Hostname())
	for _, a := range m.hosts {
		if h == a || strings.HasSuffix(h, "."+a) {
			return true
		}
	}
	return false
}

func (m *MediaCache) fetchAllowed(ctx context.Context, raw string) (*http.Response, error) {
	cur := raw
	for i := 0; i <= 5; i++ {
		if !m.isAllowed(cur) {
			return nil, errors.New("Forbidden media host")
		}
		cctx, cancel := context.WithTimeout(ctx, 120*time.Second)
		req, err := http.NewRequestWithContext(cctx, "GET", cur, nil)
		if err != nil {
			cancel()
			return nil, err
		}
		req.Header.Set("User-Agent", mediaUA)
		req.Header.Set("Accept", "*/*")
		res, err := m.client.Do(req)
		if err != nil {
			cancel()
			return nil, err
		}
		res.Body = &cancelBody{res.Body, cancel}
		if res.StatusCode < 300 || res.StatusCode >= 400 {
			return res, nil
		}
		loc := res.Header.Get("Location")
		res.Body.Close()
		if loc == "" {
			return res, nil
		}
		base, _ := url.Parse(cur)
		next, err := base.Parse(loc)
		if err != nil {
			return nil, err
		}
		cur = next.String()
	}
	return nil, errors.New("Too many media redirects")
}

type cancelBody struct {
	io.ReadCloser
	cancel context.CancelFunc
}

func (c *cancelBody) Close() error { err := c.ReadCloser.Close(); c.cancel(); return err }

func (m *MediaCache) fetchJSON(ctx context.Context, u string, out any) bool {
	res, err := m.fetchAllowed(ctx, u)
	if err != nil {
		return false
	}
	defer res.Body.Close()
	if res.StatusCode < 200 || res.StatusCode > 299 {
		return false
	}
	b, _ := io.ReadAll(res.Body)
	return jsonUnmarshal(b, out) == nil
}

func (m *MediaCache) resolveOriginalURL(ctx context.Context, postID, current string) (string, error) {
	needD := strings.HasPrefix(postID, "danbooru-") && !strings.Contains(current, "/original/")
	needS := strings.HasPrefix(postID, "safebooru-") && !strings.Contains(current, "/images/")
	needY := strings.HasPrefix(postID, "yandere-") && !strings.Contains(current, "/image/")
	if needD {
		id := strings.TrimPrefix(postID, "danbooru-")
		var raw M
		if m.fetchJSON(ctx, "https://danbooru.donmai.us/posts/"+url.PathEscape(id)+".json", &raw) {
			var variants []any
			if ma, ok := raw["media_asset"].(map[string]any); ok {
				variants, _ = ma["variants"].([]any)
			}
			if o := firstNonEmpty(variantURL(variants, "original"), str(raw["file_url"])); o != "" {
				return o, nil
			}
		}
	}
	if needS {
		id := strings.TrimPrefix(postID, "safebooru-")
		var arr []M
		if m.fetchJSON(ctx, "https://safebooru.org/index.php?page=dapi&s=post&q=index&json=1&id="+url.QueryEscape(id), &arr) && len(arr) > 0 {
			r := arr[0]
			o := str(r["file_url"])
			if o == "" && str(r["directory"]) != "" && str(r["image"]) != "" {
				o = fmt.Sprintf("https://safebooru.org/images/%s/%s", str(r["directory"]), str(r["image"]))
			}
			if o != "" {
				return o, nil
			}
		}
	}
	if needY {
		id := strings.TrimPrefix(postID, "yandere-")
		var arr []M
		if m.fetchJSON(ctx, "https://yande.re/post.json?tags=id:"+url.QueryEscape(id), &arr) && len(arr) > 0 {
			if o := str(arr[0]["file_url"]); o != "" {
				return o, nil
			}
		}
	}
	if needD || needS || needY {
		err := fmt.Errorf("Original media URL unavailable for %s", postID)
		appendServerLog("WARN", "MEDIA_CACHE", "Could not resolve original URL for "+postID, err.Error())
		return "", err
	}
	return current, nil
}

func (m *MediaCache) cachePost(postID string) {
	post, _ := queryMap(m.db, "SELECT image_url,media_type FROM posts WHERE id=?", postID)
	if post == nil {
		return
	}
	ready := m.getCachedFile(postID)
	desired := "original"
	if m.imageFormat == "webp" && str(post["media_type"]) == "image" {
		desired = "webp"
	}
	if ready != nil && ready.Status == "ready" && ready.StorageFormat == desired {
		return
	}
	stored := unwrapMediaURL(str(post["image_url"]))
	_, _ = m.db.Exec(`INSERT INTO media_cache (post_id,source_url,status,attempts,updated_at) VALUES (?,?,'pending',0,?)
    ON CONFLICT(post_id) DO UPDATE SET source_url=excluded.source_url,status='pending',error=NULL,updated_at=excluded.updated_at`, postID, stored, nowISO())
	_ = os.MkdirAll(m.cacheDir, 0o755)
	sum := sha256.Sum256([]byte(postID))
	key := hex.EncodeToString(sum[:])
	for attempt := 1; attempt <= 3; attempt++ {
		err := m.tryCache(postID, key, stored, desired, ready)
		if err == nil {
			return
		}
		if attempt < 3 {
			time.Sleep(time.Duration(attempt) * m.retryBackoff)
			continue
		}
		_, _ = m.db.Exec("UPDATE media_cache SET status='failed',error=?,updated_at=? WHERE post_id=?", err.Error(), nowISO(), postID)
		appendServerLog("WARN", "MEDIA_CACHE", fmt.Sprintf("Failed to cache media for %s after %d attempts", postID, attempt), err.Error())
	}
}

func (m *MediaCache) tryCache(postID, key, stored, desired string, ready *cachedFile) error {
	ctx := context.Background()
	tmp := filepath.Join(m.cacheDir, key+"."+randBase36(12)+".part")
	defer os.Remove(tmp)
	_, _ = m.db.Exec("UPDATE media_cache SET attempts=attempts+1,updated_at=? WHERE post_id=?", nowISO(), postID)
	src, err := m.resolveOriginalURL(ctx, postID, stored)
	if err != nil {
		return err
	}
	_, _ = m.db.Exec("UPDATE media_cache SET source_url=? WHERE post_id=?", src, postID)
	res, err := m.fetchAllowed(ctx, src)
	if err != nil {
		return err
	}
	defer res.Body.Close()
	if res.StatusCode < 200 || res.StatusCode > 299 {
		return fmt.Errorf("Upstream media returned %d", res.StatusCode)
	}
	upstream := strings.TrimSpace(strings.SplitN(orDefault(res.Header.Get("Content-Type"), "application/octet-stream"), ";", 2)[0])
	toWebp := desired == "webp" && strings.HasPrefix(upstream, "image/") && upstream != "image/gif"
	contentType, format := upstream, "original"
	finalExt := extensionFor(res.Request.URL.String(), upstream)
	if toWebp {
		contentType, format, finalExt = "image/webp", "webp", ".webp"
	}
	finalPath := filepath.Join(m.cacheDir, key+finalExt)
	f, err := os.OpenFile(tmp, os.O_CREATE|os.O_EXCL|os.O_WRONLY, 0o644)
	if err != nil {
		return err
	}
	if toWebp {
		img, _, derr := image.Decode(res.Body)
		if derr == nil {
			derr = nativewebp.Encode(f, img, nil)
		}
		err = derr
	} else {
		_, err = io.Copy(f, res.Body)
	}
	if cerr := f.Close(); err == nil {
		err = cerr
	}
	if err != nil {
		return err
	}
	_ = os.Remove(finalPath)
	if err := os.Rename(tmp, finalPath); err != nil {
		return err
	}
	if ready != nil && ready.Path != "" && ready.Path != finalPath {
		_ = os.Remove(ready.Path)
	}
	st, err := os.Stat(finalPath)
	if err != nil {
		return err
	}
	if strings.HasPrefix(contentType, "image/") && contentType != "image/gif" {
		if terr := makeThumbnail(finalPath, filepath.Join(m.cacheDir, key+".thumb.webp")); terr != nil {
			appendServerLog("WARN", "MEDIA_CACHE", "Failed to generate thumbnail for "+postID, terr.Error())
		}
	}
	_, _ = m.db.Exec(`UPDATE media_cache SET local_path=?,status='ready',content_type=?,size_bytes=?,storage_format=?,error=NULL,updated_at=? WHERE post_id=?`,
		finalPath, contentType, st.Size(), format, nowISO(), postID)
	appendServerLog("INFO", "MEDIA_CACHE", "Cached media for "+postID, M{"path": finalPath, "size": st.Size(), "storageFormat": format})
	return nil
}

// ---------- 路由 ----------

var rangeRe = regexp.MustCompile(`^bytes=(\d*)-(\d*)$`)
var proxyHosts = []string{"cdn.donmai.us", "safebooru.org", "yande.re", "images.unsplash.com", "files.yande.re"}

func (s *server) mediaCacheHandler(w http.ResponseWriter, r *http.Request) {
	postID := r.PathValue("postId")
	q := r.URL.Query()
	if q.Get("thumbnail") == "1" || q.Get("thumb") == "1" {
		if t := s.media.getThumbnailFile(postID); t != nil {
			if f, err := os.Open(t.Path); err == nil {
				defer f.Close()
				w.Header().Set("Content-Type", t.ContentType)
				w.Header().Set("Content-Length", strconv.FormatInt(t.Size, 10))
				w.Header().Set("Cache-Control", "public, max-age=31536000, immutable")
				_, _ = io.Copy(w, f)
				return
			}
		}
	}
	c := s.media.getCachedFile(postID)
	if c == nil || c.Status != "ready" || c.Size <= 0 {
		http.Error(w, "Cached media not found", 404)
		return
	}
	start, end := int64(0), c.Size-1
	status := 200
	if rh := r.Header.Get("Range"); rh != "" {
		bad := func() {
			w.Header().Set("Content-Range", fmt.Sprintf("bytes */%d", c.Size))
			w.WriteHeader(416)
		}
		mt := rangeRe.FindStringSubmatch(rh)
		if mt == nil || (mt[1] == "" && mt[2] == "") {
			bad()
			return
		}
		if mt[1] == "" {
			n, _ := strconv.ParseInt(mt[2], 10, 64)
			start = max(0, c.Size-n)
		} else {
			start, _ = strconv.ParseInt(mt[1], 10, 64)
			if mt[2] != "" {
				e, _ := strconv.ParseInt(mt[2], 10, 64)
				end = min(e, end)
			}
		}
		if start > end || start >= c.Size {
			bad()
			return
		}
		status = 206
		w.Header().Set("Content-Range", fmt.Sprintf("bytes %d-%d/%d", start, end, c.Size))
	}
	f, err := os.Open(c.Path)
	if err != nil {
		http.Error(w, "Cached media not found", 404)
		return
	}
	defer f.Close()
	_, _ = f.Seek(start, io.SeekStart)
	w.Header().Set("Content-Type", c.ContentType)
	w.Header().Set("Content-Length", strconv.FormatInt(end-start+1, 10))
	w.Header().Set("Accept-Ranges", "bytes")
	w.Header().Set("Cache-Control", "public, max-age=31536000, immutable")
	w.WriteHeader(status)
	_, _ = io.CopyN(w, f, end-start+1)
}

func (s *server) mediaProxyHandler(w http.ResponseWriter, r *http.Request) {
	mediaURL := r.URL.Query().Get("url")
	if mediaURL == "" {
		http.Error(w, "Missing url query parameter", 400)
		return
	}
	u, err := url.Parse(mediaURL)
	if err != nil || u.Host == "" {
		appendServerLog("WARN", "MEDIA_PROXY", "Failed to proxy media for "+mediaURL, fmt.Sprint(err))
		http.Error(w, "Failed to fetch upstream media", 502)
		return
	}
	ok := false
	for _, h := range proxyHosts {
		if strings.HasSuffix(u.Hostname(), h) {
			ok = true
		}
	}
	if !ok {
		http.Error(w, "Forbidden media host", 403)
		return
	}
	ctx, cancel := context.WithTimeout(r.Context(), 15*time.Second)
	defer cancel()
	req, _ := http.NewRequestWithContext(ctx, "GET", mediaURL, nil)
	req.Header.Set("User-Agent", userAgent)
	req.Header.Set("Accept", "*/*")
	if rg := r.Header.Get("Range"); rg != "" {
		req.Header.Set("Range", rg)
	}
	res, err := http.DefaultClient.Do(req)
	if err != nil {
		appendServerLog("WARN", "MEDIA_PROXY", "Failed to proxy media for "+mediaURL, err.Error())
		http.Error(w, "Failed to fetch upstream media", 502)
		return
	}
	defer res.Body.Close()
	if res.StatusCode < 200 || res.StatusCode > 299 {
		appendServerLog("WARN", "MEDIA_PROXY", fmt.Sprintf("Upstream media error: %d for %s", res.StatusCode, mediaURL))
		http.Error(w, fmt.Sprintf("Upstream media returned %d", res.StatusCode), res.StatusCode)
		return
	}
	h := w.Header()
	h.Set("Content-Type", orDefault(res.Header.Get("Content-Type"), "application/octet-stream"))
	h.Set("Accept-Ranges", orDefault(res.Header.Get("Accept-Ranges"), "bytes"))
	h.Set("Cache-Control", "public, max-age=604800, immutable")
	h.Set("Access-Control-Allow-Origin", "*")
	if cl := res.Header.Get("Content-Length"); cl != "" {
		h.Set("Content-Length", cl)
	}
	if cr := res.Header.Get("Content-Range"); cr != "" {
		h.Set("Content-Range", cr)
	}
	w.WriteHeader(res.StatusCode)
	_, _ = io.Copy(w, res.Body)
}

var _ = gif.Decode
var _ = jpeg.Decode
var _ = png.Decode
