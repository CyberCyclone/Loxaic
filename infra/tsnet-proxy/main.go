// Command tsnet-proxy is a small sidecar the desktop app spawns. It joins the
// user's tailnet as its own node (userspace WireGuard via tsnet — no OS VPN,
// no system-wide tunnel, no per-app-VPN entitlement) so that neither end of a
// Loxaic connection needs the standalone Tailscale app installed.
//
// It runs in one of two directions:
//
//   - client (the default): listens on a local port and reverse-proxies it to
//     one tailnet target. The renderer points its API base URL at that local
//     port, so REST and WebSocket traffic both reach a remote Loxaic over the
//     tailnet.
//
//   - serve: the mirror image, for a machine that *is* the Loxaic host.
//     Listens on the tailnet (:443, with an automatic HTTPS certificate) and
//     reverse-proxies inbound requests to the local server. With --funnel the
//     same listener is also published to the public internet through
//     Tailscale's relays, which is how a host reaches phones and browsers that
//     are not on the tailnet at all.
//
// State (the node's tailnet identity/keys) persists under --state-dir across
// runs, so login is only needed once, and the two directions must not share a
// directory: they are two different nodes. On first run tsnet has no stored
// auth and blocks in Up() until the node is approved, either non-interactively
// with an auth key (--auth-key-stdin) or by a person opening the auth URL —
// which is re-emitted on a distinguished stdout line so the parent process can
// open it in a browser.
//
// Everything the parent process needs to know arrives on stdout as a line with
// a leading keyword: AUTH_URL, LISTENING (client), SERVING (serve), STATUS.
// Everything else goes to stderr.
package main

import (
	"context"
	"encoding/json"
	"errors"
	"flag"
	"fmt"
	"io"
	"log"
	"net"
	"net/http"
	"net/http/httputil"
	"net/url"
	"os"
	"os/signal"
	"path/filepath"
	"regexp"
	"strings"
	"sync"
	"syscall"
	"time"

	"tailscale.com/tsnet"
)

// Modes this sidecar can run in. Client is the default so that an older
// caller, which passes only --target, keeps working unchanged.
const (
	modeClient = "client"
	modeServe  = "serve"
)

// Funnel is only offered on the ports Tailscale actually relays. Anything
// else is refused up front rather than failing inside ListenFunnel with a
// message about "the standard way to create funnel".
var funnelPorts = []string{":443", ":8443", ":10000"}

/*
authURLPattern recognises the interactive login URL in a log line.

Deliberately not pinned to login.tailscale.com any more: a self-hosted control
plane (Headscale) issues its own, and hard-coding Tailscale's host is what made
--control-url useless before it existed. Both known shapes are matched — /a/ is
Tailscale's, /register/ is Headscale's — which keeps this far away from "any
https:// URL in any log line", since these logs carry plenty of URLs that must
never be opened in someone's browser.
*/
var authURLPattern = regexp.MustCompile(`https://\S+/(?:a|register)/\S+`)

// findAuthURL returns the interactive auth URL in a log line, or "".
func findAuthURL(line string) string {
	return strings.TrimSpace(authURLPattern.FindString(line))
}

// config is everything the flags resolve to, separated from main() so the
// parsing and validation can be tested without joining a tailnet.
type config struct {
	mode         string
	target       string // client mode: tailnet host:port to proxy to
	listen       string // client mode: local address to listen on
	upstream     string // serve mode: local URL to proxy inbound requests to
	funnel       bool   // serve mode: also publish to the public internet
	funnelAddr   string // serve mode: tailnet address to listen on
	stateDir     string
	hostname     string
	controlURL   string
	useTLS       bool // client mode: dial the target over TLS
	authKeyStdin bool
}

