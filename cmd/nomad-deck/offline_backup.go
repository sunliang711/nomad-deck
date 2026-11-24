package main

import (
	"bufio"
	"encoding/json"
	"errors"
	"flag"
	"fmt"
	"io"
	"os"
	"strings"

	"golang.org/x/term"

	"nomad-deck/internal/vaultbackup"
)

// offlineBackup decrypts a Vault unseal key backup. It needs only the file
// and its passphrase: no running service, database or master key.
func offlineBackup(args []string, stdin io.Reader, stdout, stderr io.Writer) error {
	if len(args) == 0 || args[0] != "decrypt" {
		return errors.New("用法：nomad-deck offline-backup decrypt [--passphrase-stdin] <备份文件>")
	}
	fs := flag.NewFlagSet("offline-backup decrypt", flag.ContinueOnError)
	fs.SetOutput(stderr)
	fromStdin := fs.Bool("passphrase-stdin", false, "从标准输入读取备份口令")
	if err := fs.Parse(args[1:]); err != nil {
		return err
	}
	if fs.NArg() != 1 {
		return errors.New("请指定一个备份文件")
	}
	data, err := os.ReadFile(fs.Arg(0))
	if err != nil {
		return err
	}
	var pass string
	if f, ok := stdin.(*os.File); ok && !*fromStdin && term.IsTerminal(int(f.Fd())) {
		fmt.Fprint(stderr, "备份口令：")
		b, err := term.ReadPassword(int(f.Fd()))
		fmt.Fprintln(stderr)
		if err != nil {
			return err
		}
		pass = string(b)
	} else {
		line, err := bufio.NewReader(stdin).ReadString('\n')
		if err != nil && line == "" {
			return errors.New("未读取到备份口令")
		}
		pass = strings.TrimRight(line, "\r\n")
	}
	p, err := vaultbackup.Decrypt(data, pass)
	if err != nil {
		return err
	}
	fmt.Fprintf(stderr, "集群 %s（%s），当前生效第 %d 代密钥，备份时间 %s\n", p.ClusterName, p.ClusterID, p.ActiveGeneration,
		p.CreatedAt.Format("2006-01-02 15:04:05 MST"))
	fmt.Fprintln(stderr, "解封方法：在装有 Vault CLI 的机器上，对每台节点执行 vault operator unseal 并依次提交阈值数量的密钥。")
	enc := json.NewEncoder(stdout)
	enc.SetIndent("", "  ")
	return enc.Encode(p)
}
