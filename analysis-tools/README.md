# Analysis toolchain — Aneks B (automatik)

Këto skedarë rigjenerojnë **Aneks B — Analiza e të Dhënave të Vëzhgimit** nga backup-i JSON
i Warehouse Observation & Diagnostic System. Të gjitha shifrat llogariten nga të dhënat;
asnjë numër nuk është i shkruar me dorë në dokument.

## Skedarët

| Skedari | Roli |
|---|---|
| `analyze.py` | Lexon backup-in JSON më të fundit nga një dosje, llogarit të gjithë treguesit, gjeneron 2 grafikë PNG dhe shkruan `metrics.json` |
| `build_analysis.js` | Lexon `metrics.json` + grafikët dhe ndërton dokumentin .docx |
| `helpers.js` | Stili i përbashkët i dokumenteve (ngjyrat, tabelat, kutitë e shënimeve) |

## Si rigjenerohet (procedura që ndjek edhe detyra e planifikuar)

```bash
# 1. Stage-o nga D:\Warehouse: backup-in më të fundit JSON + këta tre skedarë
# 2. Në workspace:
python3 analyze.py <dosja_me_backup> <dosja_dalese>
node build_analysis.js <dosja_dalese> <dosja_dalese>/Gjirafa_Analiza_e_te_Dhenave_Aneks_B.docx
# 3. Commit-o .docx-in prapa në D:\Warehouse
```

Kërkesa: `matplotlib` (python3) dhe paketa `docx` (npm) — të dyja janë të parainstaluara
në workspace-in e Claude-it.

## Çfarë llogaritet automatikisht

- Zinxhirët e plotë Claim → Picking → Packing/Check-out dhe varianca mes tyre
- Sekonda pune për porosi sipas procesit (min / max / mesatare / raporti i variancës)
- Kohë pune kundrejt kohë pritjeje, gjithsej dhe sipas procesit
- Kapaciteti i nevojshëm për 1.000 porosi/ditë në tre ritme të vëzhguara
- Kontrolli i kryqëzuar me modelin e Aneksit A (porosi për person-turn)
- Mbulimi: procese pa matje, punonjës pa matje, module bosh
- Vazhdimësia: dita e programit, ditë pa hyrje, afate ndjekjeje të kaluara
- Konvergjenca e provave: procesi që ka njëkohësisht variancën më të lartë dhe është
  shkak i emëruar në vëzhgime

## Kufizimi kryesor

Analiza sheh vetëm atë që është eksportuar. Aplikacioni i mban të dhënat në
`localStorage` të shfletuesit — dosja nuk ndryshon derisa të shtypet
**Data & Export → Full backup (JSON)**.

## Defekt i njohur i softuerit

Eksporti CSV nuk është UTF-8 (është Latin-1 pa BOM), prandaj shkronjat `ë` dhe `ç`
prishen në Excel. Backup-i JSON nuk preket. Analiza përdor gjithmonë JSON-in.
