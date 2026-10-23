package main

import (
	"bytes"
	"encoding/json"
	"image"
	"image/png"
	"io"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"strings"
	"sync"
	"testing"
)

func TestQuotedBookmarkIntent(t *testing.T) {
	q := "\n\n[引用作品：q1]"
	if !explicitBookmarkIntent("帮我加入收藏夹"+q, "q1", true) || explicitBookmarkIntent("帮我加入收藏夹"+q, "q2", true) {
		t.Fatal("引用单件作品的收藏意图")
	}
	if explicitBookmarkIntent("取消收藏"+q, "q1", true) || !explicitBookmarkIntent("取消收藏"+q, "q1", false) || explicitBookmarkIntent("看看这张图"+q, "q1", true) {
		t.Fatal("取消收藏或无收藏意图")
	}
	// 引用多件：目标在引用列表内即可；列表外的 ID、否定句、没有操作词都不行
	multi := "\n\n[引用作品：q1、q2、q3]"
	if !explicitBookmarkIntent("帮我收藏这几张"+multi, "q2", true) || !explicitBookmarkIntent("取消收藏这几张"+multi, "q3", false) {
		t.Fatal("引用多件时应允许对其中任一件操作")
	}
	if explicitBookmarkIntent("帮我收藏这几张"+multi, "q9", true) || explicitBookmarkIntent("不要收藏"+multi, "q1", true) ||
		explicitBookmarkIntent("别收藏这些"+multi, "q1", true) || explicitBookmarkIntent("这几张是什么"+multi, "q1", true) {
		t.Fatal("列表外 ID、否定句或无操作词不应放行")
	}
}

