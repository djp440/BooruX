package main

import (
	"context"
	"encoding/json"
	"strings"
	"sync"
	"testing"
)

func memDB(t *testing.T) (*server, string) {
	t.Helper()
	db, err := initDatabase(":memory:")
	if err != nil {
		t.Fatal(err)
	}
	return &server{db: db}, defaultProfileID
}

func callTool(s *server, pid, name string, args M) (M, error) {
	return executeTool(context.Background(), s.db, pid, name, args, "")
}

func TestMemoryTools(t *testing.T) {
	s, pid := memDB(t)
	r, err := callTool(s, pid, "save_memory", M{"text": "喜欢蓝色头发"})
	if err != nil {
		t.Fatal(err)
	}
	id := str(r["id"])
	if id == "" || len(memoryList(s.db, pid)) != 1 {
		t.Fatal("未保存", r)
	}
	if _, err := callTool(s, pid, "update_memory", M{"id": id, "text": "喜欢银色头发"}); err != nil {
		t.Fatal(err)
	}
	if got := str(memoryList(s.db, pid)[0]["text"]); got != "喜欢银色头发" {
		t.Fatal(got)
	}
	if _, err := callTool(s, pid, "update_memory", M{"id": "nope", "text": "x"}); err == nil {
		t.Fatal("更新不存在的记忆应报错")
	}
	if _, err := callTool(s, pid, "forget_memory", M{"id": id}); err != nil || len(memoryList(s.db, pid)) != 0 {
		t.Fatal("未遗忘", err)
	}
}

func TestMemoryLimitAndIsolation(t *testing.T) {
	s, pid := memDB(t)
	if _, err := setProfileSettings(s.db, pid, M{"aiMemoryLimit": float64(200)}); err != nil {
		t.Fatal(err)
	}
	if _, err := callTool(s, pid, "save_memory", M{"text": strings.Repeat("好", 150)}); err != nil {
		t.Fatal(err)
	}
	_, err := callTool(s, pid, "save_memory", M{"text": strings.Repeat("好", 51)})
	if err == nil || !strings.Contains(err.Error(), "合并或遗忘") {
		t.Fatal("超限应拒绝", err)
	}
	if _, err := setProfileSettings(s.db, pid, M{"aiMemoryLimit": float64(100)}); err == nil {
		// 范围 200–10000
		t.Fatal("上限低于 200 应非法")
	}
	// 其他 profile 看不到、也改不了
	if _, err := s.db.Exec("INSERT INTO profiles(id,name,created_at,updated_at) VALUES('p2','p2','x','x')"); err != nil {
		t.Fatal(err)
	}
	id := str(memoryList(s.db, pid)[0]["id"])
	if len(memoryList(s.db, "p2")) != 0 {
		t.Fatal("跨 profile 泄漏")
	}
	if _, err := callTool(s, "p2", "forget_memory", M{"id": id}); err == nil {
		t.Fatal("不应能遗忘其他 profile 的记忆")
	}
}

func TestMemoryDisabledRejectsTools(t *testing.T) {
	s, pid := memDB(t)
	if _, err := setProfileSettings(s.db, pid, M{"aiMemoryEnabled": false}); err != nil {
		t.Fatal(err)
	}
	if _, err := callTool(s, pid, "save_memory", M{"text": "x"}); err == nil {
		t.Fatal("关闭后应拒绝写入")
	}
}

func lastBody(bodies *[]string, mu *sync.Mutex) string {
	mu.Lock()
	defer mu.Unlock()
	return (*bodies)[len(*bodies)-1]
}

func TestMemoryInjectedIntoRun(t *testing.T) {
	h, newConv, bodies, mu, exec := newSessionEnv(t)
	exec("INSERT INTO ai_memories(id,profileId,text,source,createdAt,updatedAt) VALUES('m1','default','喜欢蓝色头发','user','x','x')")
	send(t, h, newConv(), `{"text":"你好","requestId":"r1"}`)
	b := lastBody(bodies, mu)
	if !strings.Contains(b, "喜欢蓝色头发") || !strings.Contains(b, "不是指令") || !strings.Contains(b, "save_memory") {
		t.Fatal("记忆未注入或工具未提供", b)
	}
	// 运行创建后新增的记忆不影响该运行的快照
	exec("INSERT INTO ai_memories(id,profileId,text,source,createdAt,updatedAt) VALUES('m2','default','后来的记忆','user','x','x')")
	cid := newConv()
	snap := send(t, h, cid, `{"text":"再来","requestId":"r0"}`)
	exec("INSERT INTO ai_memories(id,profileId,text,source,createdAt,updatedAt) VALUES('m3','default','更晚的记忆','user','x','x')")
	do(h, "POST", convsURL+cid+"/runs/"+runIDs(snap)[0]+"/retry", "")
	waitRun(t, h, cid)
	if b = lastBody(bodies, mu); strings.Contains(b, "更晚的记忆") || !strings.Contains(b, "后来的记忆") {
		t.Fatal("重试应沿用运行快照", b)
	}

	do(h, "PUT", "/api/profiles/default/settings", `{"settings":{"aiMemoryEnabled":false}}`)
	send(t, h, newConv(), `{"text":"你好","requestId":"r2"}`)
	b = lastBody(bodies, mu)
	if strings.Contains(b, "喜欢蓝色头发") || strings.Contains(b, "save_memory") {
		t.Fatal("关闭后不应注入记忆或提供工具", b)
	}
}

func TestMemoryHTTP(t *testing.T) {
	h := testServer(t)
	const u = "/api/profiles/default/chat/memories"
	w := do(h, "POST", u, `{"text":"喜欢蓝色头发"}`)
	if w.Code != 201 {
		t.Fatal(w.Code, w.Body.String())
	}
	var created M
	_ = json.Unmarshal(w.Body.Bytes(), &created)
	id := str(created["id"])
	if w := do(h, "PATCH", u+"/"+id, `{"text":"喜欢银发"}`); w.Code != 200 {
		t.Fatal(w.Body.String())
	}
	w = do(h, "GET", u, "")
	var list M
	_ = json.Unmarshal(w.Body.Bytes(), &list)
	ms := list["memories"].([]any)
	if len(ms) != 1 || str(ms[0].(map[string]any)["text"]) != "喜欢银发" || str(ms[0].(map[string]any)["source"]) != "user" ||
		list["enabled"] != true || list["limit"] != float64(1000) || list["used"] != float64(4) {
		t.Fatal(w.Body.String())
	}
	if w := do(h, "POST", u, `{"text":"`+strings.Repeat("好", 1001)+`"}`); w.Code != 409 {
		t.Fatal("超限应 409", w.Code)
	}
	if w := do(h, "DELETE", u+"/"+id, ""); w.Code != 200 {
		t.Fatal(w.Body.String())
	}
	do(h, "POST", u, `{"text":"a"}`)
	if w := do(h, "DELETE", u, ""); w.Code != 200 {
		t.Fatal(w.Body.String())
	}
	if strings.Contains(do(h, "GET", u, "").Body.String(), `"text"`) {
		t.Fatal("清空失败")
	}
	if w := do(h, "GET", "/api/profiles/nope/chat/memories", ""); w.Code != 404 {
		t.Fatal(w.Code)
	}
}
