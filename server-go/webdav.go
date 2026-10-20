package main

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net/http"
	"net/url"
	"path"
	"regexp"
	"sort"
	"strconv"
	"strings"
	"time"
)

const (
	backupPrefix = "tikbooru-backup-"
	backupSuffix = ".json"
	defaultRemote = "/tikbooru-backup"
)

type webdavService struct {
	baseURL, username, password, remotePath string
}

func newWebdavService(cfg WebDAVConfig) *webdavService {
	rp := "/" + strings.Trim(orDefault(deref(cfg.RemotePath), defaultRemote), "/")
	return &webdavService{baseURL: strings.TrimRight(cfg.URL, "/"), username: deref(cfg.Username), password: deref(cfg.Password), remotePath: strings.TrimRight(rp, "/")}
}

func deref(p *string) string {
	if p == nil {
		return ""
	}
	return *p
}

func (w *webdavService) do(ctx context.Context, method, target string, hdr map[string]string, body io.Reader) (*http.Response, error) {
	cctx, cancel := context.WithTimeout(ctx, 60*time.Second)
	req, err := http.NewRequestWithContext(cctx, method, target, body)
	if err != nil {
		cancel()
		return nil, err
	}
	if w.username != "" && w.password != "" {
		req.SetBasicAuth(w.username, w.password)
	}
	for k, v := range hdr {
		req.Header.Set(k, v)
	}
	res, err := http.DefaultClient.Do(req)
	if err != nil {
		cancel()
		appendServerLog("ERROR", "WEBDAV_NETWORK", err.Error())
		return nil, fmt.Errorf("WebDAV 网络连接失败: %s", err.Error())
	}
	res.Body = &cancelBody{res.Body, cancel}
	return res, nil
}

func (w *webdavService) dirURL() string { return w.baseURL + w.remotePath }
func (w *webdavService) fileURL(name string) string {
	return w.dirURL() + "/" + url.PathEscape(name)
}

func statusText(res *http.Response) string {
	return strings.TrimSpace(strings.TrimPrefix(res.Status, strconv.Itoa(res.StatusCode)))
}

func (w *webdavService) propfind(ctx context.Context, depth string) (*http.Response, error) {
	return w.do(ctx, "PROPFIND", w.dirURL(), map[string]string{"Depth": depth}, nil)
}

func isOK(res *http.Response) bool { return res.StatusCode >= 200 && res.StatusCode < 300 }

func (w *webdavService) testConnection(ctx context.Context) (bool, string, error) {
	res, err := w.propfind(ctx, "0")
	if err != nil {
		return false, "", err
	}
	res.Body.Close()
	if res.StatusCode == 401 {
		return false, "WebDAV 认证失败 (HTTP 401)，请检查用户名和密码", nil
	}
	if res.StatusCode == 404 {
		mk, err := w.do(ctx, "MKCOL", w.dirURL(), nil, nil)
		if err != nil {
			return false, "", err
		}
		mk.Body.Close()
		if !(isOK(mk) || mk.StatusCode == 201 || mk.StatusCode == 405) {
			return false, fmt.Sprintf("创建远端备份目录失败 (HTTP %d)，请检查权限", mk.StatusCode), nil
		}
		res, err = w.propfind(ctx, "0")
		if err != nil {
			return false, "", err
		}
		res.Body.Close()
	}
	if isOK(res) || res.StatusCode == 207 {
		return true, "WebDAV 连接成功且远端目录就绪", nil
	}
	return false, fmt.Sprintf("WebDAV 返回异常状态码: %d %s", res.StatusCode, statusText(res)), nil
}

func (w *webdavService) ensureDirectory(ctx context.Context) {
	res, err := w.propfind(ctx, "0")
	if err != nil {
		return
	}
	res.Body.Close()
	if res.StatusCode == 404 {
		if mk, err := w.do(ctx, "MKCOL", w.dirURL(), nil, nil); err == nil {
			mk.Body.Close()
		}
	}
}

