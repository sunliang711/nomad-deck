// Command nomad-deck runs the NomadDeck control plane and its local
// maintenance subcommands.
package main

import (
	"bufio"
	"context"
	"errors"
	"flag"
	"fmt"
	"io"
	"log/slog"
	"os"
	"os/signal"
	"path/filepath"
	"strings"
	"syscall"

	"golang.org/x/term"

	"nomad-deck/internal/audit"
	"nomad-deck/internal/auth"
	"nomad-deck/internal/config"
	"nomad-deck/internal/crypto"
	"nomad-deck/internal/db"
	"nomad-deck/internal/server"
	"nomad-deck/internal/version"
)

const usage = `用法：
  nomad-deck [serve] [--config 路径] [--data-dir 目录] [--listen 地址]
  nomad-deck admin reset-password --username 用户名 [--password-stdin] [--config 路径] [--data-dir 目录]
  nomad-deck offline-backup decrypt [--passphrase-stdin] <备份文件>
  nomad-deck rollback --check | --auto | --to-backup <文件> [--yes] [--config 路径] [--data-dir 目录] [--bin-dir 目录]
  nomad-deck version
`

func main() {
	restrictUmask()
	if err := run(os.Args[1:]); err != nil {
		var ee *server.ExitError
		if errors.As(err, &ee) {
			if ee.Err != nil {
				fmt.Fprintln(os.Stderr, "错误：", ee.Err)
			}
			os.Exit(ee.Code)
		}
		fmt.Fprintln(os.Stderr, "错误：", err)
		os.Exit(1)
	}
}

func run(args []string) error {
	cmd := "serve"
	if len(args) > 0 && !strings.HasPrefix(args[0], "-") {
		cmd, args = args[0], args[1:]
	}
	switch cmd {
	case "serve":
		return serve(args)
	case "version", "--version", "-version":
		fmt.Println("nomad-deck", version.String())
		return nil
	case "admin":
		if len(args) == 0 || args[0] != "reset-password" {
			return errors.New("未知的 admin 子命令\n" + usage)
		}
		return resetPassword(args[1:])
	case "offline-backup":
		return offlineBackup(args, os.Stdin, os.Stdout, os.Stderr)
	case "rollback":
		return rollbackCmd(args, os.Stdin, os.Stdout)
	case "help", "-h", "--help":
		fmt.Print(usage)
		return nil
	default:
		return fmt.Errorf("未知命令 %q\n%s", cmd, usage)
	}
}

type commonFlags struct {
	config  string
	dataDir string
	listen  string
}

func (c *commonFlags) register(fs *flag.FlagSet, withListen bool) {
	fs.StringVar(&c.config, "config", config.DefaultConfigPath, "启动配置文件路径")
	fs.StringVar(&c.dataDir, "data-dir", "", "数据目录（覆盖配置）")
	if withListen {
		fs.StringVar(&c.listen, "listen", "", "监听地址（覆盖配置）")
	}
}

func (c *commonFlags) load() (config.Config, error) {
	return config.Load(c.config, os.Getenv, config.Overrides{DataDir: c.dataDir, Listen: c.listen})
}

func newLogger(cfg config.Config) *slog.Logger {
	var level slog.Level
	_ = level.UnmarshalText([]byte(cfg.Log.Level))
	opts := &slog.HandlerOptions{Level: level}
	if cfg.Log.Format == "json" {
		return slog.New(slog.NewJSONHandler(os.Stderr, opts))
	}
	return slog.New(slog.NewTextHandler(os.Stderr, opts))
}

func serve(args []string) error {
	fs := flag.NewFlagSet("serve", flag.ContinueOnError)
	var cf commonFlags
	cf.register(fs, true)
	if err := fs.Parse(args); err != nil {
		return err
	}
	cfg, err := cf.load()
	if err != nil {
		return err
	}
	log := newLogger(cfg)
	ctx, stop := signal.NotifyContext(context.Background(), os.Interrupt, syscall.SIGTERM)
	defer stop()
	app, err := server.Open(ctx, &cfg, log)
	if err != nil {
		return err
	}
	defer app.Close()
	return app.Run(ctx)
}

func resetPassword(args []string) error {
	fs := flag.NewFlagSet("reset-password", flag.ContinueOnError)
	var cf commonFlags
	cf.register(fs, false)
	username := fs.String("username", "", "要重置密码的用户名")
	fromStdin := fs.Bool("password-stdin", false, "从标准输入读取新密码")
	if err := fs.Parse(args); err != nil {
		return err
	}
	if *username == "" {
		return errors.New("必须指定 --username")
	}
	cfg, err := cf.load()
	if err != nil {
		return err
	}
	password, err := readNewPassword(*fromStdin)
	if err != nil {
		return err
	}
	ctx := context.Background()
	keys, err := crypto.LoadKeyring(crypto.LoadOptions{CredentialsDir: os.Getenv("CREDENTIALS_DIRECTORY"),
		Getenv: os.Getenv, DataDir: cfg.DataDir})
	if err != nil {
		return err
	}
	d, err := db.Open(ctx, filepath.Join(cfg.DataDir, server.DatabaseFile))
	if err != nil {
		return err
	}
	defer d.Close()
	log := newLogger(cfg)
	svc := auth.NewService(d, keys, &audit.Recorder{DB: d, Log: log}, log, cfg.DataDir)
	if err := svc.ResetPasswordLocal(ctx, *username, password); err != nil {
		return err
	}
	fmt.Printf("已重置 %s 的密码并解除锁定，该账号的全部会话已注销。\n", *username)
	return nil
}

func readNewPassword(fromStdin bool) (string, error) {
	if fromStdin || !term.IsTerminal(int(os.Stdin.Fd())) {
		line, err := bufio.NewReader(os.Stdin).ReadString('\n')
		if err != nil && !errors.Is(err, io.EOF) {
			return "", err
		}
		return strings.TrimRight(line, "\r\n"), nil
	}
	fmt.Fprint(os.Stderr, "新密码：")
	p1, err := term.ReadPassword(int(os.Stdin.Fd()))
	fmt.Fprintln(os.Stderr)
	if err != nil {
		return "", err
	}
	fmt.Fprint(os.Stderr, "再次输入新密码：")
	p2, err := term.ReadPassword(int(os.Stdin.Fd()))
	fmt.Fprintln(os.Stderr)
	if err != nil {
		return "", err
	}
	if string(p1) != string(p2) {
		return "", errors.New("两次输入的密码不一致")
	}
	return string(p1), nil
}
