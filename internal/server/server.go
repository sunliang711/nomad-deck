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
	"sync"
	"sync/atomic"
	"time"

	"nomad-deck/internal/api"
	"nomad-deck/internal/audit"
	"nomad-deck/internal/auth"
	"nomad-deck/internal/backup"
	"nomad-deck/internal/cluster"
	"nomad-deck/internal/config"
	"nomad-deck/internal/cron"
	"nomad-deck/internal/crypto"
	"nomad-deck/internal/db"
	"nomad-deck/internal/hosts"
	"nomad-deck/internal/integration"
	"nomad-deck/internal/jobs"
	"nomad-deck/internal/migration"
	"nomad-deck/internal/netx"
	"nomad-deck/internal/nomad"
	"nomad-deck/internal/ops"
	"nomad-deck/internal/release"
	"nomad-deck/internal/rotation"
	"nomad-deck/internal/selfupdate"
	"nomad-deck/internal/snapstore"
	"nomad-deck/internal/sshx"
	"nomad-deck/internal/ui"
	"nomad-deck/internal/vault"
	"nomad-deck/internal/version"
	"nomad-deck/internal/workbench"
)

// DatabaseFile is the SQLite file name inside the data directory.
const DatabaseFile = "nomad-deck.db"

// ExitError instructs main to exit with a specific status code (e.g. 75 for
// self-update restart).
type ExitError struct {
	Code int
	Err  error
}

func (e *ExitError) Error() string {
	if e.Err != nil {
		return e.Err.Error()
	}
	return fmt.Sprintf("exit status %d", e.Code)
}

// App is an initialized control plane.
type App struct {
	Config     *config.Config
	Log        *slog.Logger
	Keys       *crypto.Keyring
	DB         *db.DB
	Audit      *audit.Recorder
	Auth       *auth.Service
	Hosts      *hosts.Service
	Ops        *ops.Engine
	Pool       *sshx.Pool
	Vault      *vault.Service
	Nomad      *nomad.Service
	Cron       *cron.Scheduler
	Backup     *backup.Service
	Rotation   *rotation.Service
	SelfUpdate *selfupdate.Service
	API        *api.API
	ready      atomic.Bool
	exitCode   atomic.Int32
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
	snaps, err := db.ListAllSnapshots(ctx, d.Reader)
	if err != nil {
		d.Close()
		return nil, err
	}
	for _, sn := range snaps {
		if _, err := os.Stat(sn.FilePath); errors.Is(err, os.ErrNotExist) {
			continue
		}
		kid, kerr := snapstore.HeaderKeyID(sn.FilePath)
		if kerr != nil || !keys.Has(kid) {
			d.Close()
			return nil, fmt.Errorf("master key self-check failed: snapshot %s (%s) references key %q that is not loaded "+
				"(restore the previous master key and finish rotation, err=%v)", sn.ID, sn.FilePath, kid, kerr)
		}
	}
	rec := &audit.Recorder{DB: d, Log: log}
	authSvc := auth.NewService(d, keys, rec, log, cfg.DataDir)
	pool := sshx.NewPool(db.IntSetting(ctx, d.Reader, "ssh.max_concurrency", 10))
	engine := ops.NewEngine(d, log, cfg.DataDir)
	recovered, err := engine.Recover(ctx)
	if err != nil {
		d.Close()
		return nil, fmt.Errorf("recover tasks: %w", err)
	}
	for _, t := range recovered {
		log.Warn("unfinished task after restart", "task", t.ID, "action", t.Action, "status", t.Status)
		// A cluster whose task was cut off needs reconciliation before
		// anything else changes it: put it into maintenance (locks are not
		// released blindly).
		if t.Status == db.TaskNeedsReconcile && t.TargetType == "cluster" {
			if err := db.SetClusterMaintenance(ctx, d.Writer, t.TargetID, true, "needs_reconcile", d.Now()); err != nil {
				log.Error("mark cluster for reconciliation", "cluster", t.TargetID, "err", err)
			}
		}
	}
	localID := hosts.ReadLocalIdentity()
	hostSvc := &hosts.Service{DB: d, Keys: keys, Audit: rec, Pool: pool, LocalMachineID: localID.MachineID, LocalIdentity: localID}
	proxy := &netx.Manager{DB: d, Keys: keys}
	releases := &release.Provider{DB: d, CacheDir: filepath.Join(cfg.DataDir, "cache", "releases")}
	vaultSvc := &vault.Service{DB: d, Keys: keys, Audit: rec, Hosts: hostSvc, Ops: engine, Releases: releases, Proxy: proxy,
		DataDir: cfg.DataDir, Log: log}
	nomadSvc := &nomad.Service{DB: d, Keys: keys, Audit: rec, Hosts: hostSvc, Ops: engine, Releases: releases, Proxy: proxy,
		DataDir: cfg.DataDir, Log: log}
	integrations := &integration.Service{DB: d, Keys: keys, Audit: rec, Ops: engine, Nomad: nomadSvc, Vault: vaultSvc, Log: log}
	integrations.Wire()
	jobSvc := &jobs.Service{DB: d, Keys: keys, Audit: rec, Ops: engine, Nomad: nomadSvc, Log: log,
		VaultInspector: api.NewVaultInspector(d, integrations, vaultSvc)}
	jobSvc.Init()
	wb := &workbench.Service{DB: d, Audit: rec, Nomad: nomadSvc, Log: log}
	wb.Init()
	drivers := map[string]cluster.Driver{"nomad": nomadSvc.Driver(), "vault": vaultSvc.Driver()}
	sched := &cron.Scheduler{DB: d, Audit: rec, Ops: engine, Log: log}
	rotSvc := &rotation.Service{DB: d, Keys: keys, Audit: rec, Ops: engine, DataDir: cfg.DataDir, Log: log}
	resched := func() { sched.Reschedule(context.Background()) }
	mig := &migration.Service{DB: d, Keys: keys, Audit: rec, Ops: engine, DataDir: cfg.DataDir, Log: log,
		Idle: sched.Idle, ExtraBusy: rotSvc.IsRunning,
		AfterImport:   []func(){authSvc.Revocations.RevokeAll, pool.Close, resched},
		AfterActivate: []func(){resched}}
	mig.CleanupTempImports()
	backupSvc := &backup.Service{DB: d, Keys: keys, Audit: rec, Migration: mig, Drivers: drivers, DataDir: cfg.DataDir, Log: log}
	if err := db.FailRunningBackupRuns(ctx, d.Writer, "控制面重启导致备份任务中断", d.Now()); err != nil {
		d.Close()
		return nil, fmt.Errorf("recover backup runs: %w", err)
	}
	selfUpdateSvc := &selfupdate.Service{
		DB: d, Audit: rec, Ops: engine, Proxy: proxy, DataDir: cfg.DataDir, Log: log,
		CronIdle: sched.Idle, CronResume: sched.Reschedule, ExtraBusy: rotSvc.IsRunning,
	}
	selfUpdateSvc.PrepareBarrierOnOpen(ctx)
	sched.Install(&cron.Platform{Hosts: hostSvc, Drivers: drivers, Vault: vaultSvc, Integrations: integrations, Jobs: jobSvc,
		Proxy: proxy, DataDir: cfg.DataDir, Backup: backupSvc.CronBackup, BackupTarget: backupSvc.CronBackupTarget,
		ValidateBackupTarget: backupSvc.ValidateTarget, Offsite: backupSvc.OffsiteSnapshot, SelfUpdateCheck: selfUpdateSvc.CronCheck})
	app := &App{Config: cfg, Log: log, Keys: keys, DB: d, Audit: rec, Auth: authSvc, Hosts: hostSvc, Ops: engine, Pool: pool,
		Vault: vaultSvc, Nomad: nomadSvc, Cron: sched, Backup: backupSvc, Rotation: rotSvc, SelfUpdate: selfUpdateSvc}
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
	app.API = &api.API{DB: d, Auth: authSvc, Hosts: hostSvc, Proxy: proxy, Ops: engine, Releases: releases, Vault: vaultSvc, Nomad: nomadSvc,
		Integrations: integrations, Jobs: jobSvc, Workbench: wb, Cron: sched, Migration: mig, Backup: backupSvc, Rotation: rotSvc,
		SelfUpdate: selfUpdateSvc, UI: ui.Handler(), Log: log, AllowedOrigins: origins, TrustedProxies: trusted,
		HTTPS: cfg.TLS.Mode != config.TLSModeProxy || isHTTPS(cfg), Ready: &app.ready}
	return app, nil
}

