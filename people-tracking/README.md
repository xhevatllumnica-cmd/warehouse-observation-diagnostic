# Detektim + tracking i punëtorëve nga video

Pipeline modular që lexon një video nga kamera UniFi Protect (G5 Turret Ultra),
detekton personat me YOLO, u jep ID të qëndrueshme me ByteTrack, dhe nxjerr:

- `output/results.csv` — të dhënat frame-by-frame
- `output/annotated.mp4` — video me bounding box + `person_id`
- `output/summary.json` — konfigurimi i plotë + statistikat e ekzekutimit

**Privatësi:** nuk ka njohje fytyre dhe as identifikim emëror. `person_id` është
një numër i përkohshëm, i vlefshëm vetëm brenda një klipi. Edhe nënshkrimet e
ri-identifikimit janë vektorë numerikë që jetojnë vetëm në memorie gjatë
përpunimit — nuk ruhen dhe nuk dalin nga makina.

---

## Struktura

| File | Përgjegjësia |
|---|---|
| `detection.py` | `PersonDetector` — wrapper mbi YOLO, filtruar te klasa `person` |
| `tracking.py` | `PersonTracker` (ByteTrack/BoTSORT/OC-SORT/SORT), anotimi, statistikat |
| `reid.py` | Ri-identifikim pamor — vazhdimësi ID-je përtej occlusion-it të gjatë |
| `calibration.py` | Homografi tokë-plan: piksele → metra; ankorimi BOTTOM_CENTER |
| `tune.py` | Grid search + test occlusion-i mbi detektime të ruajtura |
| `main.py` | Pipeline-i i plotë |
| `requirements.txt` | Varësitë me versione të fiksuara |

## Instalim

```bash
python -m venv .venv
.venv\Scripts\activate
pip install -r requirements.txt
pip install torch==2.14.0 torchvision==0.29.0 --index-url https://download.pytorch.org/whl/cu126
```

Rreshti i fundit është i domosdoshëm për GPU — shih `requirements.txt`.

## Përdorim

```bash
python main.py --video "D:/Downloads/G5 Turret Ultra ....mp4"
```

```bash
# me koordinata metrike + ri-identifikim
python main.py --video video.mp4 --calibration calib.json --reid

# model më i madh, në GPU
python main.py --video video.mp4 --model yolov8l.pt --device cuda

# ndarje e frame-it në rajone (personat e vegjël / skajet fisheye)
python main.py --video video.mp4 --slice --slice-size 960
```

`python main.py --help` i liston të gjithë parametrat. Asnjë prag nuk është hardcoded.

### Cache i detektimeve

Detektimi është hapi i shtrenjtë; tracking-u praktikisht falas. Detektimet mund
të ruhen një herë dhe të ripërdoren për tuning:

```bash
python main.py --video video.mp4 --save-detections dets.pkl --no-video
python main.py --video video.mp4 --load-detections dets.pkl --min-iou 0.10
```

Kjo e ul një iterim nga minuta në sekonda.

---

## Statusi i rekomandimeve para Fazës 2

### 1. GPU — E ZBATUAR ✔

`torch 2.14.0+cu126` i instaluar; `--device auto` e zgjedh vetë CUDA-n dhe
aktivizon FP16 automatikisht (T1000 është Turing, ka tensor core për FP16).

| | CPU | GPU (T1000, FP16) |
|---|---|---|
| Kohë totale (30 s video, 180 frame) | 210 s | **22.3 s** |
| Shpejtësi | 0.86 frame/s | **8.08 frame/s** |
| Faktor realtime | 0.14x | **1.35x** |

**Përshpejtim 9.4x.** Nga më ngadalë se realtime në më shpejt se realtime.
Një turn 8-orësh: nga ~6 orë përpunim në ~38 minuta.

`cu126` u zgjodh sepse drejtuesi (573.57) mbështet CUDA 12.8; `cu130` do të
kërkonte drejtues ≥580 dhe do të dështonte këtu.

### 2. Homografi tokë-plan — INFRASTRUKTURA E ZBATUAR ✔ / MATJET DUHEN NGA TI ⚠

`calibration.py` është i plotë dhe i testuar:

```bash
python calibration.py extract  --video video.mp4 --frame 0 --out ref.png
python calibration.py pick     --image ref.png --out calib.json    # klikon pikat me mouse
python calibration.py validate --calibration calib.json --image ref.png --out grid.jpg
```

Pastaj `python main.py --video video.mp4 --calibration calib.json` shton
kolonat `ground_x_m`, `ground_y_m` në CSV.

Çfarë përfshihet:
- homografi nga **4+ pika** (me >4 pika bëhet fit me RANSAC)
- **korrigjim opsional i lentes** para homografisë (`lens` në JSON, pinhole ose
  fisheye) — sepse homografia vetëm supozon kamerë pinhole dhe te kënd i gjerë
  ky supozim bie në skaje
- `reprojection_error` si kontroll cilësie
- rrjet metrik i vizatuar mbi frame për verifikim vizual

