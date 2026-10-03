# Bridge Workflows: Long Tasks, PCB Autorouting, and Part Lookup

Practical notes for driving EasyEDA Pro through the bridge (`POST /execute`). Collected from the official
[easyeda](https://github.com/easyeda) repositories listed under **Sources** at the end.

## 1. Long-running calls: pass `timeout`

The bridge rejects a request after **30 s** by default. That is too short for autorouting, DSN export of large
boards, DRC, or batch edits. Pass a per-request `timeout` in milliseconds (max `1800000`, the same limit as the
official `easyeda-pro invoke --timeout`):

```bash
curl -X POST http://localhost:${BRIDGE_PORT:-49620}/execute \
  -H "Content-Type: application/json" \
  -d '{"code": "return await eda.pcb_Document.autoRouting();", "timeout": 600000}'
```

The WebSocket agent protocol accepts the same field: `{ "type": "execute", "id": "...", "code": "...", "timeout": 600000 }`.

A bridge timeout does **not** stop the code inside EDA. If a request times out, the operation may still finish
in the editor; check the document state before retrying, or you may run the operation twice.

## 2. PCB autorouting

### Option A: built-in autorouter (`PCB_Document.autoRouting`)

Beta API (the reference says it was added in EDA v3.2.150). Check that the user's client has it:

```javascript
return {
  version: eda.sys_Environment.getEditorCurrentVersion(),
  hasAutoRouting: typeof eda.pcb_Document.autoRouting === 'function',
};
```

Then run it with a long `timeout` (see §1):

```javascript
// All unrouted nets
const result = await eda.pcb_Document.autoRouting();
// result: { success, totalNetsCount, successNetsCount, failedNets, duration }
return result;
```

To limit the nets, the property is **`RoutingNets`** (see `references/interfaces/IPCB_AutoRoutingProps.md`;
the `nets:` key in the `PCB_Document.autoRouting` example is not a documented property):

```javascript
return await eda.pcb_Document.autoRouting({ RoutingNets: ['VCC', 'GND'], ignoreNets: ['NC'] });
```

Afterwards, confirm with DRC: `await eda.pcb_Drc.check(true, false, false)` returns `true` when everything passes.

### Option B: Freerouting via `scripts/freerouting-autoroute.mjs`

Use this when `autoRouting` is missing in the user's client, fails, or gives poor results. It follows the official
`eext-freerouting-intergration` extension, but moves every file across the bridge as **Base64 text**, so the AI
never needs to hand EDA a `File` object:

1. In EDA: `pcb_ManufactureData.getDsnFile()` → Base64 string returned to the script.
2. On the local machine: Freerouting REST API (`http://127.0.0.1:37864/v1`) routes the DSN.
3. In EDA: the SES Base64 is embedded in the code, rebuilt with `new File([...])`, and imported with
   `pcb_Document.importAutoRouteSesFile(file)`.

Requirements: Freerouting V2.2.3+ installed and started in API mode:

```bash
freerouting --gui.enabled=false --api_server.enabled=true \
  --api_server.endpoints=http://127.0.0.1:37864 \
  --api_server.authentication.enabled=false
# macOS app bundle: /Applications/freerouting.app/Contents/MacOS/freerouting <same flags>
```

Run (with the PCB document active in EDA):

```bash
node ${CLAUDE_SKILL_DIR}/scripts/freerouting-autoroute.mjs --passes 50 --timeout 600 --drc
# Route only and save the result without touching the board:
node ${CLAUDE_SKILL_DIR}/scripts/freerouting-autoroute.mjs --no-import --out result.ses
```

| Flag | Default | Meaning |
|------|---------|---------|
| `--passes` | `50` | Freerouting `max_passes` |
| `--timeout` | `600` | Max routing time in seconds; the job is cancelled after this |
| `--drc` | off | Run `pcb_Drc.check` after import |
| `--no-import` | off | Do not import into EDA |
| `--out <file>` | none | Also save the SES file locally |
| `--bridge <url>` | auto-detect 49620-49629 | Bridge base URL |
| `--freerouting <url>` | `http://127.0.0.1:37864/v1` | Freerouting API base URL |

**Before importing**, the script deletes every **unlocked** track, arc track and via on the PCB, as the official
extension does: the SES already contains the tracks that were in the DSN, so keeping them would duplicate them.
Lock tracks you want to keep, or back up the project first, and tell the user before running it.

The same text-only trick works for any other `File`-based import API: build the file inside EDA code with
`new File([bytes], 'name.ext')` from a Base64 or plain-text string literal.

## 3. Part lookup by LCSC number

- **No extension API returns stock or price.** `lib_Device.getByLcscIds()` and `lib_Device.search()` return library
  data only (name, symbol, footprint, `otherProperty`, …; see `ILIB_DeviceSearchItem`). Do not loop over
  APIs trying to find inventory; tell the user stock has to be checked on LCSC/JLCPCB.
- **Query in one batched call**, not one call per part: `await eda.lib_Device.getByLcscIds(['C1523', 'C17168'], undefined, true)`.
  Keep batches to about 20-25 parts per request (the limit the official CLI guide recommends).
- **Always treat the result as an array.** The official `eext-ai-device-standardization` extension notes that
  `getByLcscIds` returns an array even for a single string argument.
- **Put a timeout inside the EDA code** so a stuck library request returns an error instead of leaving the
  extension waiting (the bridge timeout cannot cancel code that is already running in EDA):

```javascript
const withTimeout = (p, ms, label) => Promise.race([
  p,
  new Promise((_, reject) => setTimeout(() => reject(new Error(`${label} timed out after ${ms}ms`)), ms)),
]);
const ids = ['C1523', 'C17168'];
const found = await withTimeout(eda.lib_Device.getByLcscIds(ids, undefined, true), 15000, 'getByLcscIds');
return (Array.isArray(found) ? found : [found]).filter(Boolean).map((d) => ({
  name: d.name, uuid: d.uuid, libraryUuid: d.libraryUuid, footprint: d.footprintName,
  supplierPart: d.otherProperty?.['Supplier Part'],
}));
```

- `otherProperty` keys are English (`"Supplier Part"`, `"Manufacturer"`), per the official
  `easyeda-enhanced-schematic-skill`.

## Sources

| Item | Official repository |
|------|---------------------|
| Per-request timeout, 1800000 ms ceiling, batches of 20-25 | [easyeda/easyeda-client-cli](https://github.com/easyeda/easyeda-client-cli) (`cli-for-ai.md`) |
| Freerouting REST flow, DSN/SES Base64 handling, delete-then-import | [easyeda/eext-freerouting-intergration](https://github.com/easyeda/eext-freerouting-intergration) |
| Gateway executes code with `AsyncFunction` and has no execution timeout | [easyeda/eext-run-api-gateway](https://github.com/easyeda/eext-run-api-gateway) (`src/index.ts`) |
| `getByLcscIds` returns an array; `withTimeout` pattern | [easyeda/eext-ai-device-standardization](https://github.com/easyeda/eext-ai-device-standardization) |
| Batched `getByLcscIds`, English `otherProperty` keys | [easyeda/easyeda-enhanced-schematic-skill](https://github.com/easyeda/easyeda-enhanced-schematic-skill) |