// parseConfig turns argv into a validated config. It returns an error rather
// than exiting so that the failure modes are testable; main() is what decides
// a bad flag is fatal.
func parseConfig(args []string) (*config, error) {
	fs := flag.NewFlagSet("tsnet-proxy", flag.ContinueOnError)
	fs.SetOutput(io.Discard)

	cfg := &config{}
	fs.StringVar(&cfg.mode, "mode", modeClient, "client (proxy a local port to a tailnet target) or serve (publish the local server on the tailnet)")
	fs.StringVar(&cfg.target, "target", "", "client mode: tailnet host:port of the Loxaic server, e.g. myserver.tailnet-name.ts.net:443")
	fs.StringVar(&cfg.listen, "listen", "127.0.0.1:0", "client mode: local address to listen on (port 0 = pick any free port)")
	fs.StringVar(&cfg.upstream, "upstream", "", "serve mode: local base URL to forward inbound requests to, e.g. http://127.0.0.1:4100")
	fs.BoolVar(&cfg.funnel, "funnel", false, "serve mode: publish on the public internet through Tailscale Funnel as well as the tailnet")
	fs.StringVar(&cfg.funnelAddr, "serve-addr", ":443", "serve mode: tailnet address to listen on (:443, :8443 or :10000 when --funnel is set)")
	fs.StringVar(&cfg.stateDir, "state-dir", "", "directory to persist this node's tailnet state; defaults to the OS user config dir")
	fs.StringVar(&cfg.hostname, "hostname", "loxaic-desktop", "hostname this node advertises on the tailnet")
	fs.StringVar(&cfg.controlURL, "control-url", "", "coordination server URL; empty means Tailscale's own (set this for Headscale)")
	fs.BoolVar(&cfg.useTLS, "tls", true, "client mode: connect to the target over TLS (true for a ts.net cert via Serve; false for a plain http:// target)")
	// Never a --auth-key flag: an auth key is a credential, and argv is world
	// readable through `ps` on every platform this ships to. The parent hands
	// it over on stdin instead, the same way the executor receives its session
	// token.
	fs.BoolVar(&cfg.authKeyStdin, "auth-key-stdin", false, "read a tailnet auth key from the first line of stdin (for unattended login)")

	if err := fs.Parse(args); err != nil {
		return nil, err
	}
	if err := cfg.validate(); err != nil {
		return nil, err
	}
	return cfg, nil
}

func (c *config) validate() error {
	switch c.mode {
	case modeClient:
		if c.target == "" {
			return errors.New("--target is required in client mode (host:port of the Loxaic server)")
		}
		if c.funnel {
			return errors.New("--funnel only applies to --mode=serve")
		}
		if c.upstream != "" {
			return errors.New("--upstream only applies to --mode=serve")
		}
	case modeServe:
		if c.upstream == "" {
			return errors.New("--upstream is required in serve mode (local base URL of the Loxaic server)")
		}
		if err := validateUpstream(c.upstream); err != nil {
			return err
		}
		if c.target != "" {
			return errors.New("--target only applies to --mode=client")
		}
		if c.funnel && !contains(funnelPorts, c.funnelAddr) {
			return fmt.Errorf("--funnel supports only %s, got %q", strings.Join(funnelPorts, ", "), c.funnelAddr)
		}
	default:
		return fmt.Errorf("--mode must be %q or %q, got %q", modeClient, modeServe, c.mode)
	}
	if c.hostname == "" {
		return errors.New("--hostname must not be empty")
	}
	return nil
}

// validateUpstream rejects anything that is not a bare http(s) origin. A path
// would be silently dropped (the proxy rewrites only scheme and host, so the
// request's own path is what gets used) and a mistake there is the kind that
// surfaces as "every request 404s" much later.
func validateUpstream(raw string) error {
	// Checked before url.Parse, not after: a bare "127.0.0.1:4100" makes
	// url.Parse fail with "first path segment in URL cannot contain colon",
	// and that is the single most likely thing to be typed here — the sibling
	// --target flag takes exactly that form. Say which one this is instead.
	if !strings.HasPrefix(raw, "http://") && !strings.HasPrefix(raw, "https://") {
		return fmt.Errorf("--upstream must start with http:// or https://, got %q", raw)
	}
	parsed, err := url.Parse(raw)
	if err != nil {
		return fmt.Errorf("--upstream is not a URL: %w", err)
	}
	if parsed.Host == "" {
		return fmt.Errorf("--upstream needs a host, e.g. http://127.0.0.1:4100, got %q", raw)
	}
	if parsed.Path != "" && parsed.Path != "/" {
		return fmt.Errorf("--upstream must not include a path, got %q", raw)
	}
	return nil
}

