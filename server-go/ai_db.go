package main

import (
	"crypto/rand"
	"database/sql"
	"errors"
	"fmt"
	"net/url"
	"slices"
	"strings"
)

var reasoningEfforts = []string{"", "none", "minimal", "low", "medium", "high", "xhigh", "max"}

type Provider struct {
	ID, Name, BaseURL, APIKey string
	Version                   int
	Protocol                  string
	DiscoveryError            *string
}

type Model struct {
	ProviderID string `json:"providerId"`
	ID         string `json:"id"`
	Name       string `json:"name"`
	Manual     int    `json:"manual"`
	Available  int    `json:"available"`
	Chat       string `json:"chat"`
	Tools      string `json:"tools"`
	// 摘要开关，JSON 输出为 0/1 与原实现一致
	ReasoningSummary int `json:"reasoningSummary"`
}

func newUUID() string {
	b := make([]byte, 16)
	_, _ = rand.Read(b)
	b[6] = b[6]&0x0f | 0x40
	b[8] = b[8]&0x3f | 0x80
	return fmt.Sprintf("%x-%x-%x-%x-%x", b[0:4], b[4:6], b[6:8], b[8:10], b[10:])
}

func initAiTables(db *sql.DB) error {
	_, err := db.Exec(`
    CREATE TABLE IF NOT EXISTS ai_providers (
      id TEXT PRIMARY KEY, name TEXT NOT NULL, baseUrl TEXT NOT NULL, apiKey TEXT NOT NULL,
      version INTEGER NOT NULL DEFAULT 1, protocol TEXT NOT NULL DEFAULT 'openai', discoveryError TEXT
    );
    CREATE TABLE IF NOT EXISTS ai_models (
      providerId TEXT NOT NULL REFERENCES ai_providers(id) ON DELETE CASCADE,
      id TEXT NOT NULL, name TEXT NOT NULL, manual INTEGER NOT NULL DEFAULT 0,
      available INTEGER NOT NULL DEFAULT 1, chat TEXT NOT NULL DEFAULT 'unknown',
      tools TEXT NOT NULL DEFAULT 'unknown', PRIMARY KEY(providerId,id)
    );
    CREATE TABLE IF NOT EXISTS ai_conversations (
      id TEXT PRIMARY KEY, profileId TEXT NOT NULL REFERENCES profiles(id) ON DELETE CASCADE,
      title TEXT NOT NULL DEFAULT '', createdAt TEXT NOT NULL, updatedAt TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS ai_conversations_profile ON ai_conversations(profileId,updatedAt);
    CREATE TABLE IF NOT EXISTS ai_chats (
      profileId TEXT PRIMARY KEY REFERENCES profiles(id) ON DELETE CASCADE,
      providerId TEXT, modelId TEXT
    );
    CREATE TABLE IF NOT EXISTS ai_runs (
      id TEXT PRIMARY KEY, profileId TEXT NOT NULL REFERENCES profiles(id) ON DELETE CASCADE,
      requestId TEXT NOT NULL, status TEXT NOT NULL, providerId TEXT NOT NULL, modelId TEXT NOT NULL,
      providerName TEXT NOT NULL, modelName TEXT NOT NULL, error TEXT, omitted INTEGER NOT NULL DEFAULT 0,
      createdAt TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP, UNIQUE(profileId,requestId)
    );
    CREATE TABLE IF NOT EXISTS ai_messages (
      id INTEGER PRIMARY KEY AUTOINCREMENT, profileId TEXT NOT NULL REFERENCES profiles(id) ON DELETE CASCADE,
      runId TEXT NOT NULL REFERENCES ai_runs(id) ON DELETE CASCADE,
      payload TEXT NOT NULL, status TEXT NOT NULL DEFAULT 'completed'
    );
    CREATE INDEX IF NOT EXISTS ai_messages_profile ON ai_messages(profileId,id);
    CREATE TABLE IF NOT EXISTS ai_calls (
      id INTEGER PRIMARY KEY AUTOINCREMENT, runId TEXT NOT NULL REFERENCES ai_runs(id) ON DELETE CASCADE,
      callId TEXT NOT NULL, name TEXT NOT NULL, arguments TEXT NOT NULL, result TEXT,
      status TEXT NOT NULL, UNIQUE(runId,callId)
    );
    CREATE TABLE IF NOT EXISTS ai_events (
      id INTEGER PRIMARY KEY AUTOINCREMENT, runId TEXT NOT NULL REFERENCES ai_runs(id) ON DELETE CASCADE,
      type TEXT NOT NULL, data TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS ai_attachments (
      id TEXT PRIMARY KEY, profileId TEXT NOT NULL REFERENCES profiles(id) ON DELETE CASCADE,
      runId TEXT REFERENCES ai_runs(id) ON DELETE SET NULL, mime TEXT NOT NULL,
      size INTEGER NOT NULL, width INTEGER NOT NULL, height INTEGER NOT NULL,
      createdAt INTEGER NOT NULL
    );`)
	if err != nil {
		return err
	}
	migrate := func(table, column, def string) {
		rows, _ := queryMaps(db, "PRAGMA table_info("+table+")")
		for _, r := range rows {
			if str(r["name"]) == column {
				return
			}
		}
		_, _ = db.Exec("ALTER TABLE " + table + " ADD COLUMN " + column + " " + def)
	}
	if err := initMemoryTable(db); err != nil {
		return err
	}
	migrate("ai_models", "reasoningSummary", "INTEGER NOT NULL DEFAULT 1")
	migrate("ai_chats", "reasoningEffort", "TEXT NOT NULL DEFAULT ''")
	migrate("ai_runs", "reasoningEffort", "TEXT NOT NULL DEFAULT ''")
	migrate("ai_runs", "attempt", "INTEGER NOT NULL DEFAULT 1")
	migrate("ai_runs", "configVersion", "INTEGER NOT NULL DEFAULT 0")
	migrate("ai_runs", "protocol", "TEXT NOT NULL DEFAULT 'openai'")
	migrate("ai_runs", "reasoningSummary", "INTEGER NOT NULL DEFAULT 1")
	migrate("ai_runs", "systemPrompt", "TEXT NOT NULL DEFAULT ''")
	migrate("ai_runs", "contextUsed", "INTEGER NOT NULL DEFAULT 0")
	migrate("ai_runs", "contextLimit", "INTEGER NOT NULL DEFAULT 0")
	migrate("ai_runs", "memory", "TEXT NOT NULL DEFAULT ''")
	migrate("ai_events", "attempt", "INTEGER NOT NULL DEFAULT 1")
	migrate("ai_runs", "conversationId", "TEXT REFERENCES ai_conversations(id) ON DELETE CASCADE")
	if err := migrateConversations(db); err != nil {
		return err
	}
	_, err = db.Exec("UPDATE ai_runs SET status='interrupted',error='服务重启，任务已中断' WHERE status IN ('pending','running')")
	return err
}

