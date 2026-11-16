# Agentic Assistant (`agenticAssistant`)

An agentic SOC copilot widget for FortiSOAR 8.0 -- **investigate → hunt → triage
→ build**. It runs as a drawer/standalone widget on incident/alert records and
the playbook designer, streaming a chat transcript backed by the
`connector-fsr-agentic-assistant` connector: enrichment, threat hunting, response
action cards, and on-demand playbook authoring.

**Docs:** [User Guide](docs/USER_GUIDE.md) for analysts and SOC leads (investigate,
save as playbook, playbook designer, Monitor queue, autonomy) ·
[Setup & Operation Guide](docs/AGENTIC_ASSISTANT_GUIDE.md) for admins.

> This is its own git repo. It is **developed inside the FSR Widget Dev Kit**
> (the `fsr_all_widgets` harness + tooling), which clones it into `widgets-src/`.
> See the kit's `ONBOARDING.md` and `KNOWLEDGEBASE.md` first.

## Compatibility -- pin these together

The widget, its backend connector, and the wire **contract** between them are
versioned independently. A mismatch shows up as unrendered transcript events or
rejected pushes.

Versions are not pinned here on purpose -- prose drifts and nobody wants to
hand-sync a table on every bump. Read the live numbers from source instead:
widget `widget/info.json`, connector `connector-fsr-agentic-assistant/info.json` +
its `requirements.txt` pin, wire contract `WIDGET_CONTRACT_VERSION` in
`view.controller.js`.

| Component | Notes |
|-----------|-------|
| **Widget** `agenticAssistant` | controller name tracks `info.json` version (`agenticAssistant<version>DevCtrl`); `readmePins` enforces that |
| **Connector** `connector-fsr-agentic-assistant` | label "FSR Agentic Assistant"; pins `fsr-playbooks`; published & deployed separately (separate repository) |
| **Wire contract** | transcript-event + push schema the widget and connector agree on (`WIDGET_CONTRACT_VERSION` in `view.controller.js` + connector `operations.py`) |
| **Dev Kit** (`fsr_all_widgets`) | provides the harness, `make` targets, `KNOWLEDGEBASE.md`; compat per its `ONBOARDING.md` |
| **FortiSOAR** | 8.0; drawer/`enableFor` mechanics per KB §18 |

When you bump any of these, update this table **and** the kit's compatibility
matrix in `ONBOARDING.md`. `tests/readmePins.test.js` fails when a row here
disagrees with `info.json`, `WIDGET_CONTRACT_VERSION`, or (when the connector
repo is checked out beside this one) the connector's `info.json` and its
`fsr-playbooks` pin -- every row was once wrong at the same time.

## Layout

```
widget/                 the shipped widget
  info.json             name/version/title -- drives packaging
  view.html / view.controller.js
  edit.html / edit.controller.js
  remote.probe.js       remote smoke test (node widget.js verify-remote agenticAssistant)
  images/ widgetAssets/
tests/                  jest unit specs (controller logic)
tests/e2e/              playwright specs (DOM/template)
tools/render_check.cjs  render sanity helper (vocabulary in tools/render_contract.json)
docs/                   user and admin guides, workflow map
```

## Developing against the Dev Kit

This widget is **not** built in isolation -- clone the kit and let it manage the
harness:

```bash
# in the dev kit (fsr_all_widgets):
make widgets                       # clones this repo into widgets-src/ per widgets.manifest
make setup                         # one-shot: harness deps + clone widgets
make assets                        # fetch the SOAR app shell from YOUR licensed box (e2e only)

# unit tests (no box needed):
make test-unit WIDGET=agenticAssistant
# e2e (needs the SOAR shell from `make assets`):
make test-e2e-widget WIDGET=agenticAssistant

# ship to a box (runs the harness, packages, installs):
cd fortisoar-widget-harness
scripts/ship.sh agenticAssistant --bump patch
```

Never hand-start a server or run `pnpm exec playwright` directly -- go through the
`make` targets / `scripts/ship.sh` (see the kit's `CONTRIBUTING.md` and
`TESTING.md`).

The backend connector is a **separate, external dependency**: deploy
`connector-fsr-agentic-assistant` 0.5.186 (the version in the compatibility table) to the same box the widget talks to, or
transcript events won't render.

## Versioning

`info.json` is the source of truth for version + controller name. Bump only via
the `widget` CLI (`scripts/ship.sh … --bump`); never hand-edit `info.json`
version -- it desyncs the controller name and breaks harness bootstrap.