func contains(haystack []string, needle string) bool {
	for _, s := range haystack {
		if s == needle {
			return true
		}
	}
	return false
}

// status is the STATUS stdout line's payload: what the parent process needs to
// describe this node to a person — the address others reach it on, and whether
// that address is public.
type status struct {
	Mode       string   `json:"mode"`
	Hostname   string   `json:"hostname"`
	IPs        []string `json:"ips"`
	CertDomain string   `json:"certDomain,omitempty"`
	URL        string   `json:"url,omitempty"`
	Funnel     bool     `json:"funnel"`
}

func (s status) line() string {
	encoded, err := json.Marshal(s)
	if err != nil {
		// Marshalling a struct of strings and bools cannot fail; if it somehow
		// does, an empty object keeps the line parseable rather than emitting
		// a truncated one the parent would choke on.
		return "STATUS {}"
	}
	return "STATUS " + string(encoded)
}

// readAuthKey takes the first line of r. Anything after it is ignored: the key
// is the whole message, and leaving the stream open lets the parent hold the
// pipe without this ever reading further.
func readAuthKey(r io.Reader) (string, error) {
	// Deliberately byte-at-a-time rather than bufio: a buffered reader would
	// happily pull the rest of whatever the parent has queued into its buffer,
	// and a credential is not something to hold more of than necessary.
	var key []byte
	buf := make([]byte, 1)
	for {
		n, err := r.Read(buf)
		if n > 0 {
			if buf[0] == '\n' {
				break
			}
			key = append(key, buf[0])
		}
		if err != nil {
			if errors.Is(err, io.EOF) {
				break
			}
			return "", err
		}
	}
	return strings.TrimSpace(string(key)), nil
}

func main() {
	cfg, err := parseConfig(os.Args[1:])
	if err != nil {
		log.Fatalf("tsnet-proxy: %v", err)
	}

	if cfg.stateDir == "" {
		dir, err := os.UserConfigDir()
		if err != nil {
			log.Fatalf("tsnet-proxy: resolving default state dir: %v", err)
		}
		// Serve and client are two different tailnet nodes with two different
		// identities; sharing one state directory would have them fight over
		// the same stored key.
		//
		// This default only applies to a hand-run binary — the desktop always
		// passes --state-dir. A caller that does pass one must keep client
		// mode pointed at whatever directory it used before (<userData>/tsnet),
		// or an install that has already been approved once is a brand new
		// node that has to be approved again.
		cfg.stateDir = filepath.Join(dir, "loxaic", "tsnet-"+cfg.mode)
	}
	if err := os.MkdirAll(cfg.stateDir, 0o700); err != nil {
		log.Fatalf("tsnet-proxy: creating state dir %s: %v", cfg.stateDir, err)
	}

	var authKey string
	if cfg.authKeyStdin {
		authKey, err = readAuthKey(os.Stdin)
		if err != nil {
			log.Fatalf("tsnet-proxy: reading auth key from stdin: %v", err)
		}
		if authKey == "" {
			log.Fatal("tsnet-proxy: --auth-key-stdin was set but stdin's first line was empty")
		}
	}

	srv := &tsnet.Server{
		Hostname:   cfg.hostname,
		Dir:        cfg.stateDir,
		AuthKey:    authKey,
		ControlURL: cfg.controlURL,
		// Both loggers are mirrored, and both are scanned for the auth URL,
		// because the two carry it in different messages at different times:
		// the backend logs `control: AuthURL is …` once, as soon as the
		// control plane issues it (this is the one that has always been
		// caught), and tsnet's own printAuthURLLoop re-logs it every few
		// seconds through UserLogf for as long as the node stays unapproved.
		// UserLogf was previously unset, which sent those repeats to the
		// default log.Printf instead — bypassing this process's stderr
		// mirroring entirely, and leaving a parent that missed the first line
		// with nothing to catch. Wiring both means a late subscriber still
		// gets an AUTH_URL, and every tsnet message is tagged and mirrored the
		// same way.
		Logf:     func(f string, a ...any) { emitLog("backend", f, a...) },
		UserLogf: func(f string, a ...any) { emitLog("tsnet", f, a...) },
	}
	defer srv.Close()

	ctx, cancel := signal.NotifyContext(context.Background(), os.Interrupt, syscall.SIGTERM)
	defer cancel()

	if _, err := srv.Up(ctx); err != nil {
		log.Fatalf("tsnet-proxy: joining tailnet: %v", err)
	}

	if cfg.mode == modeServe {
		runServe(ctx, srv, cfg)
		return
	}
	runClient(ctx, srv, cfg)
}

