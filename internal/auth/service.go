package auth

import (
	"context"
	"crypto/subtle"
	"database/sql"
	"errors"
	"log/slog"
	"os"
	"path/filepath"
	"regexp"
	"strings"
	"sync"
	"time"
	"unicode/utf8"

	"nomad-deck/internal/audit"
	"nomad-deck/internal/crypto"
	"nomad-deck/internal/db"
)

// Setting keys and defaults used by this package.
const (
	SettingSessionTTLHours   = "auth.session_ttl_hours"
	SettingSessionIdleMinute = "auth.session_idle_minutes"

	DefaultSessionTTLHours   = 12
	DefaultSessionIdleMinute = 60

	// LockThreshold is the number of consecutive failures before lockout.
	LockThreshold = 5

	setupTokenFile = "setup.token"
	sessionTouch   = time.Minute
)

var usernameRE = regexp.MustCompile(`^[A-Za-z0-9][A-Za-z0-9._-]{2,63}$`)

// Principal is an authenticated request identity.
type Principal struct {
	Admin   *db.Admin
	Session *db.Session
}

// IsAdmin reports whether the principal has the admin role.
func (p *Principal) IsAdmin() bool { return p != nil && p.Admin.Role == db.RoleAdmin }

// Actor converts the principal to an audit actor.
func (p *Principal) Actor(ip string) audit.Actor {
	return audit.Actor{ID: p.Admin.ID, Name: p.Admin.Username, ClientIP: ip}
}

// Service implements authentication and account management.
type Service struct {
	DB          *db.DB
	Keys        *crypto.Keyring
	Audit       *audit.Recorder
	Log         *slog.Logger
	Revocations *Revocations
	DataDir     string

	setupMu        sync.Mutex
	setupTokenHash string

	ipMu       sync.Mutex
	ipFailures map[string]*ipState
}

type ipState struct {
	failures    int
	lockedUntil time.Time
	last        time.Time
}

// NewService wires the service.
func NewService(d *db.DB, keys *crypto.Keyring, rec *audit.Recorder, log *slog.Logger, dataDir string) *Service {
	return &Service{
		DB: d, Keys: keys, Audit: rec, Log: log, DataDir: dataDir,
		Revocations: NewRevocations(),
		ipFailures:  map[string]*ipState{},
	}
}

func (s *Service) now() time.Time { return s.DB.Now() }

// NeedsSetup reports whether no account exists yet.
func (s *Service) NeedsSetup(ctx context.Context) (bool, error) {
	n, err := db.CountAdmins(ctx, s.DB.Reader)
	return n == 0, err
}

// PrepareSetupToken creates a one-time setup token when no account exists,
// writes it to data_dir/setup.token (0600) and returns it. It returns an
// empty string when setup is already complete.
func (s *Service) PrepareSetupToken(ctx context.Context) (string, error) {
	needs, err := s.NeedsSetup(ctx)
	if err != nil || !needs {
		_ = os.Remove(filepath.Join(s.DataDir, setupTokenFile))
		return "", err
	}
	tok, err := crypto.RandomToken(24)
	if err != nil {
		return "", err
	}
	path := filepath.Join(s.DataDir, setupTokenFile)
	tmp := path + ".tmp"
	if err := os.WriteFile(tmp, []byte(tok+"\n"), 0o600); err != nil {
		return "", err
	}
	if err := os.Rename(tmp, path); err != nil {
		return "", err
	}
	s.setupMu.Lock()
	s.setupTokenHash = crypto.SHA256Hex(tok)
	s.setupMu.Unlock()
	return tok, nil
}

// SetupInput is the first-run request.
type SetupInput struct {
	SetupToken string
	Username   string
	Password   string
	ClientIP   string
}