func (w *webdavService) uploadBackup(ctx context.Context, profileID string, snaps []M) (M, error) {
	w.ensureDirectory(ctx)
	pid := orDefault(profileID, "default")
	ts := time.Now().UTC().Format("20060102150405")
	filename := fmt.Sprintf("%s%s-%s%s", backupPrefix, pid, ts, backupSuffix)
	payload, _ := json.MarshalIndent(M{"version": 1, "type": "tikbooru-bookmarks-backup", "exportedAt": nowISO(), "profileId": pid, "count": len(snaps), "snapshots": snaps}, "", "  ")
	res, err := w.do(ctx, "PUT", w.fileURL(filename), map[string]string{"Content-Type": "application/json; charset=utf-8"}, strings.NewReader(string(payload)))
	if err != nil {
		return nil, err
	}
	res.Body.Close()
	if !(isOK(res) || res.StatusCode == 201 || res.StatusCode == 204) {
		return nil, fmt.Errorf("上传备份至 WebDAV 失败 (HTTP %d %s)", res.StatusCode, statusText(res))
	}
	appendServerLog("INFO", "WEBDAV_BACKUP", fmt.Sprintf("Uploaded %d bookmarks to %s", len(snaps), filename))
	return M{"success": true, "filename": filename, "count": len(snaps)}, nil
}

var (
	responseRe = regexp.MustCompile(`(?is)<(?:[a-z0-9]+:)?response[^>]*>(.*?)</(?:[a-z0-9]+:)?response>`)
	hrefRe     = regexp.MustCompile(`(?is)<(?:[a-z0-9]+:)?href[^>]*>(.*?)</(?:[a-z0-9]+:)?href>`)
	lenRe      = regexp.MustCompile(`(?is)<(?:[a-z0-9]+:)?getcontentlength[^>]*>(.*?)</(?:[a-z0-9]+:)?getcontentlength>`)
	modRe      = regexp.MustCompile(`(?is)<(?:[a-z0-9]+:)?getlastmodified[^>]*>(.*?)</(?:[a-z0-9]+:)?getlastmodified>`)
)

func (w *webdavService) listBackups(ctx context.Context) ([]M, error) {
	w.ensureDirectory(ctx)
	res, err := w.propfind(ctx, "1")
	if err != nil {
		return nil, err
	}
	defer res.Body.Close()
	if !(isOK(res) || res.StatusCode == 207) {
		return nil, fmt.Errorf("获取云端备份列表失败 (HTTP %d)", res.StatusCode)
	}
	b, _ := io.ReadAll(res.Body)
	out := []M{}
	for _, m := range responseRe.FindAllStringSubmatch(string(b), -1) {
		hm := hrefRe.FindStringSubmatch(m[1])
		if hm == nil {
			continue
		}
		href := strings.TrimSpace(hm[1])
		if d, err := url.PathUnescape(href); err == nil {
			href = d
		}
		name := path.Base(strings.TrimRight(href, "/"))
		if !strings.HasPrefix(name, backupPrefix) || !strings.HasSuffix(name, backupSuffix) {
			continue
		}
		size := 0
		if lm := lenRe.FindStringSubmatch(m[1]); lm != nil {
			size, _ = strconv.Atoi(strings.TrimSpace(lm[1]))
		}
		lastMod := nowISO()
		if mm := modRe.FindStringSubmatch(m[1]); mm != nil {
			if t, err := time.Parse(time.RFC1123, strings.TrimSpace(mm[1])); err == nil {
				lastMod = iso(t)
			} else if t, err := time.Parse(time.RFC1123Z, strings.TrimSpace(mm[1])); err == nil {
				lastMod = iso(t)
			}
		}
		entry := M{"filename": name, "url": href, "size": size, "lastModified": lastMod}
		parts := strings.Split(strings.TrimSuffix(strings.TrimPrefix(name, backupPrefix), backupSuffix), "-")
		if len(parts) >= 2 {
			entry["profileId"] = strings.Join(parts[:len(parts)-1], "-")
		}
		out = append(out, entry)
	}
	sort.SliceStable(out, func(i, j int) bool { return str(out[i]["lastModified"]) > str(out[j]["lastModified"]) })
	return out, nil
}

