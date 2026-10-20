package main

import (
	"context"
	"database/sql"
	"encoding/json"
	"io"
	"net/http"
	"slices"
	"strconv"
	"strings"
	"time"
)

func jerr(w http.ResponseWriter, code int, msg string) { writeJSON(w, code, M{"error": msg}) }

func (s *server) refreshModels(ctx context.Context, cfg *Provider) {
	ids, err := discoverModels(ctx, cfg)
	if err != nil {
		_, _ = s.db.Exec("UPDATE ai_providers SET discoveryError=? WHERE id=? AND version=?", err.Error(), cfg.ID, cfg.Version)
		return
	}
	_ = withTx(s.db, func(tx *sql.Tx) error {
		var v int
		if tx.QueryRow("SELECT version FROM ai_providers WHERE id=?", cfg.ID).Scan(&v) != nil || v != cfg.Version {
			return nil
		}
		if _, err := tx.Exec("UPDATE ai_models SET available=0 WHERE providerId=? AND manual=0", cfg.ID); err != nil {
			return err
		}
		for _, id := range ids {
			if _, err := tx.Exec(`INSERT INTO ai_models(providerId,id,name) VALUES(?,?,?)
        ON CONFLICT(providerId,id) DO UPDATE SET available=1`, cfg.ID, id, id); err != nil {
				return err
			}
		}
		_, err := tx.Exec("UPDATE ai_providers SET discoveryError=NULL WHERE id=?", cfg.ID)
		return err
	})
}

func (s *server) providerPayload(id string) M {
	p, _ := getProvider(s.db, id)
	return M{"provider": publicProvider(p), "models": listModels(s.db, id)}
}

func (s *server) aiRoutes(mux *http.ServeMux) {
	mux.HandleFunc("GET /api/ai/providers", func(w http.ResponseWriter, r *http.Request) {
		out := []M{}
		for _, p := range listProviders(s.db) {
			pp := publicProvider(p)
			pp["models"] = listModels(s.db, p.ID)
			out = append(out, pp)
		}
		writeJSON(w, 200, M{"providers": out})
	})
	mux.HandleFunc("POST /api/ai/providers", func(w http.ResponseWriter, r *http.Request) {
		saved, err := saveProvider(s.db, readBody(r), "")
		if err != nil {
			jerr(w, 400, "供应商配置无效")
			return
		}
		s.refreshModels(r.Context(), saved)
		writeJSON(w, 201, s.providerPayload(saved.ID))
	})
	mux.HandleFunc("PUT /api/ai/providers/{id}", func(w http.ResponseWriter, r *http.Request) {
		prev, err := getProvider(s.db, r.PathValue("id"))
		if err != nil {
			jerr(w, 400, "供应商配置无效或不存在")
			return
		}
		saved, err := saveProvider(s.db, readBody(r), prev.ID)
		if err != nil {
			jerr(w, 400, "供应商配置无效或不存在")
			return
		}
		if prev.BaseURL != saved.BaseURL || prev.APIKey != saved.APIKey || prev.Protocol != saved.Protocol {
			s.refreshModels(r.Context(), saved)
		}
		writeJSON(w, 200, s.providerPayload(saved.ID))
	})
	mux.HandleFunc("DELETE /api/ai/providers/{id}", func(w http.ResponseWriter, r *http.Request) {
		_, _ = s.db.Exec("DELETE FROM ai_providers WHERE id=?", r.PathValue("id"))
		writeJSON(w, 200, M{"success": true})
	})
	mux.HandleFunc("POST /api/ai/providers/{id}/models/refresh", func(w http.ResponseWriter, r *http.Request) {
		p, err := getProvider(s.db, r.PathValue("id"))
		if err != nil {
			jerr(w, 404, "供应商不存在")
			return
		}
		s.refreshModels(r.Context(), p)
		writeJSON(w, 200, s.providerPayload(p.ID))
	})
	mux.HandleFunc("PUT /api/ai/providers/{id}/models", func(w http.ResponseWriter, r *http.Request) {
		pid := r.PathValue("id")
		bad := func() { jerr(w, 400, "模型配置无效") }
		if _, err := getProvider(s.db, pid); err != nil {
			bad()
			return
		}
		b := readBody(r)
		id, ok := b["id"].(string)
		if !ok || strings.TrimSpace(id) == "" || utf16Len(id) > 200 {
			bad()
			return
		}
		var name *string
		if v, has := b["name"]; has && v != nil {
			n, isStr := v.(string)
			if !isStr || strings.TrimSpace(n) == "" || utf16Len(n) > 200 {
				bad()
				return
			}
			name = &n
		}
		caps := []string{"unknown", "supported", "unsupported"}
		var chat, tools *string
		for i, k := range []string{"chat", "tools"} {
			if v, has := b[k]; has && v != nil {
				c, isStr := v.(string)
				if !isStr || !slices.Contains(caps, c) {
					bad()
					return
				}
				if i == 0 {
					chat = &c
				} else {
					tools = &c
				}
			}
		}
		var summary *bool
		if v, has := b["reasoningSummary"]; has && v != nil {
			bv, isBool := v.(bool)
			if !isBool {
				bad()
				return
			}
			summary = &bv
		}
		def := func(p *string, d string) string {
			if p == nil || *p == "" {
				return d
			}
			return *p
		}
		nm := id
		if name != nil && *name != "" {
			nm = *name
		}
		arg := func(p *string) any {
			if p == nil {
				return nil
			}
			return *p
		}
		_, err := s.db.Exec(`INSERT INTO ai_models(providerId,id,name,manual,chat,tools) VALUES(?,?,?,1,?,?)
      ON CONFLICT(providerId,id) DO UPDATE SET name=COALESCE(?,name),chat=COALESCE(?,chat),tools=COALESCE(?,tools)`,
			pid, id, nm, def(chat, "unknown"), def(tools, "unknown"), arg(name), arg(chat), arg(tools))
		if err != nil {
			bad()
			return
		}
		if summary != nil {
			n := 0
			if *summary {
				n = 1
			}
			_, _ = s.db.Exec("UPDATE ai_models SET reasoningSummary=? WHERE providerId=? AND id=?", n, pid, id)
		}
		writeJSON(w, 200, M{"models": listModels(s.db, pid)})
	})
	mux.HandleFunc("DELETE /api/ai/providers/{id}/models/{modelId}", func(w http.ResponseWriter, r *http.Request) {
		_, _ = s.db.Exec("DELETE FROM ai_models WHERE providerId=? AND id=?", r.PathValue("id"), r.PathValue("modelId"))
		writeJSON(w, 200, M{"success": true})
	})
	mux.HandleFunc("POST /api/ai/providers/{id}/models/verify", s.verifyModel)

	s.chatRoutes(mux)
}