// Setup atomically consumes the setup token, creates the first admin account
// and generates the default SSH key pair.
func (s *Service) Setup(ctx context.Context, in SetupInput) (*db.Admin, error) {
	started := s.now()
	if err := validateUsername(in.Username); err != nil {
		return nil, err
	}
	if err := validatePassword(in.Password); err != nil {
		return nil, err
	}
	s.setupMu.Lock()
	defer s.setupMu.Unlock()
	if s.setupTokenHash == "" {
		if needs, _ := s.NeedsSetup(ctx); !needs {
			return nil, ErrAlreadySetup
		}
		return nil, ErrInvalidSetupToken
	}
	if subtle.ConstantTimeCompare([]byte(crypto.SHA256Hex(in.SetupToken)), []byte(s.setupTokenHash)) != 1 {
		s.recordAudit(ctx, nil, audit.Event{Actor: audit.Actor{ClientIP: in.ClientIP}, Action: "auth.setup",
			ResourceType: "admin", ResourceName: in.Username, Err: ErrInvalidSetupToken, Started: started})
		return nil, ErrInvalidSetupToken
	}
	hash, err := crypto.HashPassword(in.Password)
	if err != nil {
		return nil, err
	}
	pair, err := crypto.GenerateEd25519("nomad-deck")
	if err != nil {
		return nil, err
	}
	now := s.now()
	admin := &db.Admin{ID: db.NewID(), Username: in.Username, PasswordHash: hash, Role: db.RoleAdmin, CreatedAt: now, UpdatedAt: now}
	err = s.DB.WithTx(ctx, func(tx *sql.Tx) error {
		n, err := db.CountAdmins(ctx, tx)
		if err != nil {
			return err
		}
		if n != 0 {
			return ErrAlreadySetup
		}
		if err := db.InsertAdmin(ctx, tx, admin); err != nil {
			return err
		}
		keyID := db.NewID()
		enc, err := s.Keys.Encrypt(pair.PrivatePEM, db.SSHKeyAAD(keyID))
		if err != nil {
			return err
		}
		if err := db.InsertSSHKey(ctx, tx, &db.SSHKey{ID: keyID, Name: "default-cluster-key", Algorithm: "ed25519",
			PublicKey: pair.PublicKey, PrivateKeyEncrypted: enc, Fingerprint: pair.Fingerprint, IsDefault: true, CreatedAt: now}); err != nil {
			return err
		}
		return s.Audit.Record(ctx, tx, audit.Event{
			Actor:  audit.Actor{ID: admin.ID, Name: admin.Username, ClientIP: in.ClientIP},
			Action: "auth.setup", ResourceType: "admin", ResourceID: admin.ID, ResourceName: admin.Username,
			Summary: map[string]any{"default_ssh_key_fingerprint": pair.Fingerprint}, Started: started,
		})
	})
	if err != nil {
		return nil, err
	}
	s.setupTokenHash = ""
	_ = os.Remove(filepath.Join(s.DataDir, setupTokenFile))
	return admin, nil
}

// LoginResult is returned on successful login.
type LoginResult struct {
	Admin     *db.Admin
	Session   *db.Session
	Token     string
	CSRFToken string
}

