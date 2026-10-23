package main

import (
	"bytes"
	"encoding/json"
	"fmt"
	"image"
	"image/png"
	"io"
	"net/http"
	"net/http/httptest"
	"strings"
	"sync"
	"testing"
)

// 假供应商：消息含「找猫」时先调用 search_posts；最终回复为「回复N」（N 为请求序号），便于区分重新生成前后。
func newSessionEnv(t *testing.T) (http.Handler, func() string, *[]string, *sync.Mutex, func(q string, args ...any)) {
	var bodies []string
	var mu sync.Mutex
	fake := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		b, _ := io.ReadAll(r.Body)
		mu.Lock()
		bodies = append(bodies, string(b))
		n := len(bodies)
		mu.Unlock()
		w.Header().Set("Content-Type", "text/event-stream")
		frames := []string{fmt.Sprintf(`{"choices":[{"delta":{"content":"回复%d"}}]}`, n), `{"choices":[{"delta":{},"finish_reason":"stop"}]}`}
		if strings.Contains(string(b), "找猫") && !strings.Contains(string(b), `"role":"tool"`) {
			frames = []string{`{"choices":[{"delta":{"tool_calls":[{"index":0,"id":"c1","function":{"name":"search_posts","arguments":"{\"tags\":\"cat\"}"}}]}}]}`,
				`{"choices":[{"delta":{},"finish_reason":"tool_calls"}]}`}
		}
		for _, f := range append(frames, "[DONE]") {
			_, _ = io.WriteString(w, "data: "+f+"\n\n")
		}
	}))
	t.Cleanup(fake.Close)
	db, err := initDatabase(":memory:")
	if err != nil {
		t.Fatal(err)
	}
	h := withMiddleware((&server{db: db, media: newMediaCache(db, t.TempDir())}).routes())
	if _, err := setProfileSettings(db, defaultProfileID, M{"dataSource": "sqlite"}); err != nil {
		t.Fatal(err)
	}
	if _, err := db.Exec(`INSERT INTO ai_providers(id,name,baseUrl,apiKey) VALUES('p','P',?,''); INSERT INTO ai_models(providerId,id,name,manual) VALUES('p','m','m',1),('p','m2','m2',1);
      INSERT INTO posts(id,title,artist,image_url,preview_url,rating,created_at) VALUES('q1','t','a','http://x/i.jpg','http://x/p.jpg','general','2026-01-01')`, fake.URL+"/v1"); err != nil {
		t.Fatal(err)
	}
	do(h, "PUT", "/api/profiles/default/chat", `{"providerId":"p","modelId":"m"}`)
	newConv := func() string {
		var out struct{ Conversation M }
		_ = json.Unmarshal(do(h, "POST", "/api/profiles/default/conversations", "").Body.Bytes(), &out)
		return str(out.Conversation["id"])
	}
	exec := func(q string, args ...any) {
		if _, err := db.Exec(q, args...); err != nil {
			t.Fatal(err)
		}
	}
	return h, newConv, &bodies, &mu, exec
}

const convsURL = "/api/profiles/default/conversations/"

func runIDs(snap M) []string {
	var ids []string
	for _, r := range snap["runs"].([]any) {
		ids = append(ids, str(r.(map[string]any)["id"]))
	}
	return ids
}

func send(t *testing.T, h http.Handler, cid, body string) M {
	t.Helper()
	if w := do(h, "POST", convsURL+cid+"/runs", body); w.Code != 201 {
		t.Fatal(w.Body.String())
	}
	return waitRun(t, h, cid)
}

