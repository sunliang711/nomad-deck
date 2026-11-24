package auth

import (
	"context"
	"database/sql"
	"errors"
	"strings"

	"nomad-deck/internal/audit"
	"nomad-deck/internal/crypto"
	"nomad-deck/internal/db"
)

// AccountChange is a privileged account operation performed by an admin.
// CurrentPassword is the acting admin's own password (second verification).
type AccountChange struct {
	Actor           *Principal
	CurrentPassword string
	ClientIP        string
}

func (s *Service) authorizeChange(c AccountChange) error {
	if !c.Actor.IsAdmin() {
		return ErrForbidden
	}
	return s.verifyActorPassword(c.Actor, c.CurrentPassword)
}

// ListAdmins returns all accounts (admin only).
func (s *Service) ListAdmins(ctx context.Context, p *Principal) ([]*db.Admin, error) {
	if !p.IsAdmin() {
		return nil, ErrForbidden
	}
	return db.ListAdmins(ctx, s.DB.Reader)
}

// CreateAdmin creates a new account with the given role.
func (s *Service) CreateAdmin(ctx context.Context, c AccountChange, username, password, role string) (*db.Admin, error) {
	if err := s.authorizeChange(c); err != nil {
		return nil, err
	}
	if err := validateUsername(username); err != nil {
		return nil, err
	}
	if err := validatePassword(password); err != nil {
		return nil, err
	}
	if err := validateRole(role); err != nil {
		return nil, err
	}
	hash, err := crypto.HashPassword(password)
	if err != nil {
		return nil, err
	}
	now := s.now()
	a := &db.Admin{ID: db.NewID(), Username: username, PasswordHash: hash, Role: role, CreatedAt: now, UpdatedAt: now}
	err = s.DB.WithTx(ctx, func(tx *sql.Tx) error {
		if _, err := db.GetAdminByUsername(ctx, tx, username); err == nil {
			return ErrUsernameTaken
		} else if !errors.Is(err, db.ErrNotFound) {
			return err
		}
		if err := db.InsertAdmin(ctx, tx, a); err != nil {
			return err
		}
		return s.Audit.Record(ctx, tx, audit.Event{Actor: c.Actor.Actor(c.ClientIP), Action: "admin.create",
			ResourceType: "admin", ResourceID: a.ID, ResourceName: a.Username, Summary: map[string]any{"role": role}})
	})
	if err != nil {
		return nil, err
	}
	return a, nil
}

// RenameAdmin changes an account's username.
func (s *Service) RenameAdmin(ctx context.Context, c AccountChange, id, username string) (*db.Admin, error) {
	if err := s.authorizeChange(c); err != nil {
		return nil, err
	}
	if err := validateUsername(username); err != nil {
		return nil, err
	}
	var out *db.Admin
	err := s.DB.WithTx(ctx, func(tx *sql.Tx) error {
		target, err := s.loadTarget(ctx, tx, id)
		if err != nil {
			return err
		}
		if other, err := db.GetAdminByUsername(ctx, tx, username); err == nil && other.ID != id {
			return ErrUsernameTaken
		} else if err != nil && !errors.Is(err, db.ErrNotFound) {
			return err
		}
		if err := db.UpdateAdminUsername(ctx, tx, id, username, s.now()); err != nil {
			return err
		}
		target.Username = username
		out = target
		return s.Audit.Record(ctx, tx, audit.Event{Actor: c.Actor.Actor(c.ClientIP), Action: "admin.update",
			ResourceType: "admin", ResourceID: id, ResourceName: username, Summary: map[string]any{"username": username}})
	})
	return out, err
}

// ChangeRole changes an account's role and revokes all of its sessions.
func (s *Service) ChangeRole(ctx context.Context, c AccountChange, id, role string) error {
	if err := s.authorizeChange(c); err != nil {
		return err
	}
	if err := validateRole(role); err != nil {
		return err
	}
	var revoked []string
	err := s.DB.WithTx(ctx, func(tx *sql.Tx) error {
		target, err := s.loadTarget(ctx, tx, id)
		if err != nil {
			return err
		}
		if target.Role == role {
			return nil
		}
		if target.Role == db.RoleAdmin && !target.Disabled {
			if err := s.ensureNotLastAdmin(ctx, tx); err != nil {
				return err
			}
		}
		if err := db.UpdateAdminRole(ctx, tx, id, role, s.now()); err != nil {
			return err
		}
		if revoked, err = db.DeleteSessionsOfAdmin(ctx, tx, id, ""); err != nil {
			return err
		}
		return s.Audit.Record(ctx, tx, audit.Event{Actor: c.Actor.Actor(c.ClientIP), Action: "admin.role_change",
			ResourceType: "admin", ResourceID: id, ResourceName: target.Username,
			Summary: map[string]any{"from": target.Role, "to": role, "revoked_sessions": len(revoked)}})
	})
	if err == nil {
		s.Revocations.Revoke(revoked...)
	}
	return err
}