// Login verifies credentials and creates a session.
func (s *Service) Login(ctx context.Context, username, password, ip, userAgent string) (*LoginResult, error) {
	started := s.now()
	if until := s.ipLockedUntil(ip, started); !until.IsZero() {
		return nil, rateLimited(until, started)
	}
	fail := func(adminID string, err error) error {
		s.recordAudit(ctx, nil, audit.Event{Actor: audit.Actor{ID: adminID, Name: username, ClientIP: ip},
			Action: "auth.login", ResourceType: "admin", ResourceID: adminID, ResourceName: username, Err: err, Started: started})
		return err
	}
	a, err := db.GetAdminByUsername(ctx, s.DB.Reader, username)
	if errors.Is(err, db.ErrNotFound) {
		crypto.VerifyDummy(password)
		s.ipFailure(ip, started)
		return nil, fail("", ErrInvalidCredentials)
	}
	if err != nil {
		return nil, err
	}
	if a.LockedUntil.After(started) {
		return nil, fail(a.ID, rateLimited(a.LockedUntil, started))
	}
	ok, err := crypto.VerifyPassword(password, a.PasswordHash)
	if err != nil {
		return nil, err
	}
	if !ok || a.Disabled {
		if !ok {
			attempts := a.FailedAttempts + 1
			var until time.Time
			if attempts >= LockThreshold {
				until = started.Add(backoff(attempts))
			}
			if err := db.RecordLoginFailure(ctx, s.DB.Writer, a.ID, attempts, until, started); err != nil {
				return nil, err
			}
		}
		s.ipFailure(ip, started)
		return nil, fail(a.ID, ErrInvalidCredentials)
	}
	s.ipSuccess(ip)
	tok, err := crypto.RandomToken(32)
	if err != nil {
		return nil, err
	}
	csrf := s.CSRFToken(tok)
	ttl := time.Duration(db.IntSetting(ctx, s.DB.Reader, SettingSessionTTLHours, DefaultSessionTTLHours)) * time.Hour
	sess := &db.Session{ID: db.NewID(), AdminID: a.ID, TokenHash: crypto.SHA256Hex(tok), CSRFTokenHash: crypto.SHA256Hex(csrf),
		ClientIP: ip, UserAgent: truncate(userAgent, 256), CreatedAt: started, LastSeenAt: started, ExpiresAt: started.Add(ttl)}
	err = s.DB.WithTx(ctx, func(tx *sql.Tx) error {
		if err := db.RecordLoginSuccess(ctx, tx, a.ID, started); err != nil {
			return err
		}
		if err := db.InsertSession(ctx, tx, sess); err != nil {
			return err
		}
		return s.Audit.Record(ctx, tx, audit.Event{Actor: audit.Actor{ID: a.ID, Name: a.Username, ClientIP: ip},
			Action: "auth.login", ResourceType: "admin", ResourceID: a.ID, ResourceName: a.Username,
			Summary: map[string]any{"session_id": sess.ID}, Started: started})
	})
	if err != nil {
		return nil, err
	}
	return &LoginResult{Admin: a, Session: sess, Token: tok, CSRFToken: csrf}, nil
}

// CSRFToken derives the CSRF token bound to a session token.
func (s *Service) CSRFToken(sessionToken string) string {
	return crypto.HMACToken(s.Keys.Subkey("csrf"), sessionToken)
}

// VerifyCSRF compares a submitted CSRF token with the session's stored hash.
func VerifyCSRF(sess *db.Session, provided string) bool {
	if provided == "" {
		return false
	}
	return subtle.ConstantTimeCompare([]byte(crypto.SHA256Hex(provided)), []byte(sess.CSRFTokenHash)) == 1
}

// Authenticate resolves a session cookie token to a principal.
func (s *Service) Authenticate(ctx context.Context, token string) (*Principal, error) {
	if token == "" {
		return nil, ErrUnauthenticated
	}
	sess, err := db.GetSessionByTokenHash(ctx, s.DB.Reader, crypto.SHA256Hex(token))
	if errors.Is(err, db.ErrNotFound) {
		return nil, ErrUnauthenticated
	}
	if err != nil {
		return nil, err
	}
	now := s.now()
	idle := time.Duration(db.IntSetting(ctx, s.DB.Reader, SettingSessionIdleMinute, DefaultSessionIdleMinute)) * time.Minute
	if !now.Before(sess.ExpiresAt) || now.Sub(sess.LastSeenAt) >= idle {
		s.dropSessions(ctx, sess.ID)
		return nil, ErrUnauthenticated
	}
	a, err := db.GetAdmin(ctx, s.DB.Reader, sess.AdminID)
	if errors.Is(err, db.ErrNotFound) {
		return nil, ErrUnauthenticated
	}
	if err != nil {
		return nil, err
	}
	if a.Disabled {
		s.dropSessions(ctx, sess.ID)
		return nil, ErrUnauthenticated
	}
	if now.Sub(sess.LastSeenAt) >= sessionTouch {
		if err := db.TouchSession(ctx, s.DB.Writer, sess.ID, now); err == nil {
			sess.LastSeenAt = now
		}
	}
	return &Principal{Admin: a, Session: sess}, nil
}

