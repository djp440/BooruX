package main

import (
	"database/sql"
	"errors"
	"strings"
	"unicode/utf8"
)

const (
	memoryDefaultLimit = 1000
	memoryMinLimit     = 200
	memoryMaxLimit     = 10000
)

var errMemoryNotFound = errors.New("记忆不存在")
var errMemoryFull = errors.New("记忆总字数已达上限，需先合并或遗忘旧条目")

func initMemoryTable(db *sql.DB) error {
	_, err := db.Exec(`CREATE TABLE IF NOT EXISTS ai_memories (
      id TEXT PRIMARY KEY, profileId TEXT NOT NULL REFERENCES profiles(id) ON DELETE CASCADE,
      text TEXT NOT NULL, source TEXT NOT NULL, createdAt TEXT NOT NULL, updatedAt TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS ai_memories_profile ON ai_memories(profileId,createdAt);`)
	return err
}

// memoryConfig 返回开关（默认开）与总字数上限（默认 1000）。
func memoryConfig(q querier, pid string) (bool, int) {
	st := getProfileSettings(q, pid)
	limit := memoryDefaultLimit
	if f, ok := st["aiMemoryLimit"].(float64); ok {
		limit = int(f)
	}
	return st["aiMemoryEnabled"] != false, limit
}

func memoryList(q querier, pid string) []M {
	rows, _ := queryMaps(q, "SELECT id,text,source,createdAt,updatedAt FROM ai_memories WHERE profileId=? ORDER BY createdAt,rowid", pid)
	if rows == nil {
		return []M{}
	}
	return rows
}

func memoryUsed(q querier, pid, exceptID string) int {
	n := 0
	for _, m := range memoryList(q, pid) {
		if str(m["id"]) != exceptID {
			n += utf8.RuneCountInString(str(m["text"]))
		}
	}
	return n
}

// memorySave 新增（id 为空）或更新一条记忆，校验非空与总字数上限。
func memorySave(db *sql.DB, pid, id, text, source string) (string, error) {
	text = strings.Join(strings.Fields(text), " ") // 折叠换行，避免伪造多行指令
	if text == "" {
		return "", errors.New("记忆内容不能为空")
	}
	_, limit := memoryConfig(db, pid)
	if memoryUsed(db, pid, id)+utf8.RuneCountInString(text) > limit {
		return "", errMemoryFull
	}
	now := nowISO()
	if id == "" {
		id = newUUID()
		_, err := db.Exec("INSERT INTO ai_memories(id,profileId,text,source,createdAt,updatedAt) VALUES(?,?,?,?,?,?)", id, pid, text, source, now, now)
		return id, err
	}
	r, err := db.Exec("UPDATE ai_memories SET text=?,updatedAt=? WHERE id=? AND profileId=?", text, now, id, pid)
	if err == nil {
		if n, _ := r.RowsAffected(); n == 0 {
			err = errMemoryNotFound
		}
	}
	return id, err
}

func memoryDelete(db *sql.DB, pid, id string) error {
	r, err := db.Exec("DELETE FROM ai_memories WHERE id=? AND profileId=?", id, pid)
	if err == nil {
		if n, _ := r.RowsAffected(); n == 0 {
			err = errMemoryNotFound
		}
	}
	return err
}

// executeMemoryTool 执行记忆工具；关闭记忆时拒绝。
func executeMemoryTool(db *sql.DB, pid, name string, args M) (M, error) {
	if on, _ := memoryConfig(db, pid); !on {
		return nil, errors.New("记忆功能已关闭")
	}
	var id string
	var err error
	switch name {
	case "save_memory":
		id, err = memorySave(db, pid, "", str(args["text"]), "assistant")
	case "update_memory":
		id, err = memorySave(db, pid, str(args["id"]), str(args["text"]), "assistant")
	default:
		id = str(args["id"])
		err = memoryDelete(db, pid, id)
	}
	if err != nil {
		return nil, err
	}
	return M{"id": id, "ok": true}, nil
}

// memoryPrompt 渲染注入系统提示的记忆列表；关闭或为空时返回空串。
func memoryPrompt(q querier, pid string) string {
	if on, _ := memoryConfig(q, pid); !on {
		return ""
	}
	var b strings.Builder
	for _, m := range memoryList(q, pid) {
		b.WriteString("- " + str(m["text"]) + "\n")
	}
	return strings.TrimSpace(b.String())
}
