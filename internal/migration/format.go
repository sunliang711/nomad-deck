package migration

import (
	"archive/tar"
	"bufio"
	"bytes"
	"encoding/base64"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"path"
	"strings"
	"time"

	"nomad-deck/internal/snapstore"
)

// Magic identifies a bundle file.
const Magic = "NDBU"

// FormatVersion is the bundle content format.
const FormatVersion = 1

// partSize caps one table part inside the bundle.
const partSize = 4 << 20

// Kinds of bundles.
const (
	KindMigration = "migration"
	KindBackup    = "backup"
)

// OffsiteSnapshot records the latest off-site snapshot of a cluster when a
// backup bundle was produced.
type OffsiteSnapshot struct {
	ClusterID   string    `json:"cluster_id"`
	ClusterName string    `json:"cluster_name"`
	SnapshotID  string    `json:"snapshot_id"`
	Object      string    `json:"object"`
	CreatedAt   time.Time `json:"created_at"`
}

// Manifest describes a bundle's content.
type Manifest struct {
	Format           int               `json:"format"`
	Kind             string            `json:"kind"`
	SchemaVersion    int               `json:"schema_version"`
	AppVersion       string            `json:"app_version"`
	CreatedAt        time.Time         `json:"created_at"`
	CreatedBy        string            `json:"created_by"`
	Tables           []string          `json:"tables"`
	Rows             map[string]int    `json:"rows"`
	LogFiles         int               `json:"log_files"`
	OffsiteSnapshots []OffsiteSnapshot `json:"offsite_snapshots,omitempty"`
}

// header is the authenticated (not encrypted) outer header.
type header struct {
	Format    int       `json:"format"`
	Kind      string    `json:"kind"`
	CreatedAt time.Time `json:"created_at"`
}

// bundleWriter writes tar entries into the sealed stream.
type bundleWriter struct {
	tw    *tar.Writer
	parts map[string]int
}

func (b *bundleWriter) file(name string, data []byte) error {
	if err := b.tw.WriteHeader(&tar.Header{Name: name, Mode: 0o600, Size: int64(len(data)), ModTime: time.Unix(0, 0)}); err != nil {
		return err
	}
	_, err := b.tw.Write(data)
	return err
}

func (b *bundleWriter) stream(name string, size int64, r io.Reader) error {
	if err := b.tw.WriteHeader(&tar.Header{Name: name, Mode: 0o600, Size: size, ModTime: time.Unix(0, 0)}); err != nil {
		return err
	}
	_, err := io.CopyN(b.tw, r, size)
	return err
}

// tableWriter buffers JSON lines of one table into parts.
type tableWriter struct {
	b     *bundleWriter
	table string
	buf   bytes.Buffer
}

func (t *tableWriter) row(v map[string]any) error {
	line, err := json.Marshal(v)
	if err != nil {
		return err
	}
	t.buf.Write(line)
	t.buf.WriteByte('\n')
	if t.buf.Len() >= partSize {
		return t.flush()
	}
	return nil
}

func (t *tableWriter) flush() error {
	if t.buf.Len() == 0 {
		return nil
	}
	t.b.parts[t.table]++
	name := fmt.Sprintf("tables/%s/%06d.jsonl", t.table, t.b.parts[t.table])
	err := t.b.file(name, t.buf.Bytes())
	t.buf.Reset()
	return err
}

// write produces a bundle: fn adds entries; the result is sealed with the
// passphrase.
func write(dst io.Writer, kind, passphrase string, fn func(b *bundleWriter) error) error {
	pr, pw := io.Pipe()
	done := make(chan error, 1)
	go func() {
		tw := tar.NewWriter(pw)
		err := fn(&bundleWriter{tw: tw, parts: map[string]int{}})
		if err == nil {
			err = tw.Close()
		}
		pw.CloseWithError(err)
		done <- err
	}()
	err := snapstore.SealStream(dst, pr, Magic, header{Format: FormatVersion, Kind: kind, CreatedAt: time.Now().UTC()}, passphrase)
	pr.CloseWithError(err)
	if ferr := <-done; err == nil && ferr != nil {
		err = ferr
	}
	return err
}

// Visitor receives a bundle's content while it is read.
type Visitor struct {
	Manifest func(m *Manifest) error
	Row      func(table string, row map[string]any) error
	LogFile  func(rel string, size int64, r io.Reader) error
}

