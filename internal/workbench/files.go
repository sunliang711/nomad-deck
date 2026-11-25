package workbench

import (
	"context"
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"net/url"
	"path"
	"regexp"
	"strconv"
	"strings"
	"time"

	"nomad-deck/internal/audit"
	"nomad-deck/internal/auth"
	"nomad-deck/internal/nomad"
)

// MaxPreview is the largest file range returned for an online preview.
const MaxPreview = 1 << 20

var reTask = regexp.MustCompile(`^[A-Za-z0-9_][A-Za-z0-9_.-]{0,127}$`)

// cleanAllocPath normalizes a path inside an allocation directory.
func cleanAllocPath(p string) (string, error) {
	if p == "" {
		p = "/"
	}
	if strings.ContainsRune(p, 0) || len(p) > 1024 {
		return "", badRequest("路径不合法")
	}
	c := path.Clean("/" + p)
	return c, nil
}

// inSecrets reports whether a path is inside a task's secrets directory,
// whose contents Nomad does not serve through the file API.
func inSecrets(p string) bool {
	parts := strings.Split(strings.Trim(p, "/"), "/")
	return len(parts) >= 2 && parts[1] == "secrets"
}

// FileEntry is a file or directory in an allocation.
type FileEntry struct {
	Name     string    `json:"name"`
	IsDir    bool      `json:"is_dir"`
	Size     int64     `json:"size"`
	Mode     string    `json:"mode"`
	ModTime  time.Time `json:"mod_time"`
	Readable bool      `json:"readable"`
}

// ListFiles lists a directory of an allocation (names and metadata only).
func (s *Service) ListFiles(ctx context.Context, clusterID, allocID, dir string) ([]FileEntry, error) {
	if err := validUUID(allocID); err != nil {
		return nil, err
	}
	p, err := cleanAllocPath(dir)
	if err != nil {
		return nil, err
	}
	c, err := s.api(ctx, clusterID)
	if err != nil {
		return nil, err
	}
	var raw []struct {
		Name     string    `json:"Name"`
		IsDir    bool      `json:"IsDir"`
		Size     int64     `json:"Size"`
		FileMode string    `json:"FileMode"`
		ModTime  time.Time `json:"ModTime"`
	}
	if err := c.Request(ctx, "GET", "client/fs/ls/"+allocID+"?path="+url.QueryEscape(p), nil, &raw); err != nil {
		return nil, nomadErr(err)
	}
	out := []FileEntry{}
	for _, f := range raw {
		out = append(out, FileEntry{Name: f.Name, IsDir: f.IsDir, Size: f.Size, Mode: f.FileMode, ModTime: f.ModTime,
			Readable: !f.IsDir && !inSecrets(path.Join(p, f.Name))})
	}
	return out, nil
}

// StatFile returns one file's metadata.
func (s *Service) StatFile(ctx context.Context, clusterID, allocID, file string) (json.RawMessage, error) {
	if err := validUUID(allocID); err != nil {
		return nil, err
	}
	p, err := cleanAllocPath(file)
	if err != nil {
		return nil, err
	}
	return s.get(ctx, clusterID, "client/fs/stat/"+allocID+"?path="+url.QueryEscape(p))
}

func secretsRefused() error {
	return &auth.Error{Status: 403, Code: "secrets_unreadable",
		Message: "secrets 目录下的文件内容不能经文件接口读取，请通过交互式终端在 Task 内查看"}
}