// runClient listens locally and forwards to one tailnet target.
func runClient(ctx context.Context, srv *tsnet.Server, cfg *config) {
	ln, err := net.Listen("tcp", cfg.listen)
	if err != nil {
		log.Fatalf("tsnet-proxy: listening on %s: %v", cfg.listen, err)
	}

	// The parent process reads stdout to learn the bound port — --listen is
	// usually 127.0.0.1:0, so the OS picks it.
	fmt.Printf("LISTENING %s\n", ln.Addr().String())
	emitStatus(srv, cfg, "")

	scheme := "http"
	if cfg.useTLS {
		scheme = "https"
	}
	target := cfg.target

	proxy := &httputil.ReverseProxy{
		Director: func(req *http.Request) {
			req.URL.Scheme = scheme
			req.URL.Host = target
			req.Host = target
		},
		Transport: &http.Transport{
			DialContext: func(dialCtx context.Context, network, _ string) (net.Conn, error) {
				return srv.Dial(dialCtx, network, target)
			},
		},
		ErrorLog: log.New(os.Stderr, "tsnet-proxy: proxy: ", log.LstdFlags),
	}

	log.Printf("tsnet-proxy: forwarding %s -> %s://%s", ln.Addr().String(), scheme, target)
	serveHTTP(ctx, ln, proxy)
}

// runServe listens on the tailnet (and optionally the public internet) and
// forwards inbound requests to the local server.
func runServe(ctx context.Context, srv *tsnet.Server, cfg *config) {
	upstream, err := url.Parse(cfg.upstream)
	if err != nil {
		// Already validated in parseConfig; this can only be a programming error.
		log.Fatalf("tsnet-proxy: parsing --upstream: %v", err)
	}

	var ln net.Listener
	if cfg.funnel {
		ln, err = srv.ListenFunnel("tcp", cfg.funnelAddr)
	} else {
		ln, err = srv.ListenTLS("tcp", cfg.funnelAddr)
	}
	if err != nil {
		// The overwhelmingly likely cause is a tailnet with MagicDNS or HTTPS
		// certificates switched off (or, for Funnel, no Funnel grant in the
		// policy file), and the raw error says so only obliquely. Say it here
		// so the desktop can put it in front of the person who can fix it.
		log.Fatalf("tsnet-proxy: listening on the tailnet at %s: %v\n"+
			"tsnet-proxy: this usually means MagicDNS and HTTPS certificates are not enabled for this tailnet"+
			funnelHint(cfg.funnel), cfg.funnelAddr, err)
	}

	// Not named `url`: that shadows the net/url package for the rest of this
	// function, which compiles today only because the one url.Parse above
	// already ran.
	served := serveURL(srv)
	if served != "" {
		fmt.Printf("SERVING %s\n", served)
	}
	emitStatus(srv, cfg, served)

	log.Printf("tsnet-proxy: serving %s -> %s", cfg.funnelAddr, cfg.upstream)
	serveHTTP(ctx, ln, newServeProxy(upstream))
}

