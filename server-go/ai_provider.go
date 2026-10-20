package main

import (
	"bufio"
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net/http"
	"sort"
	"strings"
	"time"
)

type ToolCall struct {
	ID       string   `json:"id"`
	Type     string   `json:"type"`
	Function ToolFunc `json:"function"`
}
type ToolFunc struct {
	Name      string `json:"name"`
	Arguments string `json:"arguments"`
}

type Block struct {
	Type         string `json:"type"`
	Text         string `json:"text,omitempty"`
	Key          string `json:"key,omitempty"`
	AttachmentID string `json:"attachmentId,omitempty"`
	CallID       string `json:"callId,omitempty"`
}

type ChatMessage struct {
	Role           string           `json:"role"`
	Content        string           `json:"content"`
	ToolCalls      []ToolCall       `json:"tool_calls,omitempty"`
	ToolCallID     string           `json:"tool_call_id,omitempty"`
	Blocks         []Block          `json:"blocks,omitempty"`
	Images         []string         `json:"images,omitempty"`
	ResponseOutput []map[string]any `json:"responseOutput,omitempty"`
	ResponseScope  string           `json:"responseScope,omitempty"`
}

type CompletionOptions struct {
	ReasoningEffort  string
	ReasoningSummary bool
	ForceTool        string
	OnReasoning      func(text, key string)
}

type ToolDefinition struct {
	Type     string  `json:"type"`
	Function ToolSpec `json:"function"`
}
type ToolSpec struct {
	Name        string `json:"name"`
	Description string `json:"description"`
	Parameters  M      `json:"parameters"`
}

type ProviderError struct {
	Status int
	Msg    string
}

func (e *ProviderError) Error() string { return e.Msg }

var providerClient = &http.Client{CheckRedirect: func(*http.Request, []*http.Request) error { return http.ErrUseLastResponse }}

func providerFetch(ctx context.Context, cfg *Provider, path string, body any) (*http.Response, error) {
	method := "GET"
	var rd io.Reader
	if body != nil {
		method = "POST"
		b, _ := json.Marshal(body)
		rd = bytes.NewReader(b)
	}
	req, err := http.NewRequestWithContext(ctx, method, cfg.BaseURL+path, rd)
	if err != nil {
		return nil, errors.New("无法连接供应商，请检查 API 地址及网络")
	}
	req.Header.Set("Content-Type", "application/json")
	if cfg.APIKey != "" {
		req.Header.Set("Authorization", "Bearer "+cfg.APIKey)
	}
	res, err := providerClient.Do(req)
	if err != nil {
		if ctx.Err() != nil {
			return nil, errors.New("请求已停止或超时")
		}
		return nil, errors.New("无法连接供应商，请检查 API 地址及网络")
	}
	if res.StatusCode >= 300 {
		res.Body.Close()
		msg := fmt.Sprintf("供应商请求失败 (HTTP %d)", res.StatusCode)
		switch res.StatusCode {
		case 401, 403:
			msg = "供应商鉴权失败，请检查密钥"
		case 400, 422:
			msg = fmt.Sprintf("供应商拒绝请求 (HTTP %d)，请检查模型是否支持所选推理档位、摘要、图片与工具", res.StatusCode)
		}
		return nil, &ProviderError{res.StatusCode, msg}
	}
	return res, nil
}

func discoverModels(ctx context.Context, cfg *Provider) ([]string, error) {
	ctx, cancel := context.WithTimeout(ctx, 15*time.Second)
	defer cancel()
	res, err := providerFetch(ctx, cfg, "/models", nil)
	if err != nil {
		return nil, err
	}
	defer res.Body.Close()
	var v struct {
		Data []struct {
			ID any `json:"id"`
		} `json:"data"`
	}
	if json.NewDecoder(io.LimitReader(res.Body, 8<<20)).Decode(&v) != nil || v.Data == nil {
		return nil, errors.New("供应商未返回有效模型列表")
	}
	seen := map[string]bool{}
	out := []string{}
	for _, d := range v.Data {
		id, ok := d.ID.(string)
		if ok && strings.TrimSpace(id) != "" && len(id) <= 200 && !seen[id] {
			seen[id] = true
			out = append(out, id)
		}
	}
	if len(out) > 5000 {
		out = out[:5000]
	}
	return out, nil
}

