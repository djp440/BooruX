package main

import (
	"net/http"
	"regexp"
	"strings"
	"testing"
)

func TestWebEntryAndHealthShareHandler(t *testing.T) {
	h := testServer(t)

	for _, path := range []string{"/", "/index.html", "/post/danbooru-42", "/posts/danbooru-42", "/favorites/posts/yandere-1270993", "/settings"} {
		w := do(h, http.MethodGet, path, "")
		if w.Code != http.StatusOK {
			t.Fatalf("GET %s: status = %d, body = %q", path, w.Code, w.Body.String())
		}
		if ct := w.Header().Get("Content-Type"); !strings.HasPrefix(ct, "text/html") {
			t.Fatalf("GET %s: Content-Type = %q", path, ct)
		}
		if cc := w.Header().Get("Cache-Control"); cc != "no-cache, must-revalidate" {
			t.Fatalf("GET %s: Cache-Control = %q, want %q", path, cc, "no-cache, must-revalidate")
		}
		if nosniff := w.Header().Get("X-Content-Type-Options"); nosniff != "nosniff" {
			t.Fatalf("GET %s: X-Content-Type-Options = %q, want %q", path, nosniff, "nosniff")
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
	if cc := w.Header().Get("Cache-Control"); cc != "no-cache, must-revalidate" {
		t.Fatalf("Cache-Control = %q, want %q", cc, "no-cache, must-revalidate")
	}
	if nosniff := w.Header().Get("X-Content-Type-Options"); nosniff != "nosniff" {
		t.Fatalf("X-Content-Type-Options = %q, want %q", nosniff, "nosniff")
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
		if cc := w.Header().Get("Cache-Control"); cc != "public, max-age=31536000, immutable" {
			t.Fatalf("GET %s: Cache-Control = %q, want %q", match[1], cc, "public, max-age=31536000, immutable")
		}
		if nosniff := w.Header().Get("X-Content-Type-Options"); nosniff != "nosniff" {
			t.Fatalf("GET %s: X-Content-Type-Options = %q, want %q", match[1], nosniff, "nosniff")
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

func TestStaticHeadersAndCacheControl(t *testing.T) {
	h := testServer(t)

	// 1. Entry routes & SPA fallback routes must have no-cache, must-revalidate and nosniff
	entryRoutes := []string{
		"/",
		"/index.html",
		"/post/danbooru-42",
		"/posts/danbooru-42",
		"/favorites/posts/yandere-1270993",
		"/settings",
		"/non-existent-spa-route",
	}
	for _, p := range entryRoutes {
		w := do(h, http.MethodGet, p, "")
		if w.Code != http.StatusOK {
			t.Fatalf("GET %s: status = %d, want 200", p, w.Code)
		}
		if cc := w.Header().Get("Cache-Control"); cc != "no-cache, must-revalidate" {
			t.Fatalf("GET %s: Cache-Control = %q, want %q", p, cc, "no-cache, must-revalidate")
		}
		if nosniff := w.Header().Get("X-Content-Type-Options"); nosniff != "nosniff" {
			t.Fatalf("GET %s: X-Content-Type-Options = %q, want %q", p, nosniff, "nosniff")
		}
	}

	// 2. /assets/* static resources must have long-term immutable cache and nosniff
	index := do(h, http.MethodGet, "/", "")
	match := regexp.MustCompile(`(?:src|href)="(/assets/[^"]+\.js)"`).FindStringSubmatch(index.Body.String())
	if len(match) != 2 {
		t.Fatalf("failed to find JS asset in index")
	}
	assetPath := match[1]
	w := do(h, http.MethodGet, assetPath, "")
	if w.Code != http.StatusOK {
		t.Fatalf("GET %s: status = %d", assetPath, w.Code)
	}
	if cc := w.Header().Get("Cache-Control"); cc != "public, max-age=31536000, immutable" {
		t.Fatalf("GET %s: Cache-Control = %q, want %q", assetPath, cc, "public, max-age=31536000, immutable")
	}
	if nosniff := w.Header().Get("X-Content-Type-Options"); nosniff != "nosniff" {
		t.Fatalf("GET %s: X-Content-Type-Options = %q, want %q", assetPath, nosniff, "nosniff")
	}

	// 3. Static assets with missing file should return 404
	if wMissing := do(h, http.MethodGet, "/assets/not-found.js", ""); wMissing.Code != http.StatusNotFound {
		t.Fatalf("missing asset should 404, got %d", wMissing.Code)
	}
	if wMissingExt := do(h, http.MethodGet, "/not-found.png", ""); wMissingExt.Code != http.StatusNotFound {
		t.Fatalf("missing file with ext should 404, got %d", wMissingExt.Code)
	}
}
