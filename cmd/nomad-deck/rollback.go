package main

import (
	"bufio"
	"context"
	"errors"
	"flag"
	"fmt"
	"io"
	"strings"

	"nomad-deck/internal/selfupdate"
	"nomad-deck/internal/server"
)

func rollbackCmd(args []string, stdin io.Reader, stdout io.Writer) error {
	fs := flag.NewFlagSet("rollback", flag.ContinueOnError)
	var cf commonFlags
	cf.register(fs, false)
	check := fs.Bool("check", false, "检查是否满足自动回退条件")
	auto := fs.Bool("auto", false, "执行启动失败自动回退")
	toBackup := fs.String("to-backup", "", "从升级前备份恢复数据库")
	binDir := fs.String("bin-dir", "", "程序安装目录（默认取当前可执行文件所在目录）")
	yes := fs.Bool("yes", false, "跳过交互确认")
	if err := fs.Parse(args); err != nil {
		return err
	}

	modes := 0
	if *check {
		modes++
	}
	if *auto {
		modes++
	}
	if *toBackup != "" {
		modes++
	}
	if modes != 1 {
		return errors.New("请指定 --check、--auto 或 --to-backup <文件> 中的一项")
	}

	cfg, err := cf.load()
	if err != nil {
		return err
	}
	resolvedBinDir := *binDir
	if resolvedBinDir == "" {
		resolvedBinDir = selfupdate.ResolveBinDir()
	}
	ctx := context.Background()

	switch {
	case *check:
		ok, _, err := selfupdate.CheckAutoRollback(ctx, cfg.DataDir)
		if err != nil || !ok {
			return &server.ExitError{Code: 1}
		}
		return nil
	case *auto:
		if err := selfupdate.RunAutoRollback(ctx, cfg.DataDir, resolvedBinDir); err != nil {
			return err
		}
		fmt.Fprintln(stdout, "已回退到上一版本并恢复升级前数据库。")
		return nil
	case *toBackup != "":
		if !*yes {
			fmt.Fprintf(stdout, "确认使用 %s 覆盖当前控制面数据库（将丢失该备份之后的所有数据变更）？输入 yes 确认：", *toBackup)
			sc := bufio.NewScanner(stdin)
			if !sc.Scan() || strings.TrimSpace(sc.Text()) != "yes" {
				return errors.New("已取消恢复")
			}
		}
		if err := selfupdate.RunBackupRollback(ctx, cfg.DataDir, resolvedBinDir, *toBackup); err != nil {
			return err
		}
		fmt.Fprintf(stdout, "已从 %s 恢复控制面数据库。\n", *toBackup)
		return nil
	}
	return nil
}
