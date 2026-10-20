package main

import (
	"crypto/rand"
	"database/sql"
	"encoding/base64"
	"encoding/json"
	"fmt"
	"math/big"
	"net/http"
	"net/url"
	"strings"
)

type querier interface {
	Exec(query string, args ...any) (sql.Result, error)
	Query(query string, args ...any) (*sql.Rows, error)
	QueryRow(query string, args ...any) *sql.Row
}

type M = map[string]any

// queryMaps 读取所有行为 map，BLOB 转 string。
func queryMaps(q querier, query string, args ...any) ([]M, error) {
	rows, err := q.Query(query, args...)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	cols, _ := rows.Columns()
	out := []M{}
	for rows.Next() {
		vals := make([]any, len(cols))
		ptrs := make([]any, len(cols))
		for i := range vals {
			ptrs[i] = &vals[i]
		}
		if err := rows.Scan(ptrs...); err != nil {
			return nil, err
		}
		m := M{}
		for i, c := range cols {
			if b, ok := vals[i].([]byte); ok {
				m[c] = string(b)
			} else {
				m[c] = vals[i]
			}
		}
		out = append(out, m)
	}
	return out, rows.Err()
}

func queryMap(q querier, query string, args ...any) (M, error) {
	rows, err := queryMaps(q, query, args...)
	if err != nil || len(rows) == 0 {
		return nil, err
	}
	return rows[0], nil
}

func exists(q querier, query string, args ...any) bool {
	var one int
	return q.QueryRow(query, args...).Scan(&one) == nil
}

func str(v any) string {
	switch t := v.(type) {
	case nil:
		return ""
	case string:
		return t
	case float64:
		if t == float64(int64(t)) {
			return fmt.Sprintf("%d", int64(t))
		}
		return fmt.Sprint(t)
	}
	return fmt.Sprint(v)
}

func num(v any) float64 {
	switch t := v.(type) {
	case float64:
		return t
	case int64:
		return float64(t)
	case int:
		return float64(t)
	case string:
		var f float64
		if _, err := fmt.Sscan(strings.TrimSpace(t), &f); err == nil {
			return f
		}
	case bool:
		if t {
			return 1
		}
	}
	return 0
}

func randBase36(n int) string {
	const chars = "0123456789abcdefghijklmnopqrstuvwxyz"
	b := make([]byte, n)
	for i := range b {
		x, _ := rand.Int(rand.Reader, big.NewInt(int64(len(chars))))
		b[i] = chars[x.Int64()]
	}
	return string(b)
}

func writeJSON(w http.ResponseWriter, status int, v any) {
	w.Header().Set("Content-Type", "application/json; charset=utf-8")
	w.WriteHeader(status)
	_ = json.NewEncoder(w).Encode(v)
}

func errJSON(w http.ResponseWriter, status int, msg string) {
	writeJSON(w, status, M{"success": false, "error": msg})
}

// readBody 解析 JSON 对象；空/非对象返回空 map。
func readBody(r *http.Request) M {
	m := M{}
	if r.Body == nil {
		return m
	}
	_ = json.NewDecoder(r.Body).Decode(&m)
	if m == nil {
		m = M{}
	}
	return m
}

func urlPathEscape(s string) string { return url.PathEscape(s) }

// 游标为 base64url("createdAt|id")，对客户端不透明。
func encodeCursor(createdAt, id string) string {
	return base64.RawURLEncoding.EncodeToString([]byte(createdAt + "|" + id))
}

func decodeCursor(c string) (createdAt, id string, ok bool) {
	b, err := base64.RawURLEncoding.DecodeString(c)
	if err != nil {
		return "", "", false
	}
	createdAt, id, ok = strings.Cut(string(b), "|")
	return createdAt, id, ok && id != ""
}

// nullableStr 空值写入 SQL NULL。
func nullableStr(v any) any {
	if s := str(v); s != "" {
		return s
	}
	return nil
}

func boolInt(b bool) int {
	if b {
		return 1
	}
	return 0
}