func validBackupName(name string) (string, error) {
	base := path.Base(name)
	if !strings.HasPrefix(base, backupPrefix) || !strings.HasSuffix(base, backupSuffix) {
		return "", errors.New("INVALID_BACKUP_FILENAME")
	}
	return base, nil
}

func (w *webdavService) downloadBackup(ctx context.Context, filename string) (M, error) {
	name, err := validBackupName(filename)
	if err != nil {
		return nil, err
	}
	res, err := w.do(ctx, "GET", w.fileURL(name), nil, nil)
	if err != nil {
		return nil, err
	}
	defer res.Body.Close()
	if !isOK(res) {
		return nil, fmt.Errorf("下载云端备份文件失败 (HTTP %d)", res.StatusCode)
	}
	b, _ := io.ReadAll(res.Body)
	var v any
	if json.Unmarshal(b, &v) != nil {
		return nil, errors.New("云端备份文件损坏或不是合法的 JSON 格式")
	}
	if arr, ok := v.([]any); ok {
		return M{"version": 1, "type": "tikbooru-bookmarks-backup", "exportedAt": nowISO(), "profileId": "default", "count": len(arr), "snapshots": arr}, nil
	}
	obj, _ := v.(map[string]any)
	if _, ok := obj["snapshots"].([]any); !ok {
		return nil, errors.New("备份文件缺少有效快照列表 (snapshots 字段不是数组)")
	}
	return obj, nil
}

func (w *webdavService) deleteBackup(ctx context.Context, filename string) (bool, error) {
	name, err := validBackupName(filename)
	if err != nil {
		return false, err
	}
	res, err := w.do(ctx, "DELETE", w.fileURL(name), nil, nil)
	if err != nil {
		return false, err
	}
	res.Body.Close()
	return isOK(res) || res.StatusCode == 204 || res.StatusCode == 404, nil
}

// ---------- 路由 ----------

func maskConfig(c *WebDAVConfig) any {
	if c == nil {
		return nil
	}
	pw := ""
	if deref(c.Password) != "" {
		pw = "******"
	}
	return M{"url": c.URL, "username": deref(c.Username), "password": pw, "passwordMasked": pw != "", "remotePath": orDefault(deref(c.RemotePath), defaultRemote)}
}

func (s *server) resolveWebdav(b M) (*webdavService, error) {
	saved := getWebDAVConfig(s.db)
	if saved == nil {
		saved = &WebDAVConfig{}
	}
	cfg := *saved
	if u := strings.TrimSpace(str(b["url"])); u != "" {
		cfg.URL = u
	}
	if cfg.URL == "" {
		return nil, errors.New("未配置 WebDAV 服务器地址")
	}
	if v, ok := b["password"].(string); ok && v != "******" {
		cfg.Password = &v
	}
	if v, ok := b["username"].(string); ok {
		cfg.Username = &v
	}
	if v := str(b["remotePath"]); v != "" {
		cfg.RemotePath = &v
	}
	return newWebdavService(cfg), nil
}

