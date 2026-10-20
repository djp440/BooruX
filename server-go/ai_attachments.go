package main

import (
	"bytes"
	"database/sql"
	"encoding/base64"
	"encoding/binary"
	"errors"
	"image"
	"os"
	"path/filepath"
	"regexp"
	"sync"
	"time"

	"golang.org/x/image/webp"
)

var _ = webp.DecodeConfig

type Attachment struct {
	ID        string  `json:"id"`
	ProfileID string  `json:"profileId"`
	RunID     *string `json:"runId"`
	Mime      string  `json:"mime"`
	Size      int     `json:"size"`
	Width     int     `json:"width"`
	Height    int     `json:"height"`
	CreatedAt int64   `json:"createdAt"`
}

type Attachments struct {
	db   *sql.DB
	root string
	mu   sync.Mutex
	gen  map[string]int
}

var uuidRe = regexp.MustCompile(`^[0-9a-f-]{36}$`)

func newAttachments(db *sql.DB, root string) *Attachments {
	if root == "" {
		root = os.Getenv("AI_ATTACHMENTS_DIR")
	}
	if root == "" {
		root = filepath.Join(os.TempDir(), "tikbooru-ai-"+newUUID())
		if rows, _ := queryMaps(db, "PRAGMA database_list"); rows != nil {
			for _, r := range rows {
				if f := str(r["file"]); str(r["name"]) == "main" && f != "" {
					root = filepath.Join(filepath.Dir(f), "ai-attachments")
				}
			}
		}
	}
	abs, _ := filepath.Abs(root)
	return &Attachments{db: db, root: abs, gen: map[string]int{}}
}

func (a *Attachments) file(id string) (string, error) {
	if !uuidRe.MatchString(id) {
		return "", errors.New("附件不存在")
	}
	return filepath.Join(a.root, id), nil
}

func (a *Attachments) get(profileID, id string) (*Attachment, error) {
	x := &Attachment{}
	err := a.db.QueryRow("SELECT id,profileId,runId,mime,size,width,height,createdAt FROM ai_attachments WHERE id=? AND profileId=?", id, profileID).
		Scan(&x.ID, &x.ProfileID, &x.RunID, &x.Mime, &x.Size, &x.Width, &x.Height, &x.CreatedAt)
	if err != nil {
		return nil, errors.New("附件不存在")
	}
	return x, nil
}

const maxPixels = 25000000

var errBadImage = errors.New("仅支持可解码的 JPEG、PNG、WebP 和静态 GIF，最多 2500 万像素")

func inspectImage(b []byte) (format string, w, h int, err error) {
	cfg, format, err := image.DecodeConfig(bytes.NewReader(b))
	if err != nil {
		if c, e := webp.DecodeConfig(bytes.NewReader(b)); e == nil {
			cfg, format, err = image.Config{Width: c.Width, Height: c.Height}, "webp", nil
		} else {
			return "", 0, 0, errBadImage
		}
	}
	if cfg.Width <= 0 || cfg.Height <= 0 || cfg.Width*cfg.Height > maxPixels {
		return "", 0, 0, errBadImage
	}
	switch format {
	case "png":
		for off := 8; off+12 <= len(b); {
			n := int(binary.BigEndian.Uint32(b[off:]))
			if n < 0 || n > len(b)-off-12 || string(b[off+4:off+8]) == "acTL" {
				return "", 0, 0, errBadImage
			}
			off += n + 12
		}
	case "gif":
		if bytes.Count(b, []byte{0x21, 0xF9, 0x04}) > 1 { // 多个图形控制扩展 = 动画
			return "", 0, 0, errBadImage
		}
	case "webp":
		if bytes.Contains(b[:min(len(b), 64)], []byte("ANIM")) || bytes.Contains(b[:min(len(b), 64)], []byte("VP8X")) && len(b) > 20 && b[20]&0x02 != 0 {
			return "", 0, 0, errBadImage
		}
	case "jpeg":
	default:
		return "", 0, 0, errBadImage
	}
	return format, cfg.Width, cfg.Height, nil
}

