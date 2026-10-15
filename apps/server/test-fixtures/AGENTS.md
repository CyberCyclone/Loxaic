# apps/server/test-fixtures

Fixtures for server tests and the e2e lane: the fake llama.cpp router (`fake-llama-server.mjs`), the real `--help` it is held to, and hostile mock MCP servers. These rules cover what the fake must keep imitating and the env seams that drive it.

## Fake router fidelity

- The fake is only coverage while it is as untidy as the real router. Never make it tidier than b11342.
- Keep the ":"-name rewrite (quant uppercased, `UD-` dropped); mock HF must keep a non-canonical `UD-` quant, or the `routerModelName` path loses coverage.
- Refuse unknown preset keys like the real router (fatal at boot, 500 on reload). Its key list is tested against `LOAD_SETTINGS` plus the YaRN keys; add every new setting there.
- `--help` comes from `PRESET_KEYS` plus `keep`/`metrics`/`cont-batching`; a non-integer `keep` fails the load. `parseHelp` is held to `llama-help-b11342.txt` (real output); do not edit that file.

## Triggers by file name and prompt

- Model files named `Crashy` (fails with MTP on), `Table` (2 MiB lookup table), `Splitty` (17 graph splits on automatic GPU layers), `LostAtLoad` (device lost on first load).
- Last user message "lose the device" fails that model until it is unloaded.

## Env seams (inert unless `LOXAIC_LLAMA_SERVER_BIN` is set)

- `LOXAIC_LLAMA_SERVER_BIN` runs this fake in place of the bundled build only; a chosen version still runs as itself.
- `LOXAIC_FAKE_ROUTER_LOG`: loads and unloads as JSON lines. Assert on it (and `models.ini`), not on UI switches.
- `LOXAIC_FAKE_HARDWARE`: `gpu`, `none`, or a file holding one, re-read at every detection and by `--list-devices`. Under it the machine is fixed to `linux-x64-vulkan` (`assetKey`).
- `LOXAIC_FAKE_DEVICES`: what `--list-devices` prints.
- `LOXAIC_FAKE_MODEL_MIB` + `LOXAIC_FAKE_VRAM_STATE`: each load holds that much of the first device, loads past it fail.
- `LOXAIC_FAKE_HELP_OMIT`: one option neither listed nor accepted (an older build).
- `LOXAIC_FAKE_REJECT_KEY`: refuse a key Loxaic always writes.
- `LOXAIC_FAKE_RELOAD_FAIL` / `LOXAIC_FAKE_UNLOAD_STUCK`: while the named file exists, reloads are refused / unloads never take.
- `LOXAIC_FAKE_LOAD_MS`: make a load take time.
- Server side: `LLAMA_DISCARD_WAIT_MS` shortens discard waits; `LOXAIC_AMDGPU_PARAMS_DIR` (plus a `modinfo` file) stands in for sysfs; `LOXAIC_TEST_HTTP_BUILDS=1` allows loopback http builds.
