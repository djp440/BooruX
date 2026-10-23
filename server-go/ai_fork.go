package main

import (
	"database/sql"
	"encoding/json"
	"errors"
	"os"
	"strings"
)

type copiedAttachment struct {
	newID, runID string
	src          *Attachment
}

// fork 把会话（截止到 upToRunID，空则整段）复制成新会话。只复制已完成的轮次，不复制事件。
// 图片附件复制为新文件，两个会话互不影响。
func (rt *AiRuntime) fork(profileID, srcID, upToRunID string) (M, error) {
	rt.mu.Lock()
	clearing := rt.clearing[srcID]
	rt.mu.Unlock()
	if clearing {
		return nil, errors.New("会话正在删除")
	}
	src, err := rt.getConversation(profileID, srcID)
	if err != nil {
		return nil, err
	}
	runs, _ := queryMaps(rt.db, "SELECT * FROM ai_runs WHERE conversationId=? AND profileId=? ORDER BY rowid", srcID, profileID)
	var picked []M
	found := upToRunID == ""
	for _, r := range runs {
		done := str(r["status"]) == "completed"
		if done {
			picked = append(picked, r)
		}
		if upToRunID != "" && str(r["id"]) == upToRunID {
			if !done {
				return nil, errors.New("只能从已完成的一轮分支")
			}
			found = true
			break
		}
	}
	if !found {
		return nil, errors.New("任务不存在")
	}
	if len(picked) == 0 {
		return nil, errors.New("没有可复制的已完成对话")
	}

	convID := newUUID()
	type runCopy struct {
		run      M
		id       string
		messages []ChatMessage
		calls    []M
	}
	var copies []runCopy
	var files []copiedAttachment
	created := []string{} // 已写入磁盘的新附件文件，事务失败时清理
	cleanup := func() {
		for _, id := range created {
			if p, err := rt.attachments.file(id); err == nil {
				os.Remove(p)
			}
		}
	}
	for _, r := range picked {
		rc := runCopy{run: r, id: newUUID()}
		rows, _ := queryMaps(rt.db, "SELECT payload FROM ai_messages WHERE runId=? AND status='completed' ORDER BY id", r["id"])
		for _, row := range rows {
			var m ChatMessage
			if json.Unmarshal([]byte(str(row["payload"])), &m) != nil {
				continue
			}
			var blocks []Block
			for _, b := range m.Blocks {
				if b.Type == "image" && b.AttachmentID != "" {
					a, err := rt.attachments.get(profileID, b.AttachmentID)
					if err != nil {
						continue // 附件已丢失，丢弃这个图片块
					}
					data, err := os.ReadFile(mustFile(rt.attachments, a.ID))
					if err != nil {
						continue
					}
					newID := newUUID()
					if err := os.WriteFile(mustFile(rt.attachments, newID), data, 0o644); err != nil {
						cleanup()
						return nil, err
					}
					created = append(created, newID)
					files = append(files, copiedAttachment{newID: newID, runID: rc.id, src: a})
					b.AttachmentID = newID
				}
				blocks = append(blocks, b)
			}
			m.Blocks = blocks
			rc.messages = append(rc.messages, m)
		}
		rc.calls, _ = queryMaps(rt.db, "SELECT callId,name,arguments,result,status FROM ai_calls WHERE runId=? ORDER BY id", r["id"])
		copies = append(copies, rc)
	}

	title, suffix := []rune(strings.TrimSpace(str(src["title"]))), "（副本）"
	if upToRunID != "" {
		suffix = "（分支）"
	}
	if len(title) == 0 {
		title = []rune("对话")
	}
	if len(title) > 90 {
		title = title[:90]
	}
	now := nowISO()
	err = withTx(rt.db, func(tx *sql.Tx) error {
		if _, err := tx.Exec("INSERT INTO ai_conversations(id,profileId,title,createdAt,updatedAt) VALUES(?,?,?,?,?)", convID, profileID, string(title)+suffix, now, now); err != nil {
			return err
		}
		for _, rc := range copies {
			r := rc.run
			if _, err := tx.Exec(`INSERT INTO ai_runs(id,profileId,conversationId,requestId,status,providerId,modelId,providerName,modelName,reasoningEffort,protocol,configVersion,reasoningSummary,systemPrompt,omitted,createdAt)
        VALUES(?,?,?,?,'completed',?,?,?,?,?,?,?,?,?,?,?)`, rc.id, profileID, convID, newUUID(), r["providerId"], r["modelId"], r["providerName"], r["modelName"],
				r["reasoningEffort"], r["protocol"], r["configVersion"], r["reasoningSummary"], r["systemPrompt"], r["omitted"], r["createdAt"]); err != nil {
				return err
			}
			for _, m := range rc.messages {
				if addMessage(tx, profileID, rc.id, m, "completed") == 0 {
					return errors.New("复制消息失败")
				}
			}
			for _, c := range rc.calls {
				if _, err := tx.Exec("INSERT INTO ai_calls(runId,callId,name,arguments,result,status) VALUES(?,?,?,?,?,?)",
					rc.id, c["callId"], c["name"], c["arguments"], c["result"], c["status"]); err != nil {
					return err
				}
			}
		}
		for _, f := range files {
			if _, err := tx.Exec("INSERT INTO ai_attachments(id,profileId,runId,mime,size,width,height,createdAt) VALUES(?,?,?,?,?,?,?,?)",
				f.newID, profileID, f.runID, f.src.Mime, f.src.Size, f.src.Width, f.src.Height, f.src.CreatedAt); err != nil {
				return err
			}
		}
		return nil
	})
	if err != nil {
		cleanup()
		return nil, err
	}
	return rt.getConversation(profileID, convID)
}