// Logout deletes the current session.
func (s *Service) Logout(ctx context.Context, p *Principal, ip string) error {
	err := s.DB.WithTx(ctx, func(tx *sql.Tx) error {
		if err := db.DeleteSession(ctx, tx, p.Session.ID); err != nil {
			return err
		}
		return s.Audit.Record(ctx, tx, audit.Event{Actor: p.Actor(ip), Action: "auth.logout",
			ResourceType: "session", ResourceID: p.Session.ID, ResourceName: p.Admin.Username})
	})
	if err == nil {
		s.Revocations.Revoke(p.Session.ID)
	}
	return err
}

// ChangePassword changes the caller's own password and revokes their other sessions.
func (s *Service) ChangePassword(ctx context.Context, p *Principal, current, next, ip string) error {
	if err := s.verifyActorPassword(p, current); err != nil {
		return err
	}
	if err := validatePassword(next); err != nil {
		return err
	}
	hash, err := crypto.HashPassword(next)
	if err != nil {
		return err
	}
	var revoked []string
	err = s.DB.WithTx(ctx, func(tx *sql.Tx) error {
		if err := db.UpdateAdminPassword(ctx, tx, p.Admin.ID, hash, s.now()); err != nil {
			return err
		}
		ids, err := db.DeleteSessionsOfAdmin(ctx, tx, p.Admin.ID, p.Session.ID)
		if err != nil {
			return err
		}
		revoked = ids
		return s.Audit.Record(ctx, tx, audit.Event{Actor: p.Actor(ip), Action: "auth.password_change",
			ResourceType: "admin", ResourceID: p.Admin.ID, ResourceName: p.Admin.Username,
			Summary: map[string]any{"revoked_sessions": len(ids)}})
	})
	if err == nil {
		s.Revocations.Revoke(revoked...)
	}
	return err
}

// ListSessions returns the caller's sessions, or all sessions for admins when all is true.
func (s *Service) ListSessions(ctx context.Context, p *Principal, all bool) ([]*db.Session, error) {
	if all {
		if !p.IsAdmin() {
			return nil, ErrForbidden
		}
		return db.ListSessions(ctx, s.DB.Reader, "")
	}
	return db.ListSessions(ctx, s.DB.Reader, p.Admin.ID)
}

// RevokeSession deletes a session owned by the caller (admins may revoke any).
func (s *Service) RevokeSession(ctx context.Context, p *Principal, id, ip string) error {
	sess, err := db.GetSession(ctx, s.DB.Reader, id)
	if errors.Is(err, db.ErrNotFound) {
		return ErrNotFound
	}
	if err != nil {
		return err
	}
	if sess.AdminID != p.Admin.ID && !p.IsAdmin() {
		return ErrNotFound
	}
	err = s.DB.WithTx(ctx, func(tx *sql.Tx) error {
		if err := db.DeleteSession(ctx, tx, id); err != nil {
			return err
		}
		return s.Audit.Record(ctx, tx, audit.Event{Actor: p.Actor(ip), Action: "auth.session_revoke",
			ResourceType: "session", ResourceID: id, Summary: map[string]any{"session_admin_id": sess.AdminID}})
	})
	if err == nil {
		s.Revocations.Revoke(id)
	}
	return err
}

