package main

import (
	"bufio"
	"encoding/json"
	"io"
	"net"
	"net/http"
	"net/http/httptest"
	"net/url"
	"os"
	"strings"
	"testing"
	"time"
)

func TestParseConfigDefaultsToClient(t *testing.T) {
	// An older caller passes only --target. It must keep working unchanged:
	// the desktop app in the field predates --mode entirely.
	cfg, err := parseConfig([]string{"--target", "box.tail.ts.net:443"})
	if err != nil {
		t.Fatalf("parseConfig: %v", err)
	}
	if cfg.mode != modeClient {
		t.Errorf("mode = %q, want %q", cfg.mode, modeClient)
	}
	if cfg.listen != "127.0.0.1:0" {
		t.Errorf("listen = %q, want the any-free-port default", cfg.listen)
	}
	if !cfg.useTLS {
		t.Error("useTLS = false, want true (a ts.net target is served over TLS)")
	}
}

func TestParseConfigServeMode(t *testing.T) {
	cfg, err := parseConfig([]string{
		"--mode", "serve",
		"--upstream", "http://127.0.0.1:4100",
		"--hostname", "loxaic-host",
		"--funnel",
	})
	if err != nil {
		t.Fatalf("parseConfig: %v", err)
	}
	if cfg.mode != modeServe {
		t.Errorf("mode = %q, want %q", cfg.mode, modeServe)
	}
	if !cfg.funnel {
		t.Error("funnel = false, want true")
	}
	if cfg.funnelAddr != ":443" {
		t.Errorf("funnelAddr = %q, want :443", cfg.funnelAddr)
	}
}

func TestParseConfigRejections(t *testing.T) {
	cases := []struct {
		name string
		args []string
		want string // substring the message must carry
	}{
		{
			name: "client with no target",
			args: []string{},
			want: "--target is required",
		},
		{
			name: "serve with no upstream",
			args: []string{"--mode", "serve"},
			want: "--upstream is required",
		},
		{
			name: "unknown mode",
			args: []string{"--mode", "peer", "--target", "x:443"},
			want: "--mode must be",
		},
		{
			// Cross-mode flags are refused rather than ignored: silently
			// dropping --funnel would leave someone believing their host is
			// on the public internet when it is not.
			name: "funnel in client mode",
			args: []string{"--target", "x:443", "--funnel"},
			want: "--funnel only applies",
		},
		{
			name: "upstream in client mode",
			args: []string{"--target", "x:443", "--upstream", "http://127.0.0.1:4100"},
			want: "--upstream only applies",
		},
		{
			name: "target in serve mode",
			args: []string{"--mode", "serve", "--upstream", "http://127.0.0.1:4100", "--target", "x:443"},
			want: "--target only applies",
		},
		{
			// Funnel is relayed on three ports only. Catching it here beats
			// ListenFunnel's own message, which reads like documentation.
			name: "funnel on an unrelayed port",
			args: []string{"--mode", "serve", "--upstream", "http://127.0.0.1:4100", "--funnel", "--serve-addr", ":8080"},
			want: "--funnel supports only",
		},
		{
			name: "empty hostname",
			args: []string{"--target", "x:443", "--hostname", ""},
			want: "--hostname must not be empty",
		},
	}

	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			_, err := parseConfig(tc.args)
			if err == nil {
				t.Fatalf("parseConfig(%v) = nil error, want one mentioning %q", tc.args, tc.want)
			}
			if !strings.Contains(err.Error(), tc.want) {
				t.Errorf("error = %q, want it to mention %q", err, tc.want)
			}
		})
	}
}

