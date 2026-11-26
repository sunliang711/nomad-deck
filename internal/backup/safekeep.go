package backup

import (
	"context"
	"crypto/tls"
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"net/url"
	"os"
	"path"
	"sort"
	"strings"
	"time"
)

type safekeepStore struct {
	target Target
	client *http.Client
}

func newSafeKeepStore(t Target) *safekeepStore {
	tr := &http.Transport{
		Proxy:               http.ProxyFromEnvironment,
		TLSHandshakeTimeout: 10 * time.Second,
	}
	if t.SafeKeepInsecureTLS {
		tr.TLSClientConfig = &tls.Config{InsecureSkipVerify: true} // #nosec G402 -- explicit user setting for internal self-signed SafeKeep instances
	}
	return &safekeepStore{
		target: t,
		client: &http.Client{Transport: tr, Timeout: 10 * time.Minute},
	}
}

func (s *safekeepStore) do(ctx context.Context, method, reqPath string, body io.Reader, headers map[string]string, size int64) (*http.Response, error) {
	req, err := http.NewRequestWithContext(ctx, method, s.target.SafeKeepURL+reqPath, body)
	if err != nil {
		return nil, err
	}
	if size >= 0 {
		req.ContentLength = size
	}
	req.Header.Set("X-API-Key", s.target.SafeKeepAPIKey)
	for k, v := range headers {
		if v != "" {
			req.Header.Set(k, v)
		}
	}
	return s.client.Do(req)
}

func readSafeKeepError(resp *http.Response) error {
	raw, _ := io.ReadAll(io.LimitReader(resp.Body, 1<<20))
	var er struct {
		Error struct {
			Code    string `json:"code"`
			Message string `json:"message"`
		} `json:"error"`
	}
	if json.Unmarshal(raw, &er) == nil && er.Error.Message != "" {
		return fmt.Errorf("SafeKeep HTTP %d (%s): %s", resp.StatusCode, er.Error.Code, er.Error.Message)
	}
	msg := strings.TrimSpace(string(raw))
	if msg == "" {
		return fmt.Errorf("SafeKeep HTTP %d", resp.StatusCode)
	}
	return fmt.Errorf("SafeKeep HTTP %d: %s", resp.StatusCode, msg)
}

func (s *safekeepStore) Test(ctx context.Context) (*TestResult, error) {
	start := time.Now()
	desc := s.target.SafeKeepURL
	resp, err := s.do(ctx, http.MethodGet, "/api/v1/upstreams", nil, nil, -1)
	if err != nil {
		return &TestResult{Type: TargetSafeKeep, Target: desc, LatencyMS: time.Since(start).Milliseconds(), Error: err.Error()}, err
	}
	defer resp.Body.Close()
	if resp.StatusCode != http.StatusOK {
		rerr := readSafeKeepError(resp)
		return &TestResult{Type: TargetSafeKeep, Target: desc, LatencyMS: time.Since(start).Milliseconds(), Error: rerr.Error()}, rerr
	}
	var up struct {
		Items []map[string]any `json:"items"`
	}
	if err := json.NewDecoder(io.LimitReader(resp.Body, 4<<20)).Decode(&up); err != nil {
		return &TestResult{Type: TargetSafeKeep, Target: desc, LatencyMS: time.Since(start).Milliseconds(), Error: "解析 SafeKeep 响应失败: " + err.Error()}, err
	}
	if len(up.Items) == 0 {
		err := fmt.Errorf("SafeKeep API Key 未关联任何上游存储")
		return &TestResult{Type: TargetSafeKeep, Target: desc, LatencyMS: time.Since(start).Milliseconds(), Error: err.Error()}, err
	}
	return &TestResult{OK: true, Type: TargetSafeKeep, Target: desc, LatencyMS: time.Since(start).Milliseconds()}, nil
}