func (a *Attachments) upload(profileID string, b []byte) (*Attachment, error) {
	a.mu.Lock()
	gen := a.gen[profileID]
	a.mu.Unlock()
	if len(b) == 0 || len(b) > 10*1024*1024 {
		return nil, errors.New("单张图片必须小于 10 MiB")
	}
	format, w, h, err := inspectImage(b)
	if err != nil {
		return nil, err
	}
	a.cleanup()
	id := newUUID()
	if err := os.MkdirAll(a.root, 0o755); err != nil {
		return nil, err
	}
	path, _ := a.file(id)
	if err := os.WriteFile(path, b, 0o644); err != nil {
		return nil, err
	}
	a.mu.Lock()
	changed := a.gen[profileID] != gen
	a.mu.Unlock()
	if changed {
		os.Remove(path)
		return nil, errors.New("对话已清空，请重新上传")
	}
	if _, err := a.db.Exec("INSERT INTO ai_attachments(id,profileId,mime,size,width,height,createdAt) VALUES(?,?,?,?,?,?,?)",
		id, profileID, "image/"+format, len(b), w, h, time.Now().UnixMilli()); err != nil {
		os.Remove(path)
		return nil, err
	}
	return a.get(profileID, id)
}

func (a *Attachments) validate(profileID string, ids []string, runID string) ([]*Attachment, error) {
	seen := map[string]bool{}
	for _, id := range ids {
		seen[id] = true
	}
	if len(ids) > 4 || len(seen) != len(ids) {
		return nil, errors.New("每条消息最多 4 张图片，不能重复")
	}
	var out []*Attachment
	total := 0
	for _, id := range ids {
		x, err := a.get(profileID, id)
		if err != nil {
			return nil, err
		}
		if x.RunID != nil && *x.RunID != runID {
			return nil, errors.New("附件已用于其他消息")
		}
		total += x.Size
		out = append(out, x)
	}
	if total > 20*1024*1024 {
		return nil, errors.New("图片合计不能超过 20 MiB")
	}
	return out, nil
}

func (a *Attachments) bind(q querier, profileID string, ids []string, runID string) error {
	if _, err := a.validate(profileID, ids, runID); err != nil {
		return err
	}
	for _, id := range ids {
		if _, err := q.Exec("UPDATE ai_attachments SET runId=? WHERE id=? AND profileId=?", runID, id, profileID); err != nil {
			return err
		}
	}
	return nil
}

func (a *Attachments) dataURL(profileID, id string) (string, error) {
	x, err := a.get(profileID, id)
	if err != nil {
		return "", err
	}
	p, _ := a.file(id)
	b, err := os.ReadFile(p)
	if err != nil {
		return "", err
	}
	return "data:" + x.Mime + ";base64," + base64.StdEncoding.EncodeToString(b), nil
}

func (a *Attachments) remove(profileID, id string, bound bool) error {
	x, err := a.get(profileID, id)
	if err != nil {
		return err
	}
	if x.RunID != nil && !bound {
		return errors.New("已发送的图片请通过清空对话删除")
	}
	p, _ := a.file(id)
	if err := os.Remove(p); err != nil && !os.IsNotExist(err) {
		return err
	}
	_, err = a.db.Exec("DELETE FROM ai_attachments WHERE id=? AND profileId=?", id, profileID)
	return err
}

func (a *Attachments) clear(profileID string) {
	a.mu.Lock()
	a.gen[profileID]++
	a.mu.Unlock()
	rows, _ := queryMaps(a.db, "SELECT id FROM ai_attachments WHERE profileId=?", profileID)
	for _, r := range rows {
		_ = a.remove(profileID, str(r["id"]), true)
	}
}

func (a *Attachments) cleanup() {
	rows, _ := queryMaps(a.db, "SELECT id,profileId FROM ai_attachments WHERE runId IS NULL AND createdAt<?", time.Now().Add(-24*time.Hour).UnixMilli())
	for _, r := range rows {
		_ = a.remove(str(r["profileId"]), str(r["id"]), false)
	}
}