func isHTTPS(cfg *config.Config) bool {
	o, err := cfg.PublicOrigin()
	return err == nil && len(o) > 8 && o[:8] == "https://"
}

// Close releases resources.
func (a *App) Close() error {
	a.Pool.Close()
	return a.DB.Close()
}

// Run serves HTTP(S) until ctx is cancelled.
func (a *App) Run(ctx context.Context) error {
	cfg := a.Config

	runCtx, cancelRun := context.WithCancel(ctx)
	var bgWG sync.WaitGroup
	defer func() {
		cancelRun()
		bgWG.Wait()
	}()
	if a.SelfUpdate != nil {
		a.SelfUpdate.OnRestart = func(code int) {
			a.exitCode.Store(int32(code))
			cancelRun()
		}
	}

	tok, err := a.Auth.PrepareSetupToken(runCtx)
	if err != nil {
		return fmt.Errorf("prepare setup token: %w", err)
	}
	if tok != "" {
		fmt.Fprintf(os.Stderr, "\n  NomadDeck 尚未初始化。一次性 Setup Token：%s\n  （同时写入 %s，完成初始化后自动删除）\n\n",
			tok, filepath.Join(cfg.DataDir, "setup.token"))
	}

	srv := &http.Server{
		Handler:           a.API.Handler(),
		BaseContext:       func(net.Listener) context.Context { return runCtx },
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

	bgWG.Add(1)
	go func() {
		defer bgWG.Done()
		a.sessionJanitor(runCtx)
	}()
	if err := a.Cron.Start(runCtx); err != nil {
		ln.Close()
		return fmt.Errorf("start scheduler: %w", err)
	}
	defer a.Cron.Stop()

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
	if a.SelfUpdate != nil {
		a.SelfUpdate.ConfirmOnStartup(runCtx)
		bgWG.Add(1)
		go func() {
			defer bgWG.Done()
			a.SelfUpdate.RunScheduler(runCtx)
		}()
	}

	select {
	case err := <-errCh:
		if errors.Is(err, http.ErrServerClosed) {
			return nil
		}
		return err
	case <-runCtx.Done():
	}
	a.ready.Store(false)
	_ = sdNotify("STOPPING=1")
	a.Auth.Revocations.RevokeAll()
	shutdownCtx, cancel := context.WithTimeout(context.Background(), 15*time.Second)
	defer cancel()
	err = srv.Shutdown(shutdownCtx)
	if code := int(a.exitCode.Load()); code != 0 {
		return &ExitError{Code: code, Err: err}
	}
	return err
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
