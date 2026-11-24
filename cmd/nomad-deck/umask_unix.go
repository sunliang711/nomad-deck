//go:build unix

package main

import "syscall"

// restrictUmask makes every file the process creates (database WAL/SHM files,
// logs, certificates) private to the service user.
func restrictUmask() { syscall.Umask(0o077) }