func (s *server) webdavRoutes(mux *http.ServeMux) {
	fail := func(w http.ResponseWriter, code int, err error) { errJSON(w, code, err.Error()) }

	mux.HandleFunc("GET /api/webdav/config", func(w http.ResponseWriter, r *http.Request) {
		writeJSON(w, 200, M{"success": true, "config": maskConfig(getWebDAVConfig(s.db))})
	})
	mux.HandleFunc("POST /api/webdav/config", func(w http.ResponseWriter, r *http.Request) {
		b := readBody(r)
		u := strings.TrimSpace(str(b["url"]))
		if u == "" {
			errJSON(w, 400, "WebDAV 服务器地址不能为空")
			return
		}
		old := getWebDAVConfig(s.db)
		if old == nil {
			old = &WebDAVConfig{}
		}
		cfg := WebDAVConfig{URL: u}
		user := strings.TrimSpace(str(b["username"]))
		cfg.Username = &user
		pw := strings.TrimSpace(str(b["password"]))
		if str(b["password"]) == "******" {
			pw = deref(old.Password)
		}
		cfg.Password = &pw
		rp := strings.TrimSpace(str(b["remotePath"]))
		if rp == "" {
			rp = orDefault(deref(old.RemotePath), defaultRemote)
		}
		cfg.RemotePath = &rp
		if err := setWebDAVConfig(s.db, cfg); err != nil {
			fail(w, 500, err)
			return
		}
		writeJSON(w, 200, M{"success": true, "config": maskConfig(&cfg)})
	})
	mux.HandleFunc("POST /api/webdav/test", func(w http.ResponseWriter, r *http.Request) {
		svc, err := s.resolveWebdav(readBody(r))
		if err != nil {
			fail(w, 400, err)
			return
		}
		ok, msg, err := svc.testConnection(r.Context())
		if err != nil {
			fail(w, 400, err)
			return
		}
		if ok {
			writeJSON(w, 200, M{"success": true, "message": msg})
			return
		}
		errJSON(w, 400, msg)
	})
	mux.HandleFunc("POST /api/webdav/backup", func(w http.ResponseWriter, r *http.Request) {
		pid := orDefault(str(readBody(r)["profileId"]), "default")
		svc, err := s.resolveWebdav(M{})
		if err != nil {
			fail(w, 500, err)
			return
		}
		res, err := svc.uploadBackup(r.Context(), pid, getBookmarkSnapshots(s.db, pid))
		if err != nil {
			fail(w, 500, err)
			return
		}
		writeJSON(w, 200, merge(M{"success": true, "profileId": pid}, res))
	})
	mux.HandleFunc("GET /api/webdav/backups", func(w http.ResponseWriter, r *http.Request) {
		svc, err := s.resolveWebdav(M{})
		if err != nil {
			fail(w, 500, err)
			return
		}
		list, err := svc.listBackups(r.Context())
		if err != nil {
			fail(w, 500, err)
			return
		}
		writeJSON(w, 200, M{"success": true, "backups": list})
	})
	mux.HandleFunc("POST /api/webdav/restore", func(w http.ResponseWriter, r *http.Request) {
		b := readBody(r)
		pid := orDefault(str(b["profileId"]), "default")
		filename := strings.TrimSpace(str(b["filename"]))
		if filename == "" {
			errJSON(w, 400, "未指定要恢复的备份文件名")
			return
		}
		svc, err := s.resolveWebdav(M{})
		if err != nil {
			fail(w, 500, err)
			return
		}
		data, err := svc.downloadBackup(r.Context(), filename)
		if err != nil {
			fail(w, 500, err)
			return
		}
		snaps, _ := data["snapshots"].([]any)
		res := importBookmarkSnapshotBatch(s.db, pid, snaps)
		s.media.backfill()
		appendServerLog("INFO", "API_WEBDAV_RESTORE", fmt.Sprintf("Restored %s into %s", filename, pid))
		writeJSON(w, 200, merge(M{"success": true, "profileId": pid, "filename": filename, "totalInBackup": len(snaps)}, res))
	})
	mux.HandleFunc("DELETE /api/webdav/backups/{filename}", func(w http.ResponseWriter, r *http.Request) {
		svc, err := s.resolveWebdav(M{})
		if err != nil {
			fail(w, 500, err)
			return
		}
		ok, err := svc.deleteBackup(r.Context(), r.PathValue("filename"))
		if err != nil {
			fail(w, 500, err)
			return
		}
		writeJSON(w, 200, M{"success": ok})
	})
}