// ErrPassphrase is returned when the bundle cannot be decrypted.
var ErrPassphrase = errors.New("迁移包口令错误或文件已损坏")

// read decrypts and walks a bundle. The manifest is always the first entry.
func read(src io.ReadCloser, passphrase string, v Visitor) (*Manifest, error) {
	hdrJSON, body, err := snapstore.OpenStream(src, Magic, passphrase)
	if err != nil {
		return nil, fmt.Errorf("不是有效的 NomadDeck 迁移包：%w", err)
	}
	defer body.Close()
	var h header
	if err := json.Unmarshal(hdrJSON, &h); err != nil || h.Format != FormatVersion {
		return nil, errors.New("迁移包格式版本不受支持")
	}
	tr := tar.NewReader(body)
	var m *Manifest
	for {
		th, err := tr.Next()
		if err == io.EOF {
			break
		}
		if err != nil {
			if strings.Contains(err.Error(), "authentication") || strings.Contains(err.Error(), "message authentication failed") {
				return nil, ErrPassphrase
			}
			return nil, fmt.Errorf("迁移包内容损坏：%w", err)
		}
		name := path.Clean(th.Name)
		switch {
		case name == "manifest.json":
			var mm Manifest
			if err := json.NewDecoder(io.LimitReader(tr, 1<<20)).Decode(&mm); err != nil {
				return nil, fmt.Errorf("迁移包清单无法解析：%w", err)
			}
			if mm.Format != FormatVersion {
				return nil, errors.New("迁移包格式版本不受支持")
			}
			m = &mm
			if v.Manifest != nil {
				if err := v.Manifest(m); err != nil {
					return nil, err
				}
			}
		case m == nil:
			return nil, errors.New("迁移包缺少清单")
		case strings.HasPrefix(name, "tables/"):
			parts := strings.Split(name, "/")
			if len(parts) != 3 || !contains(m.Tables, parts[1]) {
				return nil, fmt.Errorf("迁移包含有未声明的表数据：%s", name)
			}
			if v.Row == nil {
				continue
			}
			sc := bufio.NewScanner(tr)
			sc.Buffer(make([]byte, 1<<20), 64<<20)
			for sc.Scan() {
				dec := json.NewDecoder(bytes.NewReader(sc.Bytes()))
				dec.UseNumber()
				var row map[string]any
				if err := dec.Decode(&row); err != nil {
					return nil, fmt.Errorf("表 %s 的数据无法解析：%w", parts[1], err)
				}
				if err := v.Row(parts[1], row); err != nil {
					return nil, err
				}
			}
			if err := sc.Err(); err != nil {
				if strings.Contains(err.Error(), "authentication") {
					return nil, ErrPassphrase
				}
				return nil, err
			}
		case strings.HasPrefix(name, "logs/"):
			rel := strings.TrimPrefix(name, "logs/")
			if rel == "" || strings.HasPrefix(rel, "..") || path.IsAbs(rel) {
				return nil, fmt.Errorf("迁移包含有非法路径：%s", name)
			}
			if v.LogFile != nil {
				if err := v.LogFile(rel, th.Size, tr); err != nil {
					return nil, err
				}
			}
		default:
			return nil, fmt.Errorf("迁移包含有未知条目：%s", name)
		}
	}
	if m == nil {
		return nil, errors.New("迁移包缺少清单")
	}
	return m, nil
}

// secretMarker wraps a decrypted secret inside a bundle row.
const secretMarker = "$secret"

// bytesMarker wraps a BLOB value.
const bytesMarker = "$bytes"

func encodeValue(v any) any {
	switch x := v.(type) {
	case []byte:
		return map[string]any{bytesMarker: base64.StdEncoding.EncodeToString(x)}
	case time.Time:
		return x.UTC().Format("2006-01-02T15:04:05.000Z")
	}
	return v
}

// decodeValue converts a bundle value to a SQL argument.
func decodeValue(v any) (any, error) {
	switch x := v.(type) {
	case json.Number:
		if i, err := x.Int64(); err == nil {
			return i, nil
		}
		return x.Float64()
	case map[string]any:
		if b, ok := x[bytesMarker].(string); ok {
			return base64.StdEncoding.DecodeString(b)
		}
		return nil, errors.New("unexpected object value")
	}
	return v, nil
}
