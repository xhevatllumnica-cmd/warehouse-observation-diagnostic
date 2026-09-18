# Warehouse Observation & Diagnostic System

Mjet për Warehouse Lead-in për 30 ditët e para: vëzhgim, matje dhe diagnostikim i
operacioneve të magazinës. Parimi: **Kupto → Mat → Stabilizo → Përmirëso** — së pari
dokumentohet gjendja aktuale, pastaj jepen rekomandime.

## Përbërësit

| Dosja / skedari | Çfarë bën |
|---|---|
| `index.html`, `app.js`, `styles.css` | Aplikacioni kryesor offline (vëzhgime ditore, matje procesesh me kohë pritjeje, rrjedha e porosive/inbound, matrica e aftësive, regjistri i bottleneck-eve, KPI baseline, raporte ditore/javore/30-ditore). Të dhënat ruhen në `localStorage`. |
| `wms-agent.js`, `app.html`, `*.bat`, `*.vbs` | Agjent lokal (Node) që lexon të dhëna nga WMS me cookie-n e sesionit tënd — shih [WMS-INTEGRATION.md](WMS-INTEGRATION.md). |
| `analysis-tools/` | Gjeneron raportin "Aneks B — Analiza e të Dhënave" nga backup-i JSON. |
| `warehouse-schedule/` | Aplikacion Next.js + Prisma për orarin e ekipit (import nga Excel). |
| `people-tracking/` | Detektim/tracking anonim i personave nga video (YOLO + ByteTrack), pa njohje fytyre. |

## Instalimi në një PC tjetër

Kërkesat: **Git**, **Node.js 20+** (testuar me v24), dhe **Python 3.10+** vetëm për
`analysis-tools` / `people-tracking`.

```bash
git clone https://github.com/xhevatllumnica-cmd/warehouse-observation-diagnostic.git
cd warehouse-observation-diagnostic
```

**1. Aplikacioni kryesor** — nuk ka nevojë për instalim: hap `index.html` në Chrome/Edge.
Për të kaluar të dhënat nga PC-ja e vjetër: *Data & Export → Full backup (JSON)* atje,
pastaj *Restore from JSON backup* këtu.

**2. Agjenti WMS** (opsional)
1. Kopjo `wms-agent.config.example.json` → `wms-agent.config.json` dhe vendos cookie-n e WMS.
2. Nise me `start-wms-agent.bat` (ose `install-autostart.bat` për ta nisur me Windows-in).
3. Hap `http://localhost:8790/app.html`.

**3. Orari i ekipit** (`warehouse-schedule/`)
```bash
cd warehouse-schedule
npm install
copy .env.example .env
copy name-aliases.example.json name-aliases.local.json
npm run db:push
npm run db:seed -- rruga/te/schedule-warehouse-team.xlsx
npm run dev
```
Excel-i i orarit dhe emrat realë të punonjësve **nuk** janë në repo — kopjoji veçmas.

**4. People tracking** (`people-tracking/`)
```bash
cd people-tracking
python -m venv .venv
.venv\Scripts\activate
pip install -r requirements.txt
```
Modelet `yolov8*.pt` shkarkohen automatikisht nga `ultralytics` në ekzekutimin e parë.
Kopjo `calibration.example.json` → `calibration.json` dhe mat pikat reale.

## Çfarë NUK është në repo

Me qëllim janë lënë jashtë (shih `.gitignore`): cookie/fjalëkalime (`wms-agent.config.json`,
`.env`), backup-et JSON, eksportet CSV, dokumentet `.docx`, Excel-i i orarit, databazat
SQLite, video/rezultatet e tracking-ut dhe lista e emrave të punonjësve.
