package main

import (
	"encoding/json"
	"fmt"
	"os"
	"path/filepath"
	"strings"
	"sync"
	"time"
)

var (
	logMu      sync.Mutex
	logFile    string
	logRootDir = "."
)

func formatDateTime(t time.Time) string { return t.Format("2006-01-02 15:04:05") }

func formatLogFileName(t time.Time) string {
	return strings.ReplaceAll(formatDateTime(t), ":", "-") + ".log"
}

// getOrCreateLogFilePath 一次启动复用同一日志文件 logs/yyyy-MM-dd HH-mm-ss.log。
func getOrCreateLogFilePath() string {
	if logFile != "" {
		if _, err := os.Stat(logFile); err == nil {
			return logFile
		}
	}
	dir := filepath.Join(logRootDir, "logs")
	_ = os.MkdirAll(dir, 0o755)
	name := formatLogFileName(time.Now())
	logFile = filepath.Join(dir, name)
	if _, err := os.Stat(logFile); err != nil {
		msg := fmt.Sprintf("[%s] [SYSTEM] TikBooru Go Backend logging session started. Log file: %s\n", formatDateTime(time.Now()), name)
		_ = os.WriteFile(logFile, []byte(msg), 0o644)
	}
	return logFile
}

func logPath() string {
	logMu.Lock()
	defer logMu.Unlock()
	return getOrCreateLogFilePath()
}

// appendServerLog 追加一行 `[ISO] [LEVEL] [tag] msg | meta`。
func appendServerLog(level, tag, message string, meta ...any) {
	logMu.Lock()
	defer logMu.Unlock()
	path := getOrCreateLogFilePath()
	line := fmt.Sprintf("[%s] [%s] [%s] %s", time.Now().UTC().Format("2006-01-02T15:04:05.000Z"), strings.ToUpper(level), tag, message)
	if len(meta) > 0 && meta[0] != nil {
		switch v := meta[0].(type) {
		case error:
			line += " | " + v.Error()
		case string:
			line += " | " + v
		default:
			b, _ := json.Marshal(v)
			line += " | " + string(b)
		}
	}
	f, err := os.OpenFile(path, os.O_APPEND|os.O_WRONLY|os.O_CREATE, 0o644)
	if err != nil {
		fmt.Fprintln(os.Stderr, "Failed to append backend log:", err)
		return
	}
	defer f.Close()
	_, _ = f.WriteString(line + "\n")
}