// migrateConversations 把引入多会话前的对话归入每个 profile 的「此前的对话」，
// 并把“同时只有一个运行中任务”的约束从 profile 改为会话。
func migrateConversations(db *sql.DB) error {
	rows, err := queryMaps(db, "SELECT DISTINCT profileId FROM ai_runs WHERE conversationId IS NULL")
	if err != nil {
		return err
	}
	for _, r := range rows {
		id, now := newUUID(), nowISO()
		if _, err := db.Exec("INSERT INTO ai_conversations(id,profileId,title,createdAt,updatedAt) VALUES(?,?,?,?,?)", id, r["profileId"], "此前的对话", now, now); err != nil {
			return err
		}
		if _, err := db.Exec("UPDATE ai_runs SET conversationId=? WHERE profileId=? AND conversationId IS NULL", id, r["profileId"]); err != nil {
			return err
		}
	}
	_, err = db.Exec(`DROP INDEX IF EXISTS ai_one_active_run;
    CREATE UNIQUE INDEX IF NOT EXISTS ai_one_active_run_conversation ON ai_runs(conversationId) WHERE status IN ('pending','running');`)
	return err
}

func scanProvider(row interface{ Scan(...any) error }) (*Provider, error) {
	p := &Provider{}
	err := row.Scan(&p.ID, &p.Name, &p.BaseURL, &p.APIKey, &p.Version, &p.Protocol, &p.DiscoveryError)
	return p, err
}

const providerCols = "id,name,baseUrl,apiKey,version,protocol,discoveryError"