func (s *server) verifyModel(w http.ResponseWriter, r *http.Request) {
	b := readBody(r)
	id, ok := b["id"].(string)
	capab, _ := b["capability"].(string)
	if !ok || (capab != "chat" && capab != "tools") {
		jerr(w, 400, "请选择模型与验证能力")
		return
	}
	cfg, err := getProvider(s.db, r.PathValue("id"))
	if err != nil {
		jerr(w, 502, err.Error())
		return
	}
	orig := findModel(s.db, cfg.ID, id)
	if orig == nil {
		jerr(w, 404, "模型不存在")
		return
	}
	probe := toolDef("capability_probe", "无副作用能力测试，返回 ok。", M{"value": M{"type": "string", "enum": []string{"ok"}}}, "value")
	probe.Function.Parameters["additionalProperties"] = false
	opts := CompletionOptions{ReasoningSummary: orig.ReasoningSummary != 0}
	text := "Reply with ok."
	var tools []ToolDefinition
	if capab == "tools" {
		text, tools, opts.ForceTool = "Call capability_probe with value ok.", []ToolDefinition{probe}, "capability_probe"
	}
	ctx, cancel := context.WithTimeout(r.Context(), 30*time.Second)
	defer cancel()
	reply, err := completeWith(ctx, cfg, id, []ChatMessage{{Role: "user", Content: text}}, tools, func(string, string) {}, opts)
	if err != nil {
		jerr(w, 502, err.Error())
		return
	}
	supported := false
	if capab == "chat" {
		supported = strings.TrimSpace(reply.Content) != ""
	} else {
		for _, c := range reply.ToolCalls {
			var a struct{ Value string }
			if c.Function.Name == "capability_probe" && json.Unmarshal([]byte(c.Function.Arguments), &a) == nil && a.Value == "ok" {
				supported = true
			}
		}
	}
	value := "unknown"
	if supported {
		value = "supported"
	}
	if cur, err := getProvider(s.db, cfg.ID); err == nil && cur.Version == cfg.Version {
		old := orig.Chat
		if capab == "tools" {
			old = orig.Tools
		}
		// capab 仅为 chat/tools，安全拼接列名
		_, _ = s.db.Exec("UPDATE ai_models SET "+capab+"=? WHERE providerId=? AND id=? AND "+capab+"=?", value, cfg.ID, id, old)
	}
	out := M{"capability": capab, "value": value}
	if !supported {
		out["error"] = "供应商未完成能力测试，状态仍为未验证"
	}
	writeJSON(w, 200, out)
}

