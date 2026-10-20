package main

import (
	"embed"
	"io/fs"
	"net/http"
	"path"
	"strings"
)

//go:embed all:web
var webContent embed.FS

const webRoot = "web"

func (s *server) webHandler(api http.Handler) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.Method != http.MethodGet && r.Method != http.MethodHead || isAPIPath(r.URL.Path) {
			api.ServeHTTP(w, r)
			return
		}

		name, ok := webPath(r.URL.Path)
		if !ok {
			http.NotFound(w, r)
			return
		}
		if serveEmbedded(w, r, name) {
			return
		}
		if name != "index.html" && (strings.HasPrefix(name, "assets/") || path.Ext(name) != "") {
			http.NotFound(w, r)
			return
		}
		if !serveEmbedded(w, r, "index.html") {
			http.NotFound(w, r)
		}
	})
}

func isAPIPath(urlPath string) bool {
	return urlPath == "/api" || strings.HasPrefix(urlPath, "/api/")
}

func webPath(urlPath string) (string, bool) {
	if !strings.HasPrefix(urlPath, "/") || strings.ContainsRune(urlPath, '\\') || path.Clean(urlPath) != urlPath {
		return "", false
	}
	name := strings.TrimPrefix(urlPath, "/")
	if name == "" {
		name = "index.html"
	}
	return name, fs.ValidPath(name)
}

func serveEmbedded(w http.ResponseWriter, r *http.Request, name string) bool {
	name = path.Join(webRoot, name)
	f, err := webContent.Open(name)
	if err != nil {
		return false
	}
	defer f.Close()
	info, err := f.Stat()
	if err != nil || info.IsDir() {
		return false
	}
	http.ServeFileFS(w, r, webContent, name)
	return true
}