// 收藏会触发媒体缓存重新下载，因此看图场景用另一件作品 q2。
// 场景 A：引用作品并要求收藏，模型直接 set_bookmark，不看图；场景 B：要求看图，模型调用 view_post_image 并在后续请求中收到图片。
func TestAgentViewsQuotedImageOnDemand(t *testing.T) {
	var bodies []string
	var mu sync.Mutex
	fake := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		b, _ := io.ReadAll(r.Body)
		body := string(b)
		mu.Lock()
		bodies = append(bodies, body)
		mu.Unlock()
		w.Header().Set("Content-Type", "text/event-stream")
		frames := []string{`{"choices":[{"delta":{"content":"完成"}}]}`, `{"choices":[{"delta":{},"finish_reason":"stop"}]}`}
		var msgs struct{ Messages []M }
		_ = json.Unmarshal(b, &msgs)
		lastRole := str(msgs.Messages[len(msgs.Messages)-1]["role"])
		call := func(name, args string) []string {
			return []string{`{"choices":[{"delta":{"tool_calls":[{"index":0,"id":"c-` + name + `","function":{"name":"` + name + `","arguments":` + args + `}}]}}]}`,
				`{"choices":[{"delta":{},"finish_reason":"tool_calls"}]}`}
		}
		if lastRole == "user" && strings.Contains(body, "加入收藏夹") && !strings.Contains(body, "c-set_bookmark") {
			frames = call("set_bookmark", `"{\"id\":\"q1\",\"bookmarked\":true}"`)
		} else if lastRole == "user" && strings.Contains(body, "图里有什么") && !strings.Contains(body, "c-view_post_image") {
			frames = call("view_post_image", `"{\"id\":\"q2\"}"`)
		}
		for _, f := range append(frames, "[DONE]") {
			_, _ = io.WriteString(w, "data: "+f+"\n\n")
		}
	}))
	defer fake.Close()
	db, err := initDatabase(":memory:")
	if err != nil {
		t.Fatal(err)
	}
	dir := t.TempDir()
	h := withMiddleware((&server{db: db, media: newMediaCache(db, dir)}).routes())
	if _, err := setProfileSettings(db, defaultProfileID, M{"dataSource": "sqlite"}); err != nil {
		t.Fatal(err)
	}
	src := filepath.Join(dir, "q1.png")
	f, _ := os.Create(src)
	_ = png.Encode(f, image.NewRGBA(image.Rect(0, 0, 8, 8)))
	f.Close()
	if _, err := db.Exec(`INSERT INTO ai_providers(id,name,baseUrl,apiKey) VALUES('p','P',?,''); INSERT INTO ai_models(providerId,id,name,manual) VALUES('p','m','m',1);
      INSERT INTO posts(id,title,artist,image_url,preview_url,rating,created_at) VALUES('q1','t','a','http://x/i.jpg','http://x/p.jpg','general','2026-01-01'),('q2','t','a','http://x/i.jpg','http://x/p.jpg','general','2026-01-01')`, fake.URL+"/v1"); err != nil {
		t.Fatal(err)
	}
	if _, err := db.Exec(`INSERT INTO media_cache(post_id,source_url,local_path,status,content_type,size_bytes,updated_at) VALUES('q2','http://x/i.png',?,'ready','image/png',1,'')`, src); err != nil {
		t.Fatal(err)
	}
	do(h, "PUT", "/api/profiles/default/chat", `{"providerId":"p","modelId":"m"}`)
	newConv := func() string {
		var out struct{ Conversation M }
		_ = json.Unmarshal(do(h, "POST", "/api/profiles/default/conversations", "").Body.Bytes(), &out)
		return str(out.Conversation["id"])
	}
	countImages := func() int {
		mu.Lock()
		defer mu.Unlock()
		n := 0
		for _, b := range bodies {
			n += strings.Count(b, "data:image/")
		}
		return n
	}

	a := newConv()
	do(h, "POST", "/api/profiles/default/conversations/"+a+"/runs", `{"text":"帮我加入收藏夹","postIds":["q1"],"requestId":"ra"}`)
	snap := waitRun(t, h, a)
	if !exists(db, "SELECT 1 FROM profile_bookmarks WHERE profile_id=? AND post_id='q1'", defaultProfileID) {
		t.Fatal("引用作品未被收藏", snap["calls"])
	}
	if countImages() != 0 {
		t.Fatal("收藏不应看图")
	}

	b := newConv()
	do(h, "POST", "/api/profiles/default/conversations/"+b+"/runs", `{"text":"看看图里有什么","postIds":["q2"],"requestId":"rb"}`)
	snap = waitRun(t, h, b)
	if st := str(snap["runs"].([]any)[0].(map[string]any)["status"]); st != "completed" {
		t.Fatal("看图任务失败", snap["runs"])
	}
	mu.Lock()
	last := bodies[len(bodies)-1]
	mu.Unlock()
	var msgs struct{ Messages []M }
	_ = json.Unmarshal([]byte(last), &msgs)
	n := len(msgs.Messages)
	if n < 2 || str(msgs.Messages[n-2]["role"]) != "tool" || str(msgs.Messages[n-1]["role"]) != "user" || !strings.Contains(last, "data:image/webp;base64,") {
		var roles []string
		for _, m := range msgs.Messages {
			roles = append(roles, str(m["role"]))
		}
		t.Fatal("图片应作为 tool 结果之后的 user 消息发送", roles, strings.Contains(last, "data:image/"), snap["calls"])
	}

	// 用户附图发送：bind 曾在事务内经 a.db 查询，单连接下会死锁
	var buf bytes.Buffer
	_ = png.Encode(&buf, image.NewRGBA(image.Rect(0, 0, 4, 4)))
	var up struct{ Attachment M }
	_ = json.Unmarshal(do(h, "POST", "/api/profiles/default/chat/attachments", buf.String()).Body.Bytes(), &up)
	c := newConv()
	if w := do(h, "POST", "/api/profiles/default/conversations/"+c+"/runs", `{"text":"你好","attachmentIds":["`+str(up.Attachment["id"])+`"],"requestId":"rc"}`); w.Code != 201 {
		t.Fatal(w.Body.String())
	}
	waitRun(t, h, c)
	mu.Lock()
	last = bodies[len(bodies)-1]
	mu.Unlock()
	if !strings.Contains(last, "data:image/png;base64,") {
		t.Fatal("用户附图未发送给模型")
	}
}
