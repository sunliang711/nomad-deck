package cron

import (
	"context"
	"errors"
	"fmt"
	"strconv"
	"strings"
	"time"
	_ "time/tzdata"

	robfig "github.com/robfig/cron/v3"
)

const (
	DefaultTimeoutSeconds = 600
	MinTimeoutSeconds     = 1
	MaxTimeoutSeconds     = 86400
)

// SchedulePreviewRequest validates an unsaved schedule draft without modifying persisted state.
type SchedulePreviewRequest struct {
	ScheduleType   string `json:"schedule_type"`
	CronExpression string `json:"cron_expression"`
	CronExpr       string `json:"cron_expr"`
	Schedule       string `json:"schedule"`
	Timezone       string `json:"timezone"`
}

func (r SchedulePreviewRequest) expr() string {
	for _, s := range []string{r.CronExpression, r.CronExpr, r.Schedule} {
		if t := strings.TrimSpace(s); t != "" {
			return t
		}
	}
	return ""
}

// InferScheduleType returns the matching preset type or "cron".
func InferScheduleType(expr string) string {
	switch strings.TrimSpace(expr) {
	case "* * * * *":
		return "every_minute"
	case "*/5 * * * *":
		return "every_5_minutes"
	case "*/10 * * * *":
		return "every_10_minutes"
	case "0 * * * *":
		return "hourly"
	case "0 0 * * *":
		return "daily"
	case "0 0 * * 1":
		return "weekly"
	case "0 0 1 * *":
		return "monthly"
	default:
		return "cron"
	}
}

func isCronNumber(value string) bool {
	if value == "" {
		return false
	}
	for _, ch := range value {
		if ch < '0' || ch > '9' {
			return false
		}
	}
	return true
}

// ValidateSchedule checks schedule_type, five-field cron expression and IANA timezone.
func ValidateSchedule(scheduleType, expression, timezone string) (robfig.Schedule, string, *time.Location, error) {
	kind := strings.TrimSpace(scheduleType)
	if kind == "" {
		kind = "cron"
	}
	if strings.Contains(expression, "TZ=") || strings.Contains(expression, "CRON_TZ=") {
		return nil, "", nil, errors.New("需为 5 段 Cron 表达式（分 时 日 月 周），时区由配置字段指定")
	}
	fields := strings.Fields(expression)
	if len(fields) != 5 {
		return nil, "", nil, errors.New("需为 5 段 Cron 表达式（分 时 日 月 周）")
	}
	validShape := false
	switch kind {
	case "every_minute":
		validShape = strings.Join(fields, " ") == "* * * * *"
	case "every_5_minutes":
		validShape = strings.Join(fields, " ") == "*/5 * * * *"
	case "every_10_minutes":
		validShape = strings.Join(fields, " ") == "*/10 * * * *"
	case "hourly":
		validShape = strings.Join(fields[1:], " ") == "* * * *" && isCronNumber(fields[0])
	case "daily":
		validShape = strings.Join(fields[2:], " ") == "* * *" && isCronNumber(fields[0]) && isCronNumber(fields[1])
	case "weekly":
		validShape = fields[2] == "*" && fields[3] == "*" && isCronNumber(fields[0]) && isCronNumber(fields[1]) && isCronNumber(fields[4])
	case "monthly":
		validShape = fields[3] == "*" && fields[4] == "*" && isCronNumber(fields[0]) && isCronNumber(fields[1]) && isCronNumber(fields[2])
	case "cron":
		validShape = true
	default:
		return nil, "", nil, fmt.Errorf("无效的计划类型 %q（可选 every_minute、every_5_minutes、every_10_minutes、hourly、daily、weekly、monthly、cron）", kind)
	}
	if !validShape {
		return nil, "", nil, errors.New("执行规则与所选时间粒度不匹配，请重新配置")
	}
	tz := strings.TrimSpace(timezone)
	if tz == "" || tz == "Local" {
		return nil, "", nil, errors.New("请填写有效的 IANA 时区，例如 Asia/Singapore、Asia/Shanghai 或 UTC")
	}
	loc, err := time.LoadLocation(tz)
	if err != nil {
		return nil, "", nil, fmt.Errorf("无效的执行时区 %q：%v", tz, err)
	}
	sch, err := parser.Parse(strings.Join(fields, " "))
	if err != nil {
		return nil, "", nil, fmt.Errorf("Cron 表达式无效：%v", err)
	}
	return sch, kind, loc, nil
}

// PreviewSchedule validates a draft and returns its next count occurrences plus resolved timezone.
func (s *Scheduler) PreviewSchedule(ctx context.Context, req SchedulePreviewRequest, count int) ([]time.Time, string, error) {
	tz := strings.TrimSpace(req.Timezone)
	if tz == "" {
		tz = s.Timezone(ctx)
	}
	sch, _, loc, err := ValidateSchedule(req.ScheduleType, req.expr(), tz)
	if err != nil {
		return nil, "", err
	}
	if count <= 0 {
		count = 5
	}
	if count > 20 {
		count = 20
	}
	cur := s.now().In(loc)
	out := make([]time.Time, 0, count)
	for i := 0; i < count; i++ {
		next := sch.Next(cur)
		if next.IsZero() {
			return nil, "", errors.New("该执行规则在未来没有有效触发时间，请修改")
		}
		out = append(out, next.UTC())
		cur = next
	}
	return out, loc.String(), nil
}

// ParseDuration parses Go durations plus day ("d") suffix (aligned with engram).
func ParseDuration(raw string) (time.Duration, error) {
	s := strings.TrimSpace(raw)
	if s == "" {
		return 0, errors.New("duration is empty")
	}
	if strings.HasSuffix(s, "d") {
		days, err := strconv.Atoi(strings.TrimSuffix(s, "d"))
		if err != nil || days <= 0 {
			return 0, fmt.Errorf("无效的天数时长 %q", raw)
		}
		return time.Duration(days) * 24 * time.Hour, nil
	}
	return time.ParseDuration(s)
}
