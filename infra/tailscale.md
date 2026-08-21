# Tailscale Setup — Open-Shannon

## Host (Docker server)

1. Install Tailscale: `curl -fsSL https://tailscale.com/install.sh | sh`
2. Authenticate: `sudo tailscale up --ssh`
3. Enable MagicDNS in the admin console (https://login.tailscale.com/admin/dns)
4. Optional: expose the web UI with TLS:
   ```bash
   sudo tailscale serve --bg https://localhost:4001
   ```
   This gives you `https://<machine-name>.<tailnet>.ts.net` automatically.

## Client devices

- **macOS / Windows / Linux**: install the Tailscale app, log in with the same account.
- **iOS / Android**: install the Tailscale app, sign in, enable "Run Tailscale" and "Use Tailscale DNS".
- **Expo dev client**: the device just needs Tailscale running; Metro connects over the tailnet IP.

## Accessing services

With MagicDNS enabled, services are reachable at:
- Server API: `http://<hostname>:4000`
- Web UI: `http://<hostname>:4001` (or `https://...` if `tailscale serve` is configured)
- Inference: `http://<hostname>:4002`

## Headscale (optional, fully self-hosted control plane)

If you want to avoid the Tailscale SaaS entirely, deploy [Headscale](https://headscale.net/)
as a drop-in replacement for the coordination server. The client setup is identical; just
point `tailscale up` at your Headscale URL with `--login-server`.