// SetDisabled enables or disables an account; disabling revokes its sessions.
func (s *Service) SetDisabled(ctx context.Context, c AccountChange, id string, disabled bool) error {
	if err := s.authorizeChange(c); err != nil {
		return err
	}
	action := "admin.enable"
	if disabled {
		action = "admin.disable"
	}
	var revoked []string
	err := s.DB.WithTx(ctx, func(tx *sql.Tx) error {
		target, err := s.loadTarget(ctx, tx, id)
		if err != nil {
			return err
		}
		if target.Disabled == disabled {
			return nil
		}
		if disabled && target.Role == db.RoleAdmin {
			if err := s.ensureNotLastAdmin(ctx, tx); err != nil {
				return err
			}
		}
		if err := db.UpdateAdminDisabled(ctx, tx, id, disabled, s.now()); err != nil {
			return err
		}
		if disabled {
			if revoked, err = db.DeleteSessionsOfAdmin(ctx, tx, id, ""); err != nil {
				return err
			}
		}
		return s.Audit.Record(ctx, tx, audit.Event{Actor: c.Actor.Actor(c.ClientIP), Action: action,
			ResourceType: "admin", ResourceID: id, ResourceName: target.Username})
	})
	if err == nil {
		s.Revocations.Revoke(revoked...)
	}
	return err
}

// ResetPassword sets another account's password and revokes its sessions
// (the actor's current session is kept when resetting their own password).
func (s *Service) ResetPassword(ctx context.Context, c AccountChange, id, password string) error {
	if err := s.authorizeChange(c); err != nil {
		return err
	}
	if err := validatePassword(password); err != nil {
		return err
	}
	hash, err := crypto.HashPassword(password)
	if err != nil {
		return err
	}
	keep := ""
	if id == c.Actor.Admin.ID {
		keep = c.Actor.Session.ID
	}
	var revoked []string
	err = s.DB.WithTx(ctx, func(tx *sql.Tx) error {
		target, err := s.loadTarget(ctx, tx, id)
		if err != nil {
			return err
		}
		if err := db.UpdateAdminPassword(ctx, tx, id, hash, s.now()); err != nil {
			return err
		}
		if revoked, err = db.DeleteSessionsOfAdmin(ctx, tx, id, keep); err != nil {
			return err
		}
		return s.Audit.Record(ctx, tx, audit.Event{Actor: c.Actor.Actor(c.ClientIP), Action: "admin.reset_password",
			ResourceType: "admin", ResourceID: id, ResourceName: target.Username,
			Summary: map[string]any{"revoked_sessions": len(revoked)}})
	})
	if err == nil {
		s.Revocations.Revoke(revoked...)
	}
	return err
}

// ResetPasswordLocal is used by the local CLI rescue command: it resets the
// password, clears lockout and deletes every session of the account.
func (s *Service) ResetPasswordLocal(ctx context.Context, username, password string) error {
	if err := validatePassword(password); err != nil {
		return err
	}
	hash, err := crypto.HashPassword(password)
	if err != nil {
		return err
	}
	return s.DB.WithTx(ctx, func(tx *sql.Tx) error {
		a, err := db.GetAdminByUsername(ctx, tx, strings.TrimSpace(username))
		if errors.Is(err, db.ErrNotFound) {
			return ErrNotFound
		}
		if err != nil {
			return err
		}
		if err := db.UpdateAdminPassword(ctx, tx, a.ID, hash, s.now()); err != nil {
			return err
		}
		ids, err := db.DeleteSessionsOfAdmin(ctx, tx, a.ID, "")
		if err != nil {
			return err
		}
		return s.Audit.Record(ctx, tx, audit.Event{Actor: audit.ActorCLI, Action: "admin.reset_password_local",
			ResourceType: "admin", ResourceID: a.ID, ResourceName: a.Username,
			Summary: map[string]any{"revoked_sessions": len(ids)}})
	})
}

func (s *Service) loadTarget(ctx context.Context, q db.Querier, id string) (*db.Admin, error) {
	a, err := db.GetAdmin(ctx, q, id)
	if errors.Is(err, db.ErrNotFound) {
		return nil, ErrNotFound
	}
	return a, err
}

func (s *Service) ensureNotLastAdmin(ctx context.Context, q db.Querier) error {
	n, err := db.CountActiveAdminRole(ctx, q)
	if err != nil {
		return err
	}
	if n <= 1 {
		return ErrLastAdmin
	}
	return nil
}