func TestValidateUpstream(t *testing.T) {
	ok := []string{
		"http://127.0.0.1:4100",
		"https://localhost:4100",
		"http://127.0.0.1:4100/", // a bare root path is the same origin
	}
	for _, raw := range ok {
		if err := validateUpstream(raw); err != nil {
			t.Errorf("validateUpstream(%q) = %v, want nil", raw, err)
		}
	}

	bad := map[string]string{
		"127.0.0.1:4100":            "must start with http",
		"ftp://127.0.0.1:4100":      "must start with http",
		"http://":                   "needs a host",
		"http://127.0.0.1:4100/api": "must not include a path",
	}
	for raw, want := range bad {
		err := validateUpstream(raw)
		if err == nil {
			t.Errorf("validateUpstream(%q) = nil, want an error mentioning %q", raw, want)
			continue
		}
		if !strings.Contains(err.Error(), want) {
			t.Errorf("validateUpstream(%q) = %q, want it to mention %q", raw, err, want)
		}
	}
}

func TestFindAuthURL(t *testing.T) {
	// The message tsnet's own printAuthURLLoop emits.
	tailscale := "To start this tsnet server, restart with TS_AUTHKEY set, or go to: https://login.tailscale.com/a/0123456789abcdef"
	if got, want := findAuthURL(tailscale), "https://login.tailscale.com/a/0123456789abcdef"; got != want {
		t.Errorf("findAuthURL(tailscale) = %q, want %q", got, want)
	}

	// Headscale issues its own, on the operator's own domain — the whole
	// reason this is no longer pinned to login.tailscale.com.
	headscale := "or go to: https://headscale.example.com/register/nodekey:abc123"
	if got, want := findAuthURL(headscale), "https://headscale.example.com/register/nodekey:abc123"; got != want {
		t.Errorf("findAuthURL(headscale) = %q, want %q", got, want)
	}

	// Nothing else in a busy log stream may be mistaken for something to open
	// in a person's browser.
	quiet := []string{
		"control: connected to https://controlplane.tailscale.com",
		"magicsock: home is derp-2 (sfo)",
		"health(warnable=no-derp-connection): ok",
		"",
	}
	for _, line := range quiet {
		if got := findAuthURL(line); got != "" {
			t.Errorf("findAuthURL(%q) = %q, want no match", line, got)
		}
	}
}

func TestReadAuthKey(t *testing.T) {
	cases := map[string]string{
		"tskey-auth-abc123\n":                 "tskey-auth-abc123",
		"tskey-auth-abc123":                   "tskey-auth-abc123", // EOF with no newline
		"  tskey-auth-abc123  \n":             "tskey-auth-abc123",
		"tskey-auth-abc123\nnot-part-of-it\n": "tskey-auth-abc123", // first line only
		"":                                    "",
	}
	for input, want := range cases {
		got, err := readAuthKey(strings.NewReader(input))
		if err != nil {
			t.Fatalf("readAuthKey(%q): %v", input, err)
		}
		if got != want {
			t.Errorf("readAuthKey(%q) = %q, want %q", input, got, want)
		}
	}
}

func TestReadAuthKeyStopsAtFirstLine(t *testing.T) {
	// The parent keeps the pipe open after writing the key, so this must not
	// read on past the newline — and must leave the rest for nobody, rather
	// than buffering more of a credential stream than it needs.
	r := strings.NewReader("tskey-auth-abc123\nsecond line\n")
	got, err := readAuthKey(r)
	if err != nil {
		t.Fatalf("readAuthKey: %v", err)
	}
	if got != "tskey-auth-abc123" {
		t.Fatalf("key = %q", got)
	}
	rest, err := io.ReadAll(r)
	if err != nil {
		t.Fatalf("reading the rest: %v", err)
	}
	if string(rest) != "second line\n" {
		t.Errorf("rest = %q, want the unread remainder to still be there", rest)
	}
}