**Çfarë mungon:** distancat reale. Dyshemeja në këtë magazinë është beton i
lëmuar pa pllaka, vija apo shenja — nuk ka asnjë referencë nga e cila të nxirren
distanca nga vetë videoja. `calibration.example.json` përmban vlera **të sajuara**
vetëm për të provuar që pipeline-i punon; ato janë shënuar qartë si placeholder.

> **Duhet nga ti:** zgjidh 4 pika mbi dysheme (p.sh. këmbët e rafteve) dhe mat
> me shirit metrik distancat midis tyre. Pastaj i vendos te `world_points`.

Sa rëndësi ka: me kalibrimin shembull, shkalla varion **13.9x** brenda kornizës
(0.40 deri 5.60 cm/piksel). Pra 100 piksele nënkuptojnë 0.4 m në një skaj dhe
5.6 m në tjetrin — çdo matje direkt mbi piksele do të ishte e pavlefshme.

### 3. Ankorim BOTTOM_CENTER — E ZBATUAR ✔

`bbox_anchor()` në `calibration.py` kthen qendrën e buzës së poshtme të bbox-it,
dhe CSV-ja tani përmban `anchor_x`, `anchor_y` në çdo rresht. Homografia
aplikohet mbi këtë pikë, jo mbi qendrën e bbox-it.

Arsyeja: qendra e bbox-it ndodhet rreth belit, ~1 m mbi dysheme. Pas
homografisë ajo projektohet në një pikë dyshemeje më larg kamerës nga sa është
personi realisht, dhe gabimi rritet me largësinë. Buza e poshtme është e vetmja
pikë që i përket vërtet planit të dyshemesë.

Kolonat e reja janë **shtesë**; tetë kolonat origjinale mbeten të pandryshuara
në të njëjtin rend.

### 4. Ri-vleftësim me lëvizje reale — HARNESS I ZBATUAR ✔ / KLIPI DUHET NGA TI ⚠

Ky klip nuk e teston dot tracking-un: matja e lëvizjes tregon 33–72 px hapësirë
për person dhe asnjë kryqëzim. Prandaj në vend që ta quaj të vleftësuar, ndërtova
`tune.py` që e mat qëndrueshmërinë drejtpërdrejt.

```bash
python tune.py build  --video video.mp4 --out dets.pkl
python tune.py sweep  --detections dets.pkl --expected-persons 3
python tune.py stress --detections dets.pkl --video video.mp4
```

**`sweep`** provoi 96 konfigurime mbi detektimet e ruajtura dhe konfirmoi që
parametrat aktualë janë optimalë (16 nga 96 japin saktësisht 3 ID; default-i
ynë ka mbulimin më të lartë ndër to).

U krahasuan edhe të katër algoritmet e tracking-ut mbi të njëjtat detektime
(`--tracker`), me 3 persona realë në klip:

| Algoritëm | ID unike | Koment |
|---|---|---|
| **bytetrack** | **3** ✔ | default-i |
| ocsort | 3 ✔ | alternativë e barabartë këtu |
| botsort | 4 | CMC-ja nuk ndihmon në kamerë fikse |
| sort | 9 | pa fazën e dytë të asociimit — shembet te occlusion-i |

**`stress`** fshin artificialisht detektimet e një personi për N frame rresht
dhe kontrollon nëse ID-ja mbijeton. Ky test nxori gjetjen më të rëndësishme:

| Person | Vetëm tracking | Me `--reid` |
|---|---|---|
| ID 0 | 1.17 s | 1.17 s |
| ID 1 | 2.00 s | 2.00 s |
| ID 2 | 2.00 s | **9.69 s** |

**Toleranca reale ndaj occlusion-it është 1.2–2.0 s, jo 10 s.** `lost-buffer=60`
në 6 fps nënkupton 10 sekonda, por ai NUK është kufizuesi: gjatë hendekut filtri
Kalman vazhdon të parashikojë, kutia e parashikuar rrëshqet nga pozicioni real,
dhe IoU bie nën prag shumë para se buffer-i të skadojë. Rritja e `--lost-buffer`
vetëm nuk e zgjidh këtë.

### 5. Ri-identifikim pamor — E ZBATUAR ✔

Paketa `trackers` 2.6.0 **nuk** ofron tracker me embeddings pamorë — `BoTSORT`
aty ka vetëm kompensim të lëvizjes së kamerës, jo ReID. Rekomandimi im i
mëparshëm ishte optimist për këtë; prandaj shtresa u implementua në `reid.py`.

Funksionon si hartëzim `raw_id → canonical_id` **mbi** tracker-in: çdo track mban
një nënshkrim pamor; kur tracker-i nxjerr një ID krejt të re, ajo krahasohet me
ID-të e humbura së fundmi dhe bashkohet nëse ngjashmëria është e lartë.

Rezultati i matur (tabela lart): për personin e izoluar toleranca u rrit nga
2.0 s në 9.7 s — **4.8x**.

