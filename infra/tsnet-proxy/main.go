// Command tsnet-proxy is a small sidecar Electron spawns on launch. It joins
// the user's tailnet as its own node (userspace WireGuard via tsnet — no OS
// VPN, no system-wide tunnel, no per-app-VPN entitlement) and reverse-proxies
// a fixed local port to one configured tailnet target: the Open-Shannon
// server. The Electron renderer points its API base URL at that local port,
// so REST and WebSocket traffic both reach the server over the tailnet
// without the user installing the standalone Tailscale app.
//
// State (the node's tailnet identity/keys) persists under --state-dir across
// runs, so login is only needed once. On first run tsnet has no stored auth
// and blocks in Up() until the user approves the node in their Tailscale
// account; the auth URL it logs is re-emitted on a distinguished stdout line
// (see logf below) so the parent process can open it in the user's browser.
package main

import (
	"context"
	"flag"
	"fmt"
	"log"
	"net"
	"net/http"
	"net/http/httputil"
	"os"
	"os/signal"
	"path/filepath"
	"regexp"
	"strings"
	"syscall"
	"time"

	"tailscale.com/tsnet"
)

var authURLPattern = regexp.MustCompile(`https://login\.tailscale\.com/a/\S+`)

func main() {
	var (
		target   = flag.String("target", "", "tailnet host:port of the Open-Shannon server, e.g. myserver.tailnet-name.ts.net:443")
		listen   = flag.String("listen", "127.0.0.1:0", "local address to listen on (port 0 = pick any free port)")
		stateDir = flag.String("state-dir", "", "directory to persist tsnet node state; defaults to the OS user config dir")
		hostname = flag.String("hostname", "shannon-desktop", "hostname this node advertises on the tailnet")
		useTLS   = flag.Bool("tls", true, "connect to target over TLS (true for a ts.net cert via Tailscale Serve; false for a plain http:// LAN target)")
	)
	flag.Parse()

	if *target == "" {
		log.Fatal("tsnet-proxy: --target is required (host:port of the Open-Shannon server)")
	}

	if *stateDir == "" {
		dir, err := os.UserConfigDir()
		if err != nil {
			log.Fatalf("tsnet-proxy: resolving default state dir: %v", err)
		}
		*stateDir = filepath.Join(dir, "open-shannon", "tsnet")
	}
	if err := os.MkdirAll(*stateDir, 0o700); err != nil {
		log.Fatalf("tsnet-proxy: creating state dir %s: %v", *stateDir, err)
	}

	srv := &tsnet.Server{
		Hostname: *hostname,
		Dir:      *stateDir,
		Logf:     logf,
	}
	defer srv.Close()

	ctx, cancel := signal.NotifyContext(context.Background(), os.Interrupt, syscall.SIGTERM)
	defer cancel()

	if _, err := srv.Up(ctx); err != nil {
		log.Fatalf("tsnet-proxy: joining tailnet: %v", err)
	}

	ln, err := net.Listen("tcp", *listen)
	if err != nil {
		log.Fatalf("tsnet-proxy: listening on %s: %v", *listen, err)
	}

	// The parent process (Electron's main process) reads stdout to learn the
	// bound port — --listen is usually 127.0.0.1:0, so the OS picks it.
	fmt.Printf("LISTENING %s\n", ln.Addr().String())

	scheme := "http"
	if *useTLS {
		scheme = "https"
	}
	targetHost := *target

	proxy := &httputil.ReverseProxy{
		Director: func(req *http.Request) {
			req.URL.Scheme = scheme
			req.URL.Host = targetHost
			req.Host = targetHost
		},
		Transport: &http.Transport{
			DialContext: func(dialCtx context.Context, network, _ string) (net.Conn, error) {
				return srv.Dial(dialCtx, network, targetHost)
			},
		},
		ErrorLog: log.New(os.Stderr, "tsnet-proxy: proxy: ", log.LstdFlags),
	}

	httpSrv := &http.Server{Handler: proxy}
	go func() {
		<-ctx.Done()
		shutdownCtx, shutdownCancel := context.WithTimeout(context.Background(), 5*time.Second)
		defer shutdownCancel()
		_ = httpSrv.Shutdown(shutdownCtx)
	}()

	log.Printf("tsnet-proxy: forwarding %s -> %s://%s", ln.Addr().String(), scheme, targetHost)
	if err := httpSrv.Serve(ln); err != nil && err != http.ErrServerClosed {
		log.Fatalf("tsnet-proxy: serve: %v", err)
	}
}

// logf mirrors tsnet's log output to stderr (so it shows up in Electron's
// captured child-process logs for debugging) and, when it recognizes the
// first-run interactive auth URL tsnet prints, re-emits it on a distinguished
// stdout line the parent process can grep for and open in the user's browser.
func logf(format string, args ...any) {
	line := fmt.Sprintf(format, args...)
	fmt.Fprintln(os.Stderr, "tsnet-proxy: "+line)
	if m := authURLPattern.FindString(line); m != "" {
		fmt.Println("AUTH_URL " + strings.TrimSpace(m))
	}
}
