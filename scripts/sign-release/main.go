// Command sign-release generates Ed25519 release signing keypairs and signs
// or verifies SHA256SUMS files for NomadDeck releases.
package main

import (
	"crypto/ed25519"
	"crypto/rand"
	"encoding/base64"
	"errors"
	"flag"
	"fmt"
	"os"
	"strings"
)

func main() {
	if err := run(os.Args[1:]); err != nil {
		fmt.Fprintln(os.Stderr, "error:", err)
		os.Exit(1)
	}
}

func run(args []string) error {
	fs := flag.NewFlagSet("sign-release", flag.ContinueOnError)
	keygen := fs.Bool("keygen", false, "generate a new Ed25519 keypair")
	signFile := fs.String("sign", "", "file to sign (writes <file>.sig)")
	verifyFile := fs.String("verify", "", "file to verify against <file>.sig")
	pubKey := fs.String("pub", "", "base64 Ed25519 public key (defaults to RELEASE_PUBLIC_KEY)")
	if err := fs.Parse(args); err != nil {
		return err
	}

	if *keygen {
		pub, priv, err := ed25519.GenerateKey(rand.Reader)
		if err != nil {
			return err
		}
		fmt.Printf("RELEASE_PUBLIC_KEY=%s\n", base64.StdEncoding.EncodeToString(pub))
		fmt.Printf("RELEASE_SIGNING_PRIVATE_KEY=%s\n", base64.StdEncoding.EncodeToString(priv))
		return nil
	}

	if *signFile != "" {
		privRaw := strings.TrimSpace(os.Getenv("RELEASE_SIGNING_PRIVATE_KEY"))
		if privRaw == "" {
			return errors.New("RELEASE_SIGNING_PRIVATE_KEY is required")
		}
		privBytes, err := base64.StdEncoding.DecodeString(privRaw)
		if err != nil || len(privBytes) != ed25519.PrivateKeySize {
			return errors.New("invalid RELEASE_SIGNING_PRIVATE_KEY (expected base64 64-byte Ed25519 private key)")
		}
		data, err := os.ReadFile(*signFile)
		if err != nil {
			return err
		}
		sig := ed25519.Sign(ed25519.PrivateKey(privBytes), data)
		return os.WriteFile(*signFile+".sig", []byte(base64.StdEncoding.EncodeToString(sig)+"\n"), 0o644)
	}

	if *verifyFile != "" {
		pk := *pubKey
		if pk == "" {
			pk = os.Getenv("RELEASE_PUBLIC_KEY")
		}
		pubBytes, err := base64.StdEncoding.DecodeString(strings.TrimSpace(pk))
		if err != nil || len(pubBytes) != ed25519.PublicKeySize {
			return errors.New("invalid public key")
		}
		data, err := os.ReadFile(*verifyFile)
		if err != nil {
			return err
		}
		sigRaw, err := os.ReadFile(*verifyFile + ".sig")
		if err != nil {
			return err
		}
		sig, err := base64.StdEncoding.DecodeString(strings.TrimSpace(string(sigRaw)))
		if err != nil || len(sig) != ed25519.SignatureSize {
			return errors.New("invalid signature")
		}
		if !ed25519.Verify(ed25519.PublicKey(pubBytes), data, sig) {
			return errors.New("signature verification failed")
		}
		return nil
	}

	return errors.New("specify -keygen, -sign <file>, or -verify <file>")
}