// readSSE 逐帧读取，fn 返回 stop=true 提前结束。超过 limit 字节报错。
func readSSE(body io.Reader, limit int, fn func(payload string) (bool, error)) error {
	sc := bufio.NewScanner(body)
	sc.Buffer(make([]byte, 64*1024), limit+1)
	size := 0
	var data []string
	flush := func() (bool, error) {
		if len(data) == 0 {
			return false, nil
		}
		p := strings.Join(data, "\n")
		data = nil
		return fn(p)
	}
	for sc.Scan() {
		line := strings.TrimRight(sc.Text(), "\r")
		size += len(line) + 1
		if size > limit {
			return errors.New("供应商响应超过限制")
		}
		if line == "" {
			if stop, err := flush(); err != nil || stop {
				return err
			}
			continue
		}
		if rest, ok := strings.CutPrefix(line, "data:"); ok {
			data = append(data, strings.TrimLeft(rest, " "))
		}
	}
	if err := sc.Err(); err != nil {
		if strings.Contains(err.Error(), "token too long") {
			return errors.New("供应商响应超过限制")
		}
		return err
	}
	_, err := flush()
	return err
}

func appendBlock(blocks []Block, typ, text, key string) []Block {
	if n := len(blocks); n > 0 && blocks[n-1].Type == typ && blocks[n-1].Key == key {
		blocks[n-1].Text += text
		return blocks
	}
	return append(blocks, Block{Type: typ, Text: text, Key: key})
}

func sub(m map[string]any, k string) map[string]any { v, _ := m[k].(map[string]any); return v }

func readCompletion(body io.Reader, onText func(text, key string), onReasoning func(text, key string)) (*ChatMessage, error) {
	var content string
	var blocks []Block
	finished := false
	calls := map[int]*ToolCall{}
	callBlockAdded := map[int]bool{}
	callBlockIdx := map[int]int{}
	err := readSSE(body, 1<<20, func(payload string) (bool, error) {
		if payload == "[DONE]" {
			finished = true
			return true, nil
		}
		var data map[string]any
		if json.Unmarshal([]byte(payload), &data) != nil {
			return false, errors.New("供应商流式响应格式无效")
		}
		if data["error"] != nil && data["error"] != false {
			return false, errors.New("供应商生成失败，请检查模型能力与上下文长度")
		}
		choices, _ := data["choices"].([]any)
		if len(choices) == 0 {
			return false, nil
		}
		choice, _ := choices[0].(map[string]any)
		fr := str(choice["finish_reason"])
		if fr == "length" || fr == "content_filter" {
			return false, errors.New("生成被截断或供应商过滤")
		}
		if fr != "" {
			finished = true
		}
		delta := sub(choice, "delta")
		thought, ok := delta["reasoning_content"].(string)
		if !ok {
			thought, ok = delta["reasoning"].(string)
		}
		if ok {
			blocks = appendBlock(blocks, "reasoning", thought, "")
			onReasoning(thought, "")
		}
		text, ok := delta["content"].(string)
		if !ok {
			text, ok = delta["refusal"].(string)
		}
		if ok {
			content += text
			blocks = appendBlock(blocks, "text", text, "")
			onText(text, "")
		}
		parts, _ := delta["tool_calls"].([]any)
		for _, pr := range parts {
			part, _ := pr.(map[string]any)
			idxF, isNum := part["index"].(float64)
			idx := int(idxF)
			if !isNum || idxF != float64(idx) || idx < 0 || idx > 15 {
				return false, errors.New("工具调用数量或索引无效")
			}
			c := calls[idx]
			if c == nil {
				c = &ToolCall{Type: "function"}
				calls[idx] = c
			}
			c.ID += str(part["id"])
			if fn := sub(part, "function"); fn != nil {
				c.Function.Name += str(fn["name"])
				c.Function.Arguments += str(fn["arguments"])
			}
			if !callBlockAdded[idx] {
				callBlockAdded[idx] = true
				blocks = append(blocks, Block{Type: "tool"})
				callBlockIdx[idx] = len(blocks) - 1
			}
			blocks[callBlockIdx[idx]].CallID = c.ID
		}
		return finished, nil
	})
	if err != nil {
		return nil, err
	}
	if !finished {
		return nil, errors.New("供应商响应中断，请重试")
	}
	idxs := make([]int, 0, len(calls))
	for i := range calls {
		idxs = append(idxs, i)
	}
	sort.Ints(idxs)
	var tcs []ToolCall
	ids := map[string]bool{}
	for _, i := range idxs {
		c := calls[i]
		if c.ID == "" || c.Function.Name == "" || ids[c.ID] {
			return nil, errors.New("供应商工具调用标识无效")
		}
		ids[c.ID] = true
		tcs = append(tcs, *c)
	}
	return &ChatMessage{Role: "assistant", Content: content, Blocks: blocks, ToolCalls: tcs}, nil
}