// mustFile 附件 id 均由 newUUID 或数据库产生，file 不会失败。
func mustFile(a *Attachments, id string) string {
	p, _ := a.file(id)
	return p
}

// exportMarkdown 把会话导出为可读的 Markdown：用户与助手的文字、图片与引用作品占位；省略推理与工具调用。
func (rt *AiRuntime) exportMarkdown(profileID, conversationID string) (title, md string) {
	conv, _ := rt.getConversation(profileID, conversationID)
	title = strings.TrimSpace(str(conv["title"]))
	if title == "" {
		title = "对话"
	}
	var sb strings.Builder
	sb.WriteString("# " + title + "\n")
	rows, _ := queryMaps(rt.db, "SELECT m.payload FROM ai_messages m JOIN ai_runs r ON r.id=m.runId WHERE r.conversationId=? AND m.status='completed' ORDER BY m.id", conversationID)
	for _, row := range rows {
		var m ChatMessage
		if json.Unmarshal([]byte(str(row["payload"])), &m) != nil || (m.Role != "user" && m.Role != "assistant") {
			continue
		}
		var parts []string
		for _, b := range m.Blocks {
			switch b.Type {
			case "text":
				if strings.TrimSpace(b.Text) != "" {
					parts = append(parts, b.Text)
				}
			case "image":
				parts = append(parts, "（图片）")
			case "post":
				parts = append(parts, "引用作品："+b.Key)
			}
		}
		if len(m.Blocks) == 0 && strings.TrimSpace(m.Content) != "" {
			parts = append(parts, m.Content)
		}
		if len(parts) == 0 {
			continue
		}
		heading := "用户"
		if m.Role == "assistant" {
			heading = "助手"
		}
		sb.WriteString("\n## " + heading + "\n\n" + strings.Join(parts, "\n\n") + "\n")
	}
	return title, sb.String()
}

// exportName 去掉文件名中的路径与特殊字符，并限制长度。
func exportName(title string) string {
	r := strings.Map(func(c rune) rune {
		if c < 0x20 || strings.ContainsRune(`\/:*?"<>|`, c) {
			return '_'
		}
		return c
	}, title)
	r = strings.TrimSpace(r)
	if rs := []rune(r); len(rs) > 60 {
		r = string(rs[:60])
	}
	if r == "" {
		return "对话"
	}
	return r
}