func TestStatusLine(t *testing.T) {
	line := status{
		Mode:       modeServe,
		Hostname:   "loxaic-host",
		IPs:        []string{"100.101.102.103", "fd7a:115c:a1e0::1"},
		CertDomain: "loxaic-host.tail1234.ts.net",
		URL:        "https://loxaic-host.tail1234.ts.net",
		Funnel:     true,
	}.line()

	payload, ok := strings.CutPrefix(line, "STATUS ")
	if !ok {
		t.Fatalf("line = %q, want a STATUS prefix", line)
	}
	// The parent parses this, so it has to be one line of valid JSON.
	if strings.ContainsAny(payload, "\n\r") {
		t.Errorf("payload spans lines: %q", payload)
	}
	var decoded status
	if err := json.Unmarshal([]byte(payload), &decoded); err != nil {
		t.Fatalf("payload is not JSON: %v (%q)", err, payload)
	}
	if decoded.URL != "https://loxaic-host.tail1234.ts.net" || !decoded.Funnel {
		t.Errorf("decoded = %+v, want the url and funnel flag to survive the round trip", decoded)
	}
	if len(decoded.IPs) != 2 {
		t.Errorf("ips = %v, want both addresses", decoded.IPs)
	}
}

func TestStatusLineOmitsEmptyAddress(t *testing.T) {
	// A client-mode node has no certificate and no served URL. Emitting empty
	// strings would have the desktop show "reachable at " with nothing after it.
	line := status{Mode: modeClient, Hostname: "loxaic-desktop"}.line()
	if strings.Contains(line, "certDomain") || strings.Contains(line, `"url"`) {
		t.Errorf("line = %q, want no empty certDomain/url keys", line)
	}
}

// upstreamFor stands up a local HTTP server that answers plain requests and
// also accepts a raw HTTP/1.1 Upgrade, echoing whatever is written after the
// switch. It stands in for the Loxaic server: REST on one side, /ws/* on the
// other.
func upstreamFor(t *testing.T) *url.URL {
	t.Helper()
	mux := http.NewServeMux()
	mux.HandleFunc("/health", func(w http.ResponseWriter, r *http.Request) {
		// Echoed back so the test can assert the Host header survived the hop.
		w.Header().Set("X-Saw-Host", r.Host)
		_, _ = io.WriteString(w, "ok")
	})
	mux.HandleFunc("/ws", func(w http.ResponseWriter, r *http.Request) {
		if !strings.EqualFold(r.Header.Get("Upgrade"), "websocket") {
			http.Error(w, "expected an upgrade", http.StatusBadRequest)
			return
		}
		hijacker, ok := w.(http.Hijacker)
		if !ok {
			http.Error(w, "not hijackable", http.StatusInternalServerError)
			return
		}
		conn, buf, err := hijacker.Hijack()
		if err != nil {
			return
		}
		defer conn.Close()
		_, _ = buf.WriteString("HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\n\r\n")
		_ = buf.Flush()
		// Echo one line, which is what proves bytes flow after the switch
		// rather than the connection being left half-open.
		line, err := buf.ReadString('\n')
		if err != nil {
			return
		}
		_, _ = buf.WriteString("echo:" + line)
		_ = buf.Flush()
	})

	server := httptest.NewServer(mux)
	t.Cleanup(server.Close)
	parsed, err := url.Parse(server.URL)
	if err != nil {
		t.Fatalf("parsing upstream URL: %v", err)
	}
	return parsed
}

func TestServeProxyForwardsHTTP(t *testing.T) {
	front := httptest.NewServer(newServeProxy(upstreamFor(t)))
	t.Cleanup(front.Close)

	res, err := front.Client().Get(front.URL + "/health")
	if err != nil {
		t.Fatalf("GET through the proxy: %v", err)
	}
	defer res.Body.Close()
	body, _ := io.ReadAll(res.Body)
	if res.StatusCode != http.StatusOK || string(body) != "ok" {
		t.Fatalf("status %d body %q, want 200 ok", res.StatusCode, body)
	}

	// The Host the caller dialled has to reach the server unchanged: it is
	// what sign-in cookies are scoped to once a tailnet name is in play.
	frontHost := strings.TrimPrefix(front.URL, "http://")
	if got := res.Header.Get("X-Saw-Host"); got != frontHost {
		t.Errorf("upstream saw Host %q, want the inbound %q", got, frontHost)
	}
}

