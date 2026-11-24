package server

import (
	"net"
	"os"
)

// sdNotify sends a state string to systemd when running under Type=notify.
// It is a no-op when NOTIFY_SOCKET is not set.
func sdNotify(state string) error {
	sock := os.Getenv("NOTIFY_SOCKET")
	if sock == "" {
		return nil
	}
	addr := &net.UnixAddr{Name: sock, Net: "unixgram"}
	if sock[0] == '@' {
		addr.Name = "\x00" + sock[1:]
	}
	conn, err := net.DialUnix("unixgram", nil, addr)
	if err != nil {
		return err
	}
	defer conn.Close()
	_, err = conn.Write([]byte(state))
	return err
}