func (s *safekeepStore) PutAndVerify(ctx context.Context, subdir, name, localPath, wantSHA string, wantSize int64) (string, error) {
	f, err := os.Open(localPath)
	if err != nil {
		return "", err
	}
	defer f.Close()

	uploadPath := strings.Trim(path.Join(s.target.SafeKeepSubpath, strings.Trim(subdir, "/")), "/")
	mode := s.target.SafeKeepMode
	if mode == "" {
		mode = "sync"
	}
	headers := map[string]string{
		"Content-Type":     "application/octet-stream",
		"X-File-Name":      name,
		"X-Content-SHA256": wantSHA,
		"X-Backup-Mode":    mode,
		"X-Backup-Path":    uploadPath,
		"X-Backup-Targets": s.target.SafeKeepTargets,
		"Idempotency-Key":  "nd-" + wantSHA + "-" + name,
	}
	resp, err := s.do(ctx, http.MethodPost, "/api/v1/backups", f, headers, wantSize)
	if err != nil {
		return "", err
	}
	defer resp.Body.Close()
	if resp.StatusCode < 200 || resp.StatusCode >= 300 {
		return "", readSafeKeepError(resp)
	}
	var res struct {
		Task struct {
			ID           string `json:"id"`
			Status       string `json:"status"`
			SHA256       string `json:"sha256"`
			ErrorSummary string `json:"error_summary"`
		} `json:"task"`
	}
	if err := json.NewDecoder(io.LimitReader(resp.Body, 4<<20)).Decode(&res); err != nil {
		return "", fmt.Errorf("解析 SafeKeep 上传响应失败: %w", err)
	}
	if res.Task.ID == "" {
		return "", fmt.Errorf("SafeKeep 未返回 task.id")
	}
	if res.Task.Status == "failed" {
		return "", fmt.Errorf("SafeKeep 上传任务失败: %s", res.Task.ErrorSummary)
	}
	if res.Task.SHA256 != "" && !strings.EqualFold(res.Task.SHA256, wantSHA) {
		return "", fmt.Errorf("SafeKeep 返回 SHA-256 不一致（期望 %s，实际 %s）", wantSHA, res.Task.SHA256)
	}
	// Verify read-back when synchronous upload succeeded.
	if res.Task.Status == "succeeded" {
		dl, err := s.do(ctx, http.MethodGet, "/api/v1/backups/"+url.PathEscape(res.Task.ID)+"/download", nil, nil, -1)
		if err != nil {
			return "", fmt.Errorf("SafeKeep 回读验证请求失败: %w", err)
		}
		if dl.StatusCode != http.StatusOK {
			rerr := readSafeKeepError(dl)
			dl.Body.Close()
			return "", fmt.Errorf("SafeKeep 回读验证失败: %w", rerr)
		}
		verr := verifyReader(dl.Body, wantSHA, wantSize)
		dl.Body.Close()
		if verr != nil {
			return "", fmt.Errorf("SafeKeep 回读校验失败: %w", verr)
		}
	}
	return res.Task.ID + "/" + name, nil
}

func (s *safekeepStore) Rotate(_ context.Context, _, _ string, _ int) (int, error) {
	// SafeKeep Client API does not expose object deletion; retention is managed in SafeKeep / upstream storage.
	return 0, nil
}

func (s *safekeepStore) List(ctx context.Context, subdir, prefix string) ([]ObjectInfo, error) {
	q := url.Values{}
	q.Set("status", "succeeded")
	q.Set("limit", "100")
	if prefix != "" {
		q.Set("q", prefix)
	}
	resp, err := s.do(ctx, http.MethodGet, "/api/v1/backups?"+q.Encode(), nil, nil, -1)
	if err != nil {
		return nil, err
	}
	defer resp.Body.Close()
	if resp.StatusCode != http.StatusOK {
		return nil, readSafeKeepError(resp)
	}
	var payload struct {
		Items []struct {
			ID               string    `json:"id"`
			OriginalFilename string    `json:"original_filename"`
			CustomSubpath    string    `json:"custom_subpath"`
			FileSize         int64     `json:"file_size"`
			CreatedAt        time.Time `json:"created_at"`
		} `json:"items"`
	}
	if err := json.NewDecoder(io.LimitReader(resp.Body, 8<<20)).Decode(&payload); err != nil {
		return nil, err
	}
	wantSubdir := strings.Trim(path.Join(s.target.SafeKeepSubpath, strings.Trim(subdir, "/")), "/")
	var out []ObjectInfo
	for _, it := range payload.Items {
		if prefix != "" && !strings.HasPrefix(it.OriginalFilename, prefix) {
			continue
		}
		gotSubdir := strings.Trim(it.CustomSubpath, "/")
		if wantSubdir != "" && gotSubdir != wantSubdir && !strings.HasPrefix(gotSubdir, wantSubdir+"/") {
			continue
		}
		out = append(out, ObjectInfo{
			Object:    it.ID + "/" + it.OriginalFilename,
			Name:      it.OriginalFilename,
			SizeBytes: it.FileSize,
			ModTime:   it.CreatedAt.UTC(),
		})
	}
	sort.Slice(out, func(i, j int) bool { return out[i].ModTime.After(out[j].ModTime) })
	return out, nil
}

func (s *safekeepStore) Open(ctx context.Context, object string) (io.ReadCloser, error) {
	taskID, _, _ := strings.Cut(object, "/")
	if strings.TrimSpace(taskID) == "" {
		return nil, fmt.Errorf("无效的 SafeKeep 对象标识: %s", object)
	}
	resp, err := s.do(ctx, http.MethodGet, "/api/v1/backups/"+url.PathEscape(taskID)+"/download", nil, nil, -1)
	if err != nil {
		return nil, err
	}
	if resp.StatusCode != http.StatusOK {
		rerr := readSafeKeepError(resp)
		resp.Body.Close()
		return nil, rerr
	}
	return resp.Body, nil
}
