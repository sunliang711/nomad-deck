// Package auth implements first-run setup, password login, server-side
// sessions, CSRF tokens, roles and account management.
package auth

import (
	"fmt"
	"net/http"
	"time"
)

// Error is an authentication/authorization error carrying an HTTP status.
type Error struct {
	Status     int
	Code       string
	Message    string
	RetryAfter time.Duration
}

func (e *Error) Error() string { return e.Message }

func newErr(status int, code, msg string) *Error {
	return &Error{Status: status, Code: code, Message: msg}
}

// Common errors.
var (
	ErrInvalidCredentials = newErr(http.StatusUnauthorized, "invalid_credentials", "用户名或密码错误")
	ErrUnauthenticated    = newErr(http.StatusUnauthorized, "unauthenticated", "未登录或会话已失效")
	ErrInvalidSetupToken  = newErr(http.StatusUnauthorized, "invalid_setup_token", "Setup Token 无效")
	ErrAlreadySetup       = newErr(http.StatusConflict, "already_setup", "系统已完成初始化")
	ErrForbidden          = newErr(http.StatusForbidden, "forbidden", "当前账号无权执行该操作")
	ErrWrongPassword      = newErr(http.StatusForbidden, "wrong_current_password", "当前密码验证失败")
	ErrLastAdmin          = newErr(http.StatusConflict, "last_admin", "不能停用或降级最后一个启用的 admin 账号")
	ErrUsernameTaken      = newErr(http.StatusConflict, "username_taken", "用户名已存在")
	ErrNotFound           = newErr(http.StatusNotFound, "not_found", "账号或会话不存在")
)

func validationErr(format string, args ...any) *Error {
	return newErr(http.StatusBadRequest, "invalid_argument", fmt.Sprintf(format, args...))
}

func rateLimited(until, now time.Time) *Error {
	e := newErr(http.StatusTooManyRequests, "rate_limited", "登录失败次数过多，请稍后再试")
	e.RetryAfter = until.Sub(now)
	if e.RetryAfter < time.Second {
		e.RetryAfter = time.Second
	}
	return e
}
