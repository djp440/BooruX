package main

import (
	"net/http"
	"regexp"
	"strings"
	"testing"
)

func TestWebEntryAndHealthShareHandler(t *testing.T) {
	h := testServer(t)

	for _, path := range []string{"/", "/post/danbooru-42", "/settings"} {
		w := do(h, http.MethodGet, path, "")
		if w.Code != http.StatusOK {
			t.Fatalf("GET %s: status = %d, body = %q", path, w.Code, w.Body.String())
		}
		if ct := w.Header().Get("Content-Type"); !strings.HasPrefix(ct, "text/html") {
			t.Fatalf("GET %s: Content-Type = %q", path, ct)
		}
		if !strings.Contains(w.Body.String(), "<title>BooruX</title>") {
			t.Fatalf("GET %s: missing Web entry document", path)
		}
	}

	w := do(h, http.MethodGet, "/api/health", "")
	if w.Code != http.StatusOK || !strings.Contains(w.Body.String(), `"status":"ok"`) {
		t.Fatalf("GET /api/health: status = %d, body = %q", w.Code, w.Body.String())
	}
}

func TestUnknownAPIRouteStaysAPI404(t *testing.T) {
	h := testServer(t)
	w := do(h, http.MethodGet, "/api/does-not-exist", "")
	if w.Code != http.StatusNotFound {
		t.Fatalf("status = %d, body = %q", w.Code, w.Body.String())
	}
	if strings.Contains(w.Body.String(), "<title>BooruX</title>") {
		t.Fatal("unknown API route was replaced by the Web entry document")
	}
}

func TestWebEntrySupportsHEAD(t *testing.T) {
	h := testServer(t)
	w := do(h, http.MethodHead, "/post/danbooru-42", "")
	if w.Code != http.StatusOK {
		t.Fatalf("status = %d", w.Code)
	}
	if ct := w.Header().Get("Content-Type"); !strings.HasPrefix(ct, "text/html") {
		t.Fatalf("Content-Type = %q", ct)
	}
	if w.Body.Len() != 0 {
		t.Fatalf("HEAD returned %d body bytes", w.Body.Len())
	}
}

func TestBuiltAssetsUseStaticMIMETypes(t *testing.T) {
	h := testServer(t)
	index := do(h, http.MethodGet, "/", "")
	for _, pattern := range []string{`(?:src|href)="(/assets/[^"]+\.js)"`, `(?:src|href)="(/assets/[^"]+\.css)"`} {
		match := regexp.MustCompile(pattern).FindStringSubmatch(index.Body.String())
		if len(match) != 2 {
			t.Fatalf("index does not reference an asset matching %s: %s", pattern, index.Body.String())
		}
		w := do(h, http.MethodGet, match[1], "")
		if w.Code != http.StatusOK {
			t.Fatalf("GET %s: status = %d", match[1], w.Code)
		}
		ct := w.Header().Get("Content-Type")
		if strings.HasSuffix(match[1], ".js") && !strings.Contains(ct, "javascript") {
			t.Fatalf("GET %s: Content-Type = %q", match[1], ct)
		}
		if strings.HasSuffix(match[1], ".css") && !strings.Contains(ct, "text/css") {
			t.Fatalf("GET %s: Content-Type = %q", match[1], ct)
		}
	}

	if w := do(h, http.MethodGet, "/assets/missing.js", ""); w.Code != http.StatusNotFound {
		t.Fatalf("missing asset: status = %d", w.Code)
	}
}