func TestServeProxyForwardsWebSocketUpgrade(t *testing.T) {
	// Every stream in this app is a WebSocket. A proxy that handled only plain
	// HTTP would pass a health check and then fail the first message sent.
	front := httptest.NewServer(newServeProxy(upstreamFor(t)))
	t.Cleanup(front.Close)

	conn, err := net.Dial("tcp", strings.TrimPrefix(front.URL, "http://"))
	if err != nil {
		t.Fatalf("dialling the proxy: %v", err)
	}
	defer conn.Close()
	_ = conn.SetDeadline(time.Now().Add(10 * time.Second))

	_, err = io.WriteString(conn, "GET /ws HTTP/1.1\r\nHost: example.ts.net\r\nUpgrade: websocket\r\nConnection: Upgrade\r\n\r\n")
	if err != nil {
		t.Fatalf("writing the upgrade request: %v", err)
	}

	reader := bufio.NewReader(conn)
	statusLine, err := reader.ReadString('\n')
	if err != nil {
		t.Fatalf("reading the response: %v", err)
	}
	if !strings.Contains(statusLine, "101") {
		t.Fatalf("status = %q, want 101 Switching Protocols", strings.TrimSpace(statusLine))
	}
	// Drain the rest of the response headers.
	for {
		line, err := reader.ReadString('\n')
		if err != nil {
			t.Fatalf("draining headers: %v", err)
		}
		if strings.TrimSpace(line) == "" {
			break
		}
	}

	if _, err := io.WriteString(conn, "hello\n"); err != nil {
		t.Fatalf("writing after the upgrade: %v", err)
	}
	echoed, err := reader.ReadString('\n')
	if err != nil {
		t.Fatalf("reading the echo: %v", err)
	}
	if strings.TrimSpace(echoed) != "echo:hello" {
		t.Errorf("echo = %q, want %q — bytes are not flowing after the upgrade", strings.TrimSpace(echoed), "echo:hello")
	}
}

func TestEmitLogAnnouncesEachAuthURLOnce(t *testing.T) {
	// tsnet re-logs the auth URL every few seconds while a node is unapproved,
	// and the parent's standing reaction to an AUTH_URL line is to open a
	// browser. Announcing every repeat would hand someone a new tab every five
	// seconds while they were busy approving the last one.
	announcedAuthURL.Lock()
	announcedAuthURL.url = ""
	announcedAuthURL.Unlock()

	restore := captureStdout(t)
	emitLog("backend", "%s", "control: AuthURL is https://login.tailscale.com/a/aaaa1111")
	emitLog("tsnet", "or go to: %s", "https://login.tailscale.com/a/aaaa1111")
	emitLog("tsnet", "or go to: %s", "https://login.tailscale.com/a/aaaa1111")
	// A registration that expires is replaced by a genuinely different URL,
	// and that one does need announcing.
	emitLog("tsnet", "or go to: %s", "https://login.tailscale.com/a/bbbb2222")
	got := restore()

	var announced []string
	for _, line := range strings.Split(strings.TrimSpace(got), "\n") {
		if after, ok := strings.CutPrefix(line, "AUTH_URL "); ok {
			announced = append(announced, after)
		}
	}
	want := []string{
		"https://login.tailscale.com/a/aaaa1111",
		"https://login.tailscale.com/a/bbbb2222",
	}
	if len(announced) != len(want) {
		t.Fatalf("announced %v, want exactly %v", announced, want)
	}
	for i := range want {
		if announced[i] != want[i] {
			t.Errorf("announced[%d] = %q, want %q", i, announced[i], want[i])
		}
	}
}

// captureStdout redirects os.Stdout for the duration of a test; the returned
// function restores it and yields whatever was written.
func captureStdout(t *testing.T) func() string {
	t.Helper()
	r, w, err := os.Pipe()
	if err != nil {
		t.Fatalf("creating a pipe: %v", err)
	}
	saved := os.Stdout
	os.Stdout = w

	done := make(chan string, 1)
	go func() {
		var sb strings.Builder
		_, _ = io.Copy(&sb, r)
		done <- sb.String()
	}()

	return func() string {
		os.Stdout = saved
		_ = w.Close()
		out := <-done
		_ = r.Close()
		return out
	}
}