/*
newServeProxy forwards inbound tailnet requests to the local server.

Two things are load-bearing and both are defaults, so they are easy to break
by "improving" this later:

  - The inbound Host header is left alone. What arrives is the tailnet name the
    caller actually dialled, which is also what the server is told to advertise
    (BETTER_AUTH_URL), so rewriting it to 127.0.0.1 would make sign-in cookies
    disagree with the address people are using.

  - WebSocket upgrades ride through untouched. ReverseProxy switches to a raw
    bidirectional copy when it sees a 101 response, which is the only reason
    /ws/chat works through here at all — every stream in this app is a
    WebSocket, so a proxy that only handled plain HTTP would look fine until
    the moment someone sent a message.
*/
func newServeProxy(upstream *url.URL) *httputil.ReverseProxy {
	proxy := httputil.NewSingleHostReverseProxy(upstream)
	proxy.ErrorLog = log.New(os.Stderr, "tsnet-proxy: proxy: ", log.LstdFlags)
	return proxy
}

func funnelHint(funnel bool) string {
	if !funnel {
		return ""
	}
	return ", or that this tailnet's policy file does not grant Funnel to this node"
}

// serveURL is the https:// address other machines should use, derived from the
// certificate domain tsnet holds for this node.
func serveURL(srv *tsnet.Server) string {
	domains := srv.CertDomains()
	if len(domains) == 0 {
		return ""
	}
	return "https://" + domains[0]
}

func emitStatus(srv *tsnet.Server, cfg *config, url string) {
	ip4, ip6 := srv.TailscaleIPs()
	var ips []string
	if ip4.IsValid() {
		ips = append(ips, ip4.String())
	}
	if ip6.IsValid() {
		ips = append(ips, ip6.String())
	}
	var certDomain string
	if domains := srv.CertDomains(); len(domains) > 0 {
		certDomain = domains[0]
	}
	fmt.Println(status{
		Mode:       cfg.mode,
		Hostname:   cfg.hostname,
		IPs:        ips,
		CertDomain: certDomain,
		URL:        url,
		Funnel:     cfg.funnel,
	}.line())
}

// serveHTTP runs an HTTP server over ln until ctx is cancelled, then drains.
func serveHTTP(ctx context.Context, ln net.Listener, handler http.Handler) {
	httpSrv := &http.Server{Handler: handler}
	go func() {
		<-ctx.Done()
		shutdownCtx, shutdownCancel := context.WithTimeout(context.Background(), 5*time.Second)
		defer shutdownCancel()
		_ = httpSrv.Shutdown(shutdownCtx)
	}()
	if err := httpSrv.Serve(ln); err != nil && !errors.Is(err, http.ErrServerClosed) {
		log.Fatalf("tsnet-proxy: serve: %v", err)
	}
}

// announcedAuthURL is the last auth URL put on stdout, so each distinct one is
// announced exactly once.
//
// This is not tidiness. Two loggers carry the URL and one of them repeats it
// every few seconds for as long as the node is unapproved, while the parent's
// standing reaction to an AUTH_URL line is to open a browser — so without this
// the person waiting to approve their machine gets a fresh tab every five
// seconds until they do. Keyed on the URL rather than a bool because a
// registration that expires is replaced by a genuinely new one, which does
// need announcing.
var announcedAuthURL struct {
	sync.Mutex
	url string
}

// emitLog mirrors a tsnet log line to stderr (so it lands in the parent's
// captured child-process logs) and re-emits any interactive auth URL it
// carries on a distinguished stdout line the parent greps for. Called from
// both loggers, on whichever goroutine tsnet happens to log from.
func emitLog(source, format string, args ...any) {
	line := fmt.Sprintf(format, args...)
	fmt.Fprintf(os.Stderr, "tsnet-proxy: [%s] %s\n", source, line)
	authURL := findAuthURL(line)
	if authURL == "" {
		return
	}
	announcedAuthURL.Lock()
	defer announcedAuthURL.Unlock()
	if authURL == announcedAuthURL.url {
		return
	}
	announcedAuthURL.url = authURL
	fmt.Println("AUTH_URL " + authURL)
}