func TestRegenerateAndEditLastRun(t *testing.T) {
	h, newConv, bodies, mu, exec := newSessionEnv(t)
	cid := newConv()
	snap := send(t, h, cid, `{"text":"帮我找猫","requestId":"r1"}`)
	if len(snap["calls"].([]any)) != 1 || !strings.Contains(fmt.Sprint(snap["messages"]), "回复2") {
		t.Fatal("初始对话不符合预期", snap["messages"])
	}
	first := runIDs(snap)[0]

	// 重新生成：旧回复被丢弃，工具调用重新执行，使用当前选中的模型与推理强度
	do(h, "PUT", "/api/profiles/default/chat", `{"providerId":"p","modelId":"m2","reasoningEffort":"high"}`)
	if w := do(h, "POST", convsURL+cid+"/runs/"+first+"/retry", ""); w.Code != 200 {
		t.Fatal(w.Body.String())
	}
	snap = waitRun(t, h, cid)
	msgs := fmt.Sprint(snap["messages"])
	if strings.Contains(msgs, "回复2") || !strings.Contains(msgs, "回复4") || len(snap["calls"].([]any)) != 1 {
		t.Fatal("重新生成未替换旧回复", msgs)
	}
	run := snap["runs"].([]any)[0].(map[string]any)
	if str(run["modelId"]) != "m2" || str(run["reasoningEffort"]) != "high" || str(run["status"]) != "completed" {
		t.Fatal("重新生成应使用当前模型与强度", run)
	}
	mu.Lock()
	last := (*bodies)[len(*bodies)-1]
	mu.Unlock()
	if !strings.Contains(last, `"model":"m2"`) {
		t.Fatal("请求未使用新模型", last)
	}

	// 只能重试最后一轮
	snap = send(t, h, cid, `{"text":"你好","requestId":"r2"}`)
	if w := do(h, "POST", convsURL+cid+"/runs/"+first+"/retry", ""); w.Code != 409 {
		t.Fatal("非最后一轮应拒绝", w.Code)
	}

	// 编辑重发：带引用的最后一轮改写文字，引用后缀保留
	c2 := newConv()
	snap = send(t, h, c2, `{"text":"你好","postIds":["q1"],"requestId":"r3"}`)
	id2 := runIDs(snap)[0]
	if w := do(h, "POST", convsURL+c2+"/runs/"+id2+"/retry", `{"text":"换个说法"}`); w.Code != 200 {
		t.Fatal(w.Body.String())
	}
	snap = waitRun(t, h, c2)
	mu.Lock()
	last = (*bodies)[len(*bodies)-1]
	mu.Unlock()
	if !strings.Contains(last, "换个说法") || !strings.Contains(last, "引用作品：q1") || strings.Contains(last, "你好") {
		t.Fatal("编辑后模型收到的内容不对", last)
	}
	if !strings.Contains(fmt.Sprint(snap["messages"]), "换个说法") {
		t.Fatal("消息未更新", snap["messages"])
	}

	// 没有任何内容可发送时拒绝，且原消息不变
	c3 := newConv()
	snap = send(t, h, c3, `{"text":"原文","requestId":"r4"}`)
	id3 := runIDs(snap)[0]
	if w := do(h, "POST", convsURL+c3+"/runs/"+id3+"/retry", `{"text":"  "}`); w.Code != 409 {
		t.Fatal("空内容应拒绝", w.Code)
	}
	if !strings.Contains(fmt.Sprint(waitRun(t, h, c3)["messages"]), "原文") {
		t.Fatal("拒绝后原消息应保留")
	}

	// 失败的轮次仍按原机制重试（不重置）
	exec("UPDATE ai_runs SET status='failed' WHERE id=?", id3)
	if w := do(h, "POST", convsURL+c3+"/runs/"+id3+"/retry", ""); w.Code != 200 {
		t.Fatal(w.Body.String())
	}
	waitRun(t, h, c3)
}

