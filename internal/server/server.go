// Package server assembles and runs the NomadDeck control plane process.
package server

import (
	"context"
	"crypto/tls"
	"errors"
	"fmt"
	"log/slog"
	"net"
	"net/http"
	"net/netip"
	"os"
	"path/filepath"
	"sync/atomic"
	"time"

	"nomad-deck/internal/api"
	"nomad-deck/internal/audit"
	"nomad-deck/internal/auth"
	"nomad-deck/internal/config"
	"nomad-deck/internal/crypto"
	"nomad-deck/internal/db"
	"nomad-deck/internal/version"
)

// DatabaseFile is the SQLite file name inside the data directory.
const DatabaseFile = "nomad-deck.db"

// App is an initialized control plane.
type App struct {
	Config *config.Config
	Log    *slog.Logger
	Keys   *crypto.Keyring
	DB     *db.DB
	Audit  *audit.Recorder
	Auth   *auth.Service
	API    *api.API
	ready  atomic.Bool
}

// Open initializes data directory, master keys, database and services.
func Open(ctx context.Context, cfg *config.Config, log *slog.Logger) (*App, error) {
	if err := os.MkdirAll(cfg.DataDir, 0o700); err != nil {
		return nil, fmt.Errorf("create data dir: %w", err)
	}
	keys, err := crypto.LoadKeyring(crypto.LoadOptions{
		CredentialsDir: os.Getenv("CREDENTIALS_DIRECTORY"),
		Getenv:         os.Getenv,
		DataDir:        cfg.DataDir,
		AllowGenerate:  true,
	})
	if err != nil {
		return nil, err
	}
	d, err := db.Open(ctx, filepath.Join(cfg.DataDir, DatabaseFile))
	if err != nil {
		return nil, fmt.Errorf("open database: %w", err)
	}
	problems, err := db.CheckKeyIDs(ctx, d.Reader, crypto.KeyIDOf, keys.Has)
	if err != nil {
		d.Close()
		return nil, err
	}
	if len(problems) > 0 {
		d.Close()
		return nil, fmt.Errorf("master key self-check failed: %d encrypted value(s) reference keys that are not loaded "+
			"(restore the previous master key and finish rotation):%s", len(problems), db.FormatProblems(problems))
	}
	rec := &audit.Recorder{DB: d, Log: log}
	authSvc := auth.NewService(d, keys, rec, log, cfg.DataDir)
	app := &App{Config: cfg, Log: log, Keys: keys, DB: d, Audit: rec, Auth: authSvc}
	origins, err := AllowedOrigins(cfg)
	if err != nil {
		d.Close()
		return nil, err
	}
	var trusted []netip.Prefix
	for _, p := range cfg.TLS.TrustedProxies {
		pr, _ := config.ParsePrefix(p)
		trusted = append(trusted, pr)
	}
	app.API = &api.API{DB: d, Auth: authSvc, Log: log, AllowedOrigins: origins, TrustedProxies: trusted,
		HTTPS: cfg.TLS.Mode != config.TLSModeProxy || isHTTPS(cfg), Ready: &app.ready}
	return app, nil
}

func isHTTPS(cfg *config.Config) bool {
	o, err := cfg.PublicOrigin()
	return err == nil && len(o) > 8 && o[:8] == "https://"
}

// Close releases resources.
func (a *App) Close() error { return a.DB.Close() }

// Run serves HTTP(S) until ctx is cancelled.
func (a *App) Run(ctx context.Context) error {
	cfg := a.Config
	tok, err := a.Auth.PrepareSetupToken(ctx)
	if err != nil {
		return fmt.Errorf("prepare setup token: %w", err)
	}
	if tok != "" {
		fmt.Fprintf(os.Stderr, "\n  NomadDeck 尚未初始化。一次性 Setup Token：%s\n  （同时写入 %s，完成初始化后自动删除）\n\n",
			tok, filepath.Join(cfg.DataDir, "setup.token"))
	}

	srv := &http.Server{
		Handler:           a.API.Handler(),
		ReadHeaderTimeout: 10 * time.Second,
		IdleTimeout:       120 * time.Second,
		ErrorLog:          slog.NewLogLogger(a.Log.Handler(), slog.LevelWarn),
	}
	ln, err := net.Listen("tcp", cfg.Listen)
	if err != nil {
		return fmt.Errorf("listen %s: %w", cfg.Listen, err)
	}
	if cfg.TLS.Mode != config.TLSModeProxy {
		var cert tls.Certificate
		if cfg.TLS.CertFile != "" {
			cert, err = LoadCertFile(cfg.TLS.CertFile, cfg.TLS.KeyFile)
		} else {
			cert, err = LoadOrCreateSelfSigned(filepath.Join(cfg.DataDir, "tls"), CertHosts(cfg), time.Now())
		}
		if err != nil {
			ln.Close()
			return err
		}
		a.Log.Info("tls certificate", "sha256", Fingerprint(cert), "self_signed", cfg.TLS.CertFile == "")
		// ServeTLS enables HTTP/2 automatically.
		srv.TLSConfig = &tls.Config{MinVersion: tls.VersionTLS12, Certificates: []tls.Certificate{cert}}
	}

	go a.sessionJanitor(ctx)

	errCh := make(chan error, 1)
	go func() {
		if srv.TLSConfig != nil {
			errCh <- srv.ServeTLS(ln, "", "")
			return
		}
		errCh <- srv.Serve(ln)
	}()
	a.ready.Store(true)
	a.Log.Info("nomad-deck started", "version", version.String(), "listen", cfg.Listen, "tls_mode", cfg.TLS.Mode)
	if err := sdNotify("READY=1"); err != nil {
		a.Log.Warn("sd_notify failed", "err", err)
	}

	select {
	case err := <-errCh:
		if errors.Is(err, http.ErrServerClosed) {
			return nil
		}
		return err
	case <-ctx.Done():
	}
	a.ready.Store(false)
	_ = sdNotify("STOPPING=1")
	shutdownCtx, cancel := context.WithTimeout(context.Background(), 15*time.Second)
	defer cancel()
	return srv.Shutdown(shutdownCtx)
}

func (a *App) sessionJanitor(ctx context.Context) {
	t := time.NewTicker(5 * time.Minute)
	defer t.Stop()
	for {
		select {
		case <-ctx.Done():
			return
		case <-t.C:
			if err := a.Auth.CleanupExpiredSessions(ctx); err != nil {
				a.Log.Warn("session cleanup failed", "err", err)
			}
		}
	}
}