func completeOpenAI(ctx context.Context, cfg *Provider, model string, msgs []ChatMessage, tools []ToolDefinition, onText func(string, string), o CompletionOptions) (*ChatMessage, error) {
	ms := make([]M, 0, len(msgs))
	for _, m := range msgs {
		e := M{"role": m.Role}
		if len(m.Images) > 0 {
			parts := []any{M{"type": "text", "text": m.Content}}
			for _, u := range m.Images {
				parts = append(parts, M{"type": "image_url", "image_url": M{"url": u}})
			}
			e["content"] = parts
		} else {
			e["content"] = m.Content
		}
		if m.ToolCalls != nil {
			e["tool_calls"] = m.ToolCalls
		}
		if m.ToolCallID != "" {
			e["tool_call_id"] = m.ToolCallID
		}
		ms = append(ms, e)
	}
	body := M{"model": model, "messages": ms, "stream": true}
	if o.ReasoningEffort != "" {
		body["reasoning_effort"] = o.ReasoningEffort
	}
	if len(tools) > 0 {
		body["tools"] = tools
		if o.ForceTool != "" {
			body["tool_choice"] = M{"type": "function", "function": M{"name": o.ForceTool}}
		} else {
			body["tool_choice"] = "auto"
		}
	}
	res, err := providerFetch(ctx, cfg, "/chat/completions", body)
	if err != nil {
		return nil, err
	}
	defer res.Body.Close()
	return readCompletion(res.Body, onText, orNoop(o.OnReasoning))
}

func orNoop(f func(string, string)) func(string, string) {
	if f == nil {
		return func(string, string) {}
	}
	return f
}

func responseScope(cfg *Provider, model string) string {
	return fmt.Sprintf("%s:%d:%s:%s", cfg.ID, cfg.Version, cfg.Protocol, model)
}

func readResponses(body io.Reader, onText, onReasoning func(text, key string)) (*ChatMessage, error) {
	items := map[int]map[string]any{}
	var blocks []Block
	var output []map[string]any
	finished := false
	add := func(typ, text, key string) {
		blocks = appendBlock(blocks, typ, text, key)
		if typ == "text" {
			onText(text, key)
		} else {
			onReasoning(text, key)
		}
	}
	keyOf := func(e map[string]any, fallback, idxField string) string {
		first := e["item_id"]
		if first == nil {
			first = e["output_index"]
		}
		if first == nil {
			first = fallback
		}
		second := e[idxField]
		if second == nil {
			second = 0
		}
		return fmt.Sprintf("%s:%s", str(first), str(second))
	}
	err := readSSE(body, 4<<20, func(payload string) (bool, error) {
		if payload == "[DONE]" {
			return false, nil
		}
		var e map[string]any
		if json.Unmarshal([]byte(payload), &e) != nil {
			return false, errors.New("供应商流式响应格式无效")
		}
		typ := str(e["type"])
		if typ == "error" || typ == "response.failed" || typ == "response.incomplete" || (e["error"] != nil && e["error"] != false) {
			return false, errors.New("供应商生成失败或被截断，请检查推理档位、图片能力与上下文长度")
		}
		oi := int(num(e["output_index"]))
		switch typ {
		case "response.output_text.delta", "response.refusal.delta":
			add("text", str(e["delta"]), keyOf(e, "text", "content_index"))
		case "response.reasoning_summary_text.delta", "response.reasoning_text.delta":
			idxField := "summary_index"
			if e["summary_index"] == nil {
				idxField = "content_index"
			}
			add("reasoning", str(e["delta"]), keyOf(e, "reasoning", idxField))
		case "response.output_item.added", "response.output_item.done":
			if it, ok := e["item"].(map[string]any); ok {
				items[oi] = it
			}
		case "response.function_call_arguments.delta":
			if it := items[oi]; it != nil {
				it["arguments"] = str(it["arguments"]) + str(e["delta"])
			}
		case "response.function_call_arguments.done":
			if it := items[oi]; it != nil {
				it["arguments"] = str(e["arguments"])
			}
		case "response.completed":
			resp := sub(e, "response")
			if s := str(resp["status"]); s != "" && s != "completed" {
				return false, errors.New("供应商生成未完成")
			}
			if out, ok := resp["output"].([]any); ok {
				for _, o := range out {
					if m, ok := o.(map[string]any); ok {
						output = append(output, m)
					}
				}
			} else {
				keys := make([]int, 0, len(items))
				for k := range items {
					keys = append(keys, k)
				}
				sort.Ints(keys)
				for _, k := range keys {
					output = append(output, items[k])
				}
			}
			finished = true
			return true, nil
		}
		return false, nil
	})
	if err != nil {
		return nil, err
	}
	if !finished {
		return nil, errors.New("供应商响应中断，请重试")
	}
	var final []Block
	var calls []ToolCall
	for index, item := range output {
		switch str(item["type"]) {
		case "reasoning":
			if sum, _ := item["summary"].([]any); len(sum) > 0 {
				for _, s := range sum {
					if sm, ok := s.(map[string]any); ok {
						final = append(final, Block{Type: "reasoning", Text: str(sm["text"])})
					}
				}
			} else {
				id := item["id"]
				if id == nil {
					id = index
				}
				for _, b := range blocks {
					if b.Type == "reasoning" && strings.HasPrefix(b.Key, str(id)+":") {
						final = append(final, b)
					}
				}
			}
		case "message":
			cs, _ := item["content"].([]any)
			for _, c := range cs {
				cm, _ := c.(map[string]any)
				t := str(cm["text"])
				if cm["text"] == nil {
					t = str(cm["refusal"])
				}
				if t != "" {
					final = append(final, Block{Type: "text", Text: t})
				}
			}
		case "function_call":
			args, isStr := item["arguments"].(string)
			if str(item["call_id"]) == "" || str(item["name"]) == "" || !isStr {
				return nil, errors.New("供应商工具调用无效")
			}
			calls = append(calls, ToolCall{ID: str(item["call_id"]), Type: "function", Function: ToolFunc{Name: str(item["name"]), Arguments: args}})
			final = append(final, Block{Type: "tool", CallID: str(item["call_id"])})
		}
	}
	ids := map[string]bool{}
	for _, c := range calls {
		ids[c.ID] = true
	}
	if len(calls) > 16 || len(ids) != len(calls) {
		return nil, errors.New("供应商工具调用标识无效")
	}
	visible := final
	if len(visible) == 0 {
		visible = blocks
	}
	hasReasoning := false
	for _, b := range visible {
		if b.Type == "reasoning" {
			hasReasoning = true
		}
	}
	if !hasReasoning {
		var rs []Block
		for _, b := range blocks {
			if b.Type == "reasoning" {
				rs = append(rs, b)
			}
		}
		visible = append(rs, visible...)
	}
	var text strings.Builder
	for _, b := range visible {
		if b.Type == "text" {
			text.WriteString(b.Text)
		}
	}
	return &ChatMessage{Role: "assistant", Content: text.String(), Blocks: visible, ResponseOutput: output, ToolCalls: calls}, nil
}