func TestForkAndExport(t *testing.T) {
	h, newConv, _, _, exec := newSessionEnv(t)
	cid := newConv()
	var buf bytes.Buffer
	_ = png.Encode(&buf, image.NewRGBA(image.Rect(0, 0, 4, 4)))
	var up struct{ Attachment M }
	_ = json.Unmarshal(do(h, "POST", "/api/profiles/default/chat/attachments", buf.String()).Body.Bytes(), &up)
	oldImg := str(up.Attachment["id"])
	send(t, h, cid, `{"text":"帮我找猫","attachmentIds":["`+oldImg+`"],"requestId":"r1"}`)
	snap := send(t, h, cid, `{"text":"再来一句","requestId":"r2"}`)
	ids := runIDs(snap)

	fork := func(body string) (int, M) {
		w := do(h, "POST", convsURL+cid+"/fork", body)
		var out struct{ Conversation M }
		_ = json.Unmarshal(w.Body.Bytes(), &out)
		return w.Code, out.Conversation
	}
	snapOf := func(id string) M {
		var s M
		_ = json.Unmarshal(do(h, "GET", convsURL+id, "").Body.Bytes(), &s)
		return s
	}

	// 从第一轮分支：只含第一轮，原会话不变
	code, branch := fork(`{"runId":"` + ids[0] + `"}`)
	if code != 201 || !strings.HasSuffix(str(branch["title"]), "（分支）") {
		t.Fatal("分支失败", code, branch)
	}
	bs := snapOf(str(branch["id"]))
	if len(bs["runs"].([]any)) != 1 || len(bs["calls"].([]any)) != 1 || len(snapOf(cid)["runs"].([]any)) != 2 {
		t.Fatal("分支内容不对", bs["runs"], bs["calls"])
	}
	if bs["runs"].([]any)[0].(map[string]any)["id"] == ids[0] {
		t.Fatal("分支应使用新的 run id")
	}
	// 图片被复制为新附件，新旧都能读取
	var newImg string
	for _, m := range bs["messages"].([]any) {
		for _, b := range m.(map[string]any)["blocks"].([]any) {
			if bm := b.(map[string]any); bm["type"] == "image" {
				newImg = str(bm["attachmentId"])
			}
		}
	}
	if newImg == "" || newImg == oldImg {
		t.Fatal("分支应复制图片附件", newImg)
	}
	if do(h, "GET", "/api/profiles/default/chat/attachments/"+newImg, "").Code != 200 || do(h, "GET", "/api/profiles/default/chat/attachments/"+oldImg, "").Code != 200 {
		t.Fatal("新旧附件都应可读取")
	}
	// 分支后可继续对话
	send(t, h, str(branch["id"]), `{"text":"接着聊","requestId":"r3"}`)

	// 整段复制
	code, copyConv := fork(``)
	if code != 201 || !strings.HasSuffix(str(copyConv["title"]), "（副本）") || len(snapOf(str(copyConv["id"]))["runs"].([]any)) != 2 {
		t.Fatal("复制会话失败", code, copyConv)
	}

	// 失败的轮次不被复制，也不能作为分支点；未知 run 报错
	exec("UPDATE ai_runs SET status='failed' WHERE id=?", ids[1])
	if code, c := fork(``); code != 201 || len(snapOf(str(c["id"]))["runs"].([]any)) != 1 {
		t.Fatal("应跳过失败的轮次", code)
	}
	if code, _ := fork(`{"runId":"` + ids[1] + `"}`); code != 409 {
		t.Fatal("对未完成的轮次分支应拒绝", code)
	}
	if code, _ := fork(`{"runId":"nope"}`); code != 409 {
		t.Fatal("未知轮次应拒绝", code)
	}
	// 其他会话路径访问不到
	if w := do(h, "POST", convsURL+"missing/fork", ""); w.Code != 404 {
		t.Fatal(w.Code)
	}

	// 删除分支不影响原会话的图片
	if w := do(h, "DELETE", convsURL+str(branch["id"]), ""); w.Code != 200 {
		t.Fatal(w.Body.String())
	}
	if do(h, "GET", "/api/profiles/default/chat/attachments/"+oldImg, "").Code != 200 {
		t.Fatal("删除分支不应删除原会话的图片")
	}

	// 导出
	w := do(h, "GET", convsURL+cid+"/export", "")
	body := w.Body.String()
	if w.Code != 200 || !strings.HasPrefix(w.Header().Get("Content-Type"), "text/markdown") || !strings.Contains(w.Header().Get("Content-Disposition"), "filename*=UTF-8''") ||
		!strings.Contains(body, "## 用户") || !strings.Contains(body, "帮我找猫") || !strings.Contains(body, "（图片）") || !strings.Contains(body, "## 助手") {
		t.Fatal("导出内容不对", w.Header(), body)
	}
	if exportName(`a/b:c*?"<>|`) != "a_b_c______" || exportName("  ") != "对话" {
		t.Fatal("文件名清理", exportName(`a/b:c*?"<>|`))
	}
}