// ReadFile reads a range of a file for preview (admin, audited).
func (s *Service) ReadFile(ctx context.Context, actor audit.Actor, clusterID, allocID, file string, offset, limit int64) ([]byte, error) {
	if err := validUUID(allocID); err != nil {
		return nil, err
	}
	p, err := cleanAllocPath(file)
	if err != nil {
		return nil, err
	}
	if inSecrets(p) {
		return nil, secretsRefused()
	}
	if offset < 0 || limit <= 0 || limit > MaxPreview {
		limit = MaxPreview
	}
	if offset < 0 {
		offset = 0
	}
	c, err := s.api(ctx, clusterID)
	if err != nil {
		return nil, err
	}
	resp, err := stream(ctx, c, fmt.Sprintf("client/fs/readat/%s?path=%s&offset=%d&limit=%d", allocID, url.QueryEscape(p), offset, limit))
	if err != nil {
		s.auditOp(ctx, actor, clusterID, "alloc_file_read", "alloc/"+allocID, map[string]any{"path": p}, err)
		return nil, nomadErr(err)
	}
	defer resp.Body.Close()
	b, err := io.ReadAll(io.LimitReader(resp.Body, MaxPreview))
	s.auditOp(ctx, actor, clusterID, "alloc_file_read", "alloc/"+allocID, map[string]any{"path": p, "offset": offset, "bytes": len(b)}, err)
	return b, err
}

// DownloadFile streams a whole file (admin, audited).
func (s *Service) DownloadFile(ctx context.Context, actor audit.Actor, clusterID, allocID, file string, w io.Writer) error {
	if err := validUUID(allocID); err != nil {
		return err
	}
	p, err := cleanAllocPath(file)
	if err != nil {
		return err
	}
	if inSecrets(p) {
		return secretsRefused()
	}
	c, err := s.api(ctx, clusterID)
	if err != nil {
		return err
	}
	resp, err := stream(ctx, c, "client/fs/cat/"+allocID+"?path="+url.QueryEscape(p))
	if err != nil {
		s.auditOp(ctx, actor, clusterID, "alloc_file_download", "alloc/"+allocID, map[string]any{"path": p}, err)
		return nomadErr(err)
	}
	defer resp.Body.Close()
	n, err := io.Copy(w, resp.Body)
	s.auditOp(ctx, actor, clusterID, "alloc_file_download", "alloc/"+allocID, map[string]any{"path": p, "bytes": n}, err)
	return err
}

// stream performs a GET whose body is consumed by the caller (no client
// timeout: the context bounds it).
func stream(ctx context.Context, c *nomad.Client, p string) (*http.Response, error) {
	req, err := http.NewRequestWithContext(ctx, http.MethodGet, c.Addr+"/v1/"+p, nil)
	if err != nil {
		return nil, err
	}
	if c.Token != "" {
		req.Header.Set("X-Nomad-Token", c.Token)
	}
	hc := *c.HTTP
	hc.Timeout = 0
	resp, err := hc.Do(req)
	if err != nil {
		return nil, err
	}
	if resp.StatusCode >= 300 {
		defer resp.Body.Close()
		b, _ := io.ReadAll(io.LimitReader(resp.Body, 64<<10))
		return nil, &nomad.APIError{Status: resp.StatusCode, Message: strings.TrimSpace(string(b))}
	}
	return resp, nil
}

// LogInput selects a log stream.
type LogInput struct {
	Task   string
	Type   string // stdout | stderr
	Follow bool
	Tail   int64 // bytes from the end (0 = from the start)
}

// Logs opens a task log stream (plain text). The caller closes it.
func (s *Service) Logs(ctx context.Context, clusterID, allocID string, in LogInput) (io.ReadCloser, error) {
	if err := validUUID(allocID); err != nil {
		return nil, err
	}
	if !reTask.MatchString(in.Task) {
		return nil, badRequest("Task 名称不合法")
	}
	if in.Type != "stdout" && in.Type != "stderr" {
		return nil, badRequest("type 需为 stdout 或 stderr")
	}
	c, err := s.api(ctx, clusterID)
	if err != nil {
		return nil, err
	}
	q := url.Values{"task": {in.Task}, "type": {in.Type}, "plain": {"true"}, "follow": {strconv.FormatBool(in.Follow)}}
	if in.Tail > 0 {
		q.Set("origin", "end")
		q.Set("offset", strconv.FormatInt(in.Tail, 10))
	} else {
		q.Set("origin", "start")
	}
	resp, err := stream(ctx, c, "client/fs/logs/"+allocID+"?"+q.Encode())
	if err != nil {
		return nil, nomadErr(err)
	}
	return resp.Body, nil
}