// CleanupExpiredSessions removes expired sessions and notifies listeners.
func (s *Service) CleanupExpiredSessions(ctx context.Context) error {
	now := s.now()
	idle := time.Duration(db.IntSetting(ctx, s.DB.Reader, SettingSessionIdleMinute, DefaultSessionIdleMinute)) * time.Minute
	sessions, err := db.ListSessions(ctx, s.DB.Reader, "")
	if err != nil {
		return err
	}
	var expired []string
	for _, sess := range sessions {
		if !now.Before(sess.ExpiresAt) || now.Sub(sess.LastSeenAt) >= idle {
			expired = append(expired, sess.ID)
		}
	}
	if len(expired) == 0 {
		return nil
	}
	s.dropSessions(ctx, expired...)
	return nil
}

func (s *Service) dropSessions(ctx context.Context, ids ...string) {
	for _, id := range ids {
		_ = db.DeleteSession(ctx, s.DB.Writer, id)
	}
	s.Revocations.Revoke(ids...)
}

func (s *Service) verifyActorPassword(p *Principal, current string) error {
	ok, err := crypto.VerifyPassword(current, p.Admin.PasswordHash)
	if err != nil {
		return err
	}
	if !ok {
		return ErrWrongPassword
	}
	return nil
}

func (s *Service) recordAudit(ctx context.Context, q db.Querier, ev audit.Event) {
	_ = s.Audit.Record(ctx, q, ev)
}

func (s *Service) ipLockedUntil(ip string, now time.Time) time.Time {
	s.ipMu.Lock()
	defer s.ipMu.Unlock()
	if st, ok := s.ipFailures[ip]; ok && st.lockedUntil.After(now) {
		return st.lockedUntil
	}
	return time.Time{}
}

func (s *Service) ipFailure(ip string, now time.Time) {
	s.ipMu.Lock()
	defer s.ipMu.Unlock()
	// Prune stale entries to bound memory.
	if len(s.ipFailures) > 10000 {
		for k, st := range s.ipFailures {
			if now.Sub(st.last) > 24*time.Hour {
				delete(s.ipFailures, k)
			}
		}
	}
	st := s.ipFailures[ip]
	if st == nil {
		st = &ipState{}
		s.ipFailures[ip] = st
	}
	st.failures++
	st.last = now
	if st.failures >= LockThreshold {
		st.lockedUntil = now.Add(backoff(st.failures))
	}
}

func (s *Service) ipSuccess(ip string) {
	s.ipMu.Lock()
	delete(s.ipFailures, ip)
	s.ipMu.Unlock()
}

// backoff returns the lock duration after n consecutive failures (n >= threshold):
// 1, 2, 4, ... minutes, capped at one hour.
func backoff(n int) time.Duration {
	shift := n - LockThreshold
	if shift > 6 {
		shift = 6
	}
	d := time.Minute << shift
	if d > time.Hour {
		d = time.Hour
	}
	return d
}

func validateUsername(u string) error {
	if !usernameRE.MatchString(u) {
		return validationErr("用户名需为 3～64 位字母、数字、点、下划线或连字符，且以字母或数字开头")
	}
	return nil
}

func validatePassword(p string) error {
	n := utf8.RuneCountInString(p)
	if n < 10 || n > 128 {
		return validationErr("密码长度需为 10～128 个字符")
	}
	if strings.TrimSpace(p) == "" {
		return validationErr("密码不能为空白")
	}
	return nil
}

func validateRole(r string) error {
	if r != db.RoleAdmin && r != db.RoleViewer {
		return validationErr("角色只能是 admin 或 viewer")
	}
	return nil
}

func truncate(s string, n int) string {
	if len(s) <= n {
		return s
	}
	return s[:n]
}

// ClearIPLockouts drops all in-memory per-IP login failure state.
func (s *Service) ClearIPLockouts() {
	s.ipMu.Lock()
	s.ipFailures = map[string]*ipState{}
	s.ipMu.Unlock()
}

// VerifyPassword performs a second verification of the caller's password.
func (s *Service) VerifyPassword(p *Principal, current string) error {
	return s.verifyActorPassword(p, current)
}
