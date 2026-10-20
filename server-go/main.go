package main

import (
	"context"
	"errors"
	"net/http"
	"os"
	"os/signal"
	"path/filepath"
	"strings"
	"syscall"
	"time"
)

func withMiddleware(next http.Handler) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		h := w.Header()
		h.Set("Access-Control-Allow-Origin", "*")
		h.Set("Access-Control-Allow-Methods", "GET,POST,PUT,PATCH,DELETE,OPTIONS")
		h.Set("Access-Control-Allow-Headers", orDefault(r.Header.Get("Access-Control-Request-Headers"), "*"))
		if r.Method == http.MethodOptions {
			w.WriteHeader(http.StatusNoContent)
			return
		}
		if r.URL.Path != "/api/logs/latest" {
			appendServerLog("DEBUG", "HTTP_REQUEST", r.Method+" "+r.URL.RequestURI())
		}
		// 1MB JSON 限制（二进制附件上传除外）
		if r.Header.Get("Content-Type") != "application/octet-stream" && r.Body != nil {
			if r.ContentLength > 1<<20 {
				errJSON(w, http.StatusRequestEntityTooLarge, "请求内容超过大小限制")
				return
			}
			r.Body = http.MaxBytesReader(w, r.Body, 1<<20)
		}
		next.ServeHTTP(w, r)
	})
}

func main() {
	cwd, _ := os.Getwd()
	port := orDefault(os.Getenv("PORT"), "48300")
	dbPath := filepath.Join(cwd, "data", "tikbooru.db")
	if v := os.Getenv("DB_PATH"); v != "" {
		dbPath = v
	}
	_ = os.MkdirAll(filepath.Dir(dbPath), 0o755)
	db, err := initDatabase(dbPath)
	if err != nil {
		appendServerLog("ERROR", "STARTUP", "Database init failed", err.Error())
		os.Exit(1)
	}
	media := newMediaCache(db, filepath.Join(filepath.Dir(dbPath), "media-cache"))
	media.backfill()
	s := &server{db: db, media: media}
	srv := &http.Server{Addr: "0.0.0.0:" + port, Handler: withMiddleware(s.routes()), ReadHeaderTimeout: 15 * time.Second}

	go func() {
		appendServerLog("INFO", "STARTUP", "TikBooru Go backend listening on "+srv.Addr)
		if err := srv.ListenAndServe(); err != nil && !errors.Is(err, http.ErrServerClosed) {
			appendServerLog("ERROR", "STARTUP", err.Error())
			os.Exit(1)
		}
	}()
	stop := make(chan os.Signal, 1)
	signal.Notify(stop, os.Interrupt, syscall.SIGTERM)
	<-stop
	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()
	_ = srv.Shutdown(ctx)
	_ = db.Close()
	_ = strings.TrimSpace
}