func listProviders(db querier) []*Provider {
	rows, err := db.Query("SELECT " + providerCols + " FROM ai_providers ORDER BY rowid")
	if err != nil {
		return nil
	}
	defer rows.Close()
	var out []*Provider
	for rows.Next() {
		if p, err := scanProvider(rows); err == nil {
			out = append(out, p)
		}
	}
	return out
}

func getProvider(db querier, id string) (*Provider, error) {
	p, err := scanProvider(db.QueryRow("SELECT "+providerCols+" FROM ai_providers WHERE id=?", id))
	if err != nil {
		return nil, errors.New("供应商不存在")
	}
	return p, nil
}

func publicProvider(p *Provider) M {
	return M{"id": p.ID, "name": p.Name, "baseUrl": p.BaseURL, "version": p.Version, "protocol": p.Protocol,
		"discoveryError": p.DiscoveryError, "hasKey": p.APIKey != ""}
}

func listModels(db querier, providerID string) []Model {
	rows, err := db.Query("SELECT providerId,id,name,manual,available,chat,tools,reasoningSummary FROM ai_models WHERE providerId=? ORDER BY name", providerID)
	out := []Model{}
	if err != nil {
		return out
	}
	defer rows.Close()
	for rows.Next() {
		var m Model
		if rows.Scan(&m.ProviderID, &m.ID, &m.Name, &m.Manual, &m.Available, &m.Chat, &m.Tools, &m.ReasoningSummary) == nil {
			out = append(out, m)
		}
	}
	return out
}

func findModel(db querier, providerID, id string) *Model {
	for _, m := range listModels(db, providerID) {
		if m.ID == id {
			c := m
			return &c
		}
	}
	return nil
}

// saveProvider 创建或更新；id 为空则新建。
func saveProvider(db *sql.DB, input M, id string) (*Provider, error) {
	var existing *Provider
	if id != "" {
		existing, _ = getProvider(db, id)
	} else {
		id = newUUID()
	}
	pick := func(key, old string) string {
		if v, ok := input[key]; ok && v != nil {
			return str(v)
		}
		return old
	}
	var oldName, oldURL, oldKey, oldProto string = "", "", "", "openai"
	if existing != nil {
		oldName, oldURL, oldKey, oldProto = existing.Name, existing.BaseURL, existing.APIKey, existing.Protocol
	}
	name := strings.TrimSpace(pick("name", oldName))
	baseURL := strings.TrimRight(pick("baseUrl", oldURL), "/")
	u, err := url.Parse(baseURL)
	if err != nil || (u.Scheme != "http" && u.Scheme != "https") || u.Host == "" || u.User != nil || u.RawQuery != "" || u.Fragment != "" || strings.Contains(baseURL, "#") || strings.Contains(baseURL, "?") {
		return nil, errors.New("API 地址必须为不含凭据及查询参数的 HTTP(S) 地址")
	}
	if name == "" || utf16Len(name) > 100 || len(baseURL) > 2000 {
		return nil, errors.New("供应商名称或地址无效")
	}
	protocol := pick("protocol", oldProto)
	if protocol != "openai" && protocol != "openai-responses" {
		return nil, errors.New("协议无效")
	}
	apiKey := oldKey
	if v, ok := input["apiKey"]; ok && v != nil {
		s, isStr := v.(string)
		if !isStr {
			return nil, errors.New("密钥格式无效")
		}
		apiKey = s
	}
	if input["clearKey"] == true {
		apiKey = ""
	}
	err = withTx(db, func(tx *sql.Tx) error {
		if _, err := tx.Exec(`INSERT INTO ai_providers(id,name,baseUrl,apiKey,protocol) VALUES(?,?,?,?,?)
      ON CONFLICT(id) DO UPDATE SET name=excluded.name,baseUrl=excluded.baseUrl,apiKey=excluded.apiKey,protocol=excluded.protocol,version=version+1`,
			id, name, baseURL, apiKey, protocol); err != nil {
			return err
		}
		if existing != nil && existing.Protocol != protocol {
			_, err := tx.Exec("UPDATE ai_models SET chat='unknown',tools='unknown' WHERE providerId=?", id)
			return err
		}
		return nil
	})
	if err != nil {
		return nil, err
	}
	return getProvider(db, id)
}

func validEffort(e string) bool { return slices.Contains(reasoningEfforts, e) }