Për ID 0 dhe ID 1 nuk pati përmirësim, dhe kjo është sjellje e **dëshiruar**:
ata janë dy punëtorë që qëndrojnë krah për krah te e njëjta tavolinë. Mbrojtjet
kundër bashkimit të gabuar e ndalojnë vendimin kur dy kandidatë duken njësoj —
bashkimi i dy personave të ndryshëm është gabim më i rëndë se një ID e dyfishtë.

Mbrojtjet (të testuara veçmas):
- një ID e re nuk bashkohet kurrë me një ID **aktive në të njëjtin frame**
- kërkohet prag ngjashmërie (`--reid-threshold`, default 0.80)
- kërkohet **diferencë** nga kandidati i dytë (`--reid-margin`) — kritike në
  magazinë ku uniformat janë të ngjashme
- hendek maksimal kohor (`--reid-max-gap`)

Backend-i default `hist` (histogram HSV) nuk kërkon shkarkim dhe është ~0.1 ms
për krop. `--reid-backend cnn` përdor resnet18 nëse `hist` ngatërron persona me
veshje të ngjashme.

### 6. Mos e rrit `--target-fps` pa nevojë — E ZBATUAR ✔

Default-i mbetet 6 fps. Shtuar një paralajmërim automatik kur fps-ja efektive
kalon ~10, që shpjegon se kostoja rritet linearisht ndërsa saktësia jo.

---

## Rezultatet e testit (klipi 30-sekondësh)

| Metrikë | Vlera |
|---|---|
| Frame të procesuar | 180 nga 900 (çdo i 5-ti → 5.99 fps) |
| Frame me të paktën 1 person | 179 / 180 (99.4%) |
| Persona mesatarisht për frame | **2.88** |
| **ID unike të krijuara** | **3** |
| Indikator ID-switching | **1.0x** (ideal) |
| Kohë përpunimi (GPU) | 22.3 s |

Të tre ID-të mbulojnë të gjithë klipin (0.17s → 29.91s), pra asnjë ID-switch.

**Klipi ka 3 persona, jo 1–2** siç priste specifikimi: dy punëtorë në tavolinën
majtas dhe një në stacionin në sfond.

### Vendimet teknike kryesore

**`--imgsz 1280` në vend të 640.** Në të njëjtat frame, me 640 besueshmëritë
ishin 0.17–0.55 (nën pragun e aktivizimit); me 1280 u ngjitën në 0.60–0.90.
Në kënd oblik, personat larg kamerës zënë pak piksele dhe humbasin në rezolucion
të ulët. Ky ishte faktori vendimtar, jo madhësia e modelit.

**Prag i ulët detektimi (0.15) + prag i veçantë aktivizimi (0.35).** ByteTrack-u
i përdor detektimet me besueshmëri të ulët në fazën e dytë të asociimit —
pikërisht ato që ndodhin gjatë occlusion-it. Nëse detektori i pret që në fillim,
ky avantazh humbet.

**`min-iou` 0.20 → 0.10.** Ekzekutimi i parë dha 4 ID për 3 persona. Shkaku nuk
ishte buffer-i i occlusion-it, por dy bbox të mbivendosura mbi të njëjtin person:
kur personi u ul pas stivës së kutive, YOLO nxirrte njëkohësisht një kuti të
gjerë të qëndrueshme (~80×107 @ 0.40) dhe një "fantazmë" vetëm-kokë (~43×50 @
0.19). Tracker-i u kap pas fantazmës; kur ajo u zhduk, forma ndryshoi aq shumë sa
IoU ra nën 0.20. Me 0.10 problemi zhduket.

**`frame_rate` i ByteTrack-ut = fps-ja e mostrimit (≈6), jo 30.** Ky parametër
përcakton sa kohë mbahet gjallë një track i humbur.

**Backend-i.** `supervision.ByteTrack` është deprecated (hiqet në 0.31);
`PersonTracker` përdor `trackers.ByteTrackTracker` dhe bie te i vjetri vetëm
nëse paketa mungon.

---

## Çfarë mbetet para Fazës 2

Dy gjëra, të dyja kërkojnë veprim fizik në magazinë — asnjë nuk zgjidhet dot nga kodi:

1. **Mat 4 pika referimi mbi dysheme** dhe vendosi te `calib.json`. Pa to,
   `ground_x_m`/`ground_y_m` janë në një sistem arbitrar, jo në metra realë.
2. **Regjistro një klip 2–5 minutësh me lëvizje reale** — njerëz që ecin nëpër
   korridor dhe kryqëzohen me njëri-tjetrin. Pastaj:
   ```bash
   python tune.py build  --video klipi_i_ri.mp4 --out dets2.pkl
   python tune.py stress --detections dets2.pkl --video klipi_i_ri.mp4
   ```
   Numri që del aty (sa sekonda occlusion toleron) është ai që përcakton nëse
   `--lost-buffer` dhe `--reid-max-gap` duhen rregulluar për magazinën tënde.

Gjithashtu vlen të mbahet parasysh: me `--reid`, `person_id` bëhet i qëndrueshëm
edhe përtej daljes nga korniza. Kjo është ajo që i bën statistikat agregate të
Fazës 2 të besueshme — ndryshe i njëjti punëtor numërohet dy herë.