func completeResponses(ctx context.Context, cfg *Provider, model string, msgs []ChatMessage, tools []ToolDefinition, onText func(string, string), o CompletionOptions) (*ChatMessage, error) {
	scope := responseScope(cfg, model)
	input := []any{}
	for _, m := range msgs {
		if m.ResponseOutput != nil && m.ResponseScope == scope {
			for _, it := range m.ResponseOutput {
				input = append(input, it)
			}
			continue
		}
		if m.Role == "tool" {
			input = append(input, M{"type": "function_call_output", "call_id": m.ToolCallID, "output": m.Content})
			continue
		}
		if m.Content != "" || len(m.Images) > 0 {
			var content any = m.Content
			if m.Role != "assistant" {
				parts := []any{M{"type": "input_text", "text": m.Content}}
				for _, u := range m.Images {
					parts = append(parts, M{"type": "input_image", "image_url": u, "detail": "auto"})
				}
				content = parts
			}
			input = append(input, M{"role": m.Role, "content": content})
		}
		for _, c := range m.ToolCalls {
			input = append(input, M{"type": "function_call", "call_id": c.ID, "name": c.Function.Name, "arguments": c.Function.Arguments})
		}
	}
	body := M{"model": model, "input": input, "stream": true, "store": false, "include": []string{"reasoning.encrypted_content"}}
	if o.ReasoningEffort != "" || o.ReasoningSummary {
		r := M{}
		if o.ReasoningEffort != "" {
			r["effort"] = o.ReasoningEffort
		}
		if o.ReasoningSummary {
			r["summary"] = "auto"
		}
		body["reasoning"] = r
	}
	if len(tools) > 0 {
		ts := make([]M, 0, len(tools))
		for _, t := range tools {
			ts = append(ts, M{"type": "function", "name": t.Function.Name, "description": t.Function.Description, "parameters": t.Function.Parameters, "strict": false})
		}
		body["tools"] = ts
		if o.ForceTool != "" {
			body["tool_choice"] = M{"type": "function", "name": o.ForceTool}
		} else {
			body["tool_choice"] = "auto"
		}
	}
	res, err := providerFetch(ctx, cfg, "/responses", body)
	if err != nil {
		return nil, err
	}
	defer res.Body.Close()
	reply, err := readResponses(res.Body, onText, orNoop(o.OnReasoning))
	if err != nil {
		return nil, err
	}
	reply.ResponseScope = scope
	return reply, nil
}

func completeWith(ctx context.Context, cfg *Provider, model string, msgs []ChatMessage, tools []ToolDefinition, onText func(string, string), o CompletionOptions) (*ChatMessage, error) {
	if cfg.Protocol == "openai-responses" {
		return completeResponses(ctx, cfg, model, msgs, tools, onText, o)
	}
	return completeOpenAI(ctx, cfg, model, msgs, tools, onText, o)
}