func (s *server) chatRoutes(mux *http.ServeMux) {
	rt := newAiRuntime(s.db, s.media)
	go rt.attachments.cleanup()
	go func() {
		for range time.Tick(time.Hour) {
			rt.attachments.cleanup()
		}
	}()
	chat := func(fn func(w http.ResponseWriter, r *http.Request, pid string)) http.HandlerFunc {
		return func(w http.ResponseWriter, r *http.Request) {
			pid := r.PathValue("profileId")
			if p, _ := getProfileByID(s.db, pid); p == nil {
				jerr(w, 404, "配置不存在")
				return
			}
			fn(w, r, pid)
		}
	}
	run := func(fn func(w http.ResponseWriter, r *http.Request, pid, id string)) http.HandlerFunc {
		return chat(func(w http.ResponseWriter, r *http.Request, pid string) {
			id := r.PathValue("id")
			if _, err := rt.getRun(pid, id); err != nil {
				jerr(w, 404, "任务不存在")
				return
			}
			fn(w, r, pid, id)
		})
	}
	const base = "/api/profiles/{profileId}/chat"

	mux.HandleFunc("GET "+base, chat(func(w http.ResponseWriter, r *http.Request, pid string) { writeJSON(w, 200, rt.chat(pid)) }))
	mux.HandleFunc("POST "+base+"/attachments", chat(func(w http.ResponseWriter, r *http.Request, pid string) {
		b, err := io.ReadAll(http.MaxBytesReader(w, r.Body, 10<<20+1))
		if err != nil {
			jerr(w, 400, "单张图片必须小于 10 MiB")
			return
		}
		a, err := rt.attachments.upload(pid, b)
		if err != nil {
			jerr(w, 400, err.Error())
			return
		}
		writeJSON(w, 201, M{"attachment": a})
	}))
	mux.HandleFunc("GET "+base+"/attachments/{id}", chat(func(w http.ResponseWriter, r *http.Request, pid string) {
		a, err := rt.attachments.get(pid, r.PathValue("id"))
		if err != nil {
			jerr(w, 404, "附件不存在")
			return
		}
		p, _ := rt.attachments.file(a.ID)
		w.Header().Set("Content-Type", a.Mime)
		w.Header().Set("Cache-Control", "private, no-store")
		w.Header().Set("X-Content-Type-Options", "nosniff")
		http.ServeFile(w, r, p)
	}))
	mux.HandleFunc("DELETE "+base+"/attachments/{id}", chat(func(w http.ResponseWriter, r *http.Request, pid string) {
		if err := rt.attachments.remove(pid, r.PathValue("id"), false); err != nil {
			jerr(w, 400, err.Error())
			return
		}
		writeJSON(w, 200, M{"success": true})
	}))
	mux.HandleFunc("PUT "+base, chat(func(w http.ResponseWriter, r *http.Request, pid string) {
		b := readBody(r)
		var effort *string
		if v, ok := b["reasoningEffort"]; ok && v != nil {
			e := str(v)
			effort = &e
		}
		if err := rt.selectModel(pid, str(b["providerId"]), str(b["modelId"]), effort); err != nil {
			jerr(w, 400, err.Error())
			return
		}
		writeJSON(w, 200, rt.chat(pid))
	}))
	mux.HandleFunc("DELETE "+base, chat(func(w http.ResponseWriter, r *http.Request, pid string) {
		if err := rt.clear(pid); err != nil {
			jerr(w, 409, err.Error())
			return
		}
		writeJSON(w, 200, M{"success": true})
	}))
	mux.HandleFunc("POST "+base+"/runs", chat(func(w http.ResponseWriter, r *http.Request, pid string) {
		b := readBody(r)
		var ids []string
		if arr, ok := b["attachmentIds"].([]any); ok {
			for _, x := range arr {
				sx, isStr := x.(string)
				if !isStr {
					jerr(w, 409, "每条消息最多 4 张图片，不能重复")
					return
				}
				ids = append(ids, sx)
			}
		}
		text, _ := b["text"].(string)
		if b["text"] != nil && text == "" {
			if _, isStr := b["text"].(string); !isStr {
				jerr(w, 409, "消息或请求标识无效")
				return
			}
		}
		reqID, _ := b["requestId"].(string)
		run, err := rt.create(pid, reqID, text, ids)
		if err != nil {
			jerr(w, 409, err.Error())
			return
		}
		writeJSON(w, 201, M{"run": run})
	}))
	mux.HandleFunc("GET "+base+"/runs/{id}/events", run(func(w http.ResponseWriter, r *http.Request, pid, id string) {
		after, err := strconv.ParseInt(orDefault(r.URL.Query().Get("after"), "0"), 10, 64)
		if err != nil || after < 0 {
			jerr(w, 409, "无法订阅此任务")
			return
		}
		if err := rt.attach(w, r, pid, id, after); err != nil {
			jerr(w, 409, "无法订阅此任务")
		}
	}))
	mux.HandleFunc("POST "+base+"/runs/{id}/cancel", run(func(w http.ResponseWriter, r *http.Request, pid, id string) {
		rt.cancel(pid, id, "已停止")
		writeJSON(w, 200, M{"success": true})
	}))
	mux.HandleFunc("POST "+base+"/runs/{id}/retry", run(func(w http.ResponseWriter, r *http.Request, pid, id string) {
		out, err := rt.retry(pid, id)
		if err != nil {
			jerr(w, 409, err.Error())
			return
		}
		writeJSON(w, 200, M{"run": out})
	}))
}
