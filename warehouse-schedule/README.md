# Orari i Warehouse

Aplikacion web për menaxhimin dhe përpilimin e orarit të punës së operatorëve të Warehouse.
Zëvendëson Excel-in `Schedule warehouse team 2026.xlsx` dhe ruan të njëjtin format për import/eksport.

**Teknologjia:** Next.js 15 (App Router) · TypeScript · Tailwind CSS 4 · shadcn/ui (Base UI) · Prisma 6 · SQLite (lokalisht) / PostgreSQL (prodhim) · ExcelJS · jsPDF

---

## Nisja e shpejtë

```bash
npm install
cp .env.example .env        # DATABASE_URL="file:./dev.db"
npx prisma db push          # krijon tabelat
cp name-aliases.example.json name-aliases.local.json  # emrat e punonjësve (lokal)
npm run db:seed             # shift-et standarde + importi i Excel-it origjinal
npm run dev                 # http://localhost:3000
```

| Skripti | Çfarë bën |
| --- | --- |
| `npm run dev` | Serveri i zhvillimit |
| `npm run build` / `start` | Build dhe nisje në prodhim |
| `npm run typecheck` / `lint` | Kontrolli i tipeve / ESLint |
| `npm run db:push` | Sinkronizon skemën me databazën |
| `npm run db:seed [-- skedar.xlsx]` | Importon Excel-in (parazgjedhja: `prisma/data/schedule-warehouse-team.xlsx`) |
| `npm run db:reset` | **Fshin gjithçka** dhe e rimbush nga Excel-i |
| `npm run db:studio` | Prisma Studio për të parë të dhënat |

---

## Plani i projektit

| # | Faza | Statusi |
| --- | --- | --- |
| 1 | Skema e databazës + seed nga Excel | ✅ |
| 2 | Lista e punonjësve (shto / edito / çaktivizo / rendit / ngjyra / alias) | ✅ |
| 3 | Pamja e orarit — grid mujor dhe javor si në Excel | ✅ |
| 4 | Editimi i qelizave (panel, tastierë, furça, kopjo/ngjit, zhbëj, kopjo javë) | ✅ |
| 5 | Eksport Excel (format origjinal) + PDF | ✅ |
| 6 | Statistikat dhe validimet | ✅ |
| 7 | Autentikim i plotë me role (Supabase Auth / NextAuth) | ⏳ tani ka vetëm Basic Auth opsional |
| 8 | Historiku i ndryshimeve (kush ndryshoi çfarë) | ⏳ |
| 9 | Kërkesat për pushim nga vetë punonjësit | ⏳ |

### Faqet

- **`/orari`** — grid-i kryesor. Rreshtat janë punonjësit, kolonat datat.
  - *Muaji*: javët (E Hënë–E Diel) që i përkasin muajit, si fletët e Excel-it. Një javë i përket muajit ku bie e Diela e saj.
  - *Java*: 7 ditë me emrat e plotë të ditëve dhe mbulimin sipas turneve.
  - Kolonat "Orë" dhe "Ditë" (ditë pune / OFF) për periudhën e shfaqur; rreshti "Në punë" tregon sa veta punojnë çdo ditë.
- **`/punonjesit`** — CRUD, aktiv/joaktiv, renditja, ngjyra, emrat alternativë për importin.
- **`/shiftet`** — lista e paracaktuar e shift-eve; kategoria llogaritet automatikisht.
- **`/statistikat`** — orë, ditë pune, mëngjes/mbasdite/natë, Weekly OFF, OFF, Sick Leave, pushim dhe paralajmërimet për muaj ose vit.
- **`/importo`** — ngarkim i `.xlsx`, me ose pa mbishkrim të qelizave ekzistuese.
- **`/api/export/excel?year=2026&month=9`** — eksport mujor; pa `month` eksportohet i gjithë viti.

### Editimi i orarit

| Veprimi | Si bëhet |
| --- | --- |
| Ndrysho një qelizë | Klik → zgjidh shift-in ose statusin |
| Ndrysho shumë qeliza | Tërhiq me maus (ose Shift+klik / Shift+shigjeta), pastaj zgjidh vlerën |
| Shkurtore | `1–9` shift-et e para · `W` Weekly OFF · `O` OFF · `S` Sick Leave · `P` Pushim · `Del` pastro · `Enter` hap panelin |
| Furça | Zgjidh vlerën te "Furça", pastaj kliko/tërhiq mbi qeliza |
| Alt + tërheqje | Përsërit vlerën e qelizës së parë mbi zonën |
| Kopjo / ngjit | `Ctrl+C` / `Ctrl+V` — funksionon edhe me qeliza të kopjuara nga Excel |
| Zhbëj | `Ctrl+Z` ose butoni "Zhbëj" |
| Kopjo javë | Butoni "Kopjo javë" ose menyja `⋮` në krye të çdo jave |
| Shënim | Hap panelin e një qelize → "Shënim" |

Ndryshimet shfaqen menjëherë dhe ruhen në server. Nëse serveri refuzon një qelizë, ajo kthehet mbrapsht dhe shfaqet arsyeja.

---

## Struktura e të dhënave

```
Employee       id, name (unik), color, isActive, sortOrder, aliases, createdAt, updatedAt
Shift          id, code (unik, "07:00-15:00"), label, startTime, endTime,
               category (morning|afternoon|night), color?, isActive, sortOrder
ScheduleEntry  id, employeeId, date ("YYYY-MM-DD"), status, shiftId?, notes?
               UNIQUE(employeeId, date)
```

Statuset: `working` (kërkon shift), `weekly_off`, `off`, `sick_leave`, `annual_leave`.

Datat ruhen si tekst `YYYY-MM-DD`, jo si `DateTime`, që orari të mos zhvendoset nga zonat kohore.

### Ngjyrat

| Lloji | Rregulli | Ngjyra |
| --- | --- | --- |
| Mëngjes | fillon para 11:00 | e gjelbër |
| Mbasdite | fillon 11:00–16:59 | blu |
| Natë | fillon nga 17:00 ose kalon mesnatën | vjollcë |
| Weekly OFF / OFF | — | gri |
| Sick Leave | — | e kuqe e çelët |
| Pushim vjetor | — | e verdhë |

Çdo shift mund të ketë edhe ngjyrë të personalizuar.

---

## Rregullat e biznesit

Pragjet ndryshohen te [`src/lib/constants.ts`](src/lib/constants.ts) (`RULES`). Logjika është te [`src/lib/rules.ts`](src/lib/rules.ts).

| Rregulli | Lloji |
| --- | --- |
| Shift-e që mbivendosen (p.sh. 23:00-07:00 dhe të nesërmen 06:00-…) | **Bllokohet** në server |
| Një qelizë për person/ditë | **Bllokohet** nga databaza |
| Më pak se 11 orë pushim mes dy shift-eve | Paralajmërim |
| Më shumë se 6 ditë pune radhazi | Paralajmërim |
| Më shumë se 48 orë në javë | Paralajmërim |
| Shift më i gjatë se 12 orë | Paralajmërim |
| Më shumë se 4 ditë OFF në muaj (pa Weekly OFF) | Paralajmërim |

Orët llogariten nga kohëzgjatja e shift-it; shift-et që kalojnë mesnatën llogariten saktë (23:00-07:00 = 8 orë).

---

## Importi i Excel-it

Parseri është te [`src/lib/import/parse-workbook.ts`](src/lib/import/parse-workbook.ts):

- Çdo fletë është një muaj. Rreshti me ≥4 data në kolonat **B–H** është titulli i javës; rreshtat poshtë tij janë punonjësit. Kolonat pas H (shënime anësore) injorohen.
- Titujt e javëve kanë shumë gabime shtypi (viti 2024 në vend të 2025, muaj/ditë të ndërruar, e Diel në vend të së Hënës). Data e fillimit zgjidhet me votim nga të 7 kolonat dhe krahasohet me javën e mëparshme + 7 ditë.
- Vlerat e panjohura (`MK`, `-`) anashkalohen dhe raportohen.
- Fleta "Pushimet vjetore" lexohet vetëm për emrat.

**Rezultati me skedarin origjinal:** 21 fletë, 89 javë (06.01.2025 – 20.09.2026, pa boshllëqe), 10 442 qeliza, 22 shift-e, 64 punonjës (16 aktivë).

### Emrat

Emrat realë të punonjësve **nuk** ruhen në kod. Harta e alias-eve dhe lista e punonjësve aktivë lexohen nga `name-aliases.local.json` në rrënjë të projektit (jashtë git-it). Për ta krijuar në një PC të ri:

```bash
cp name-aliases.example.json name-aliases.local.json
```

Formati:

```json
{
  "aliases": { "filani": "Filan" },
  "activeEmployees": ["Filan"]
}
```

Çelësat te `aliases` janë si shkruhen në Excel (pa marrë parasysh shkronjat e mëdha/vogla), vlerat janë emri kanonik në aplikacion. Alias-et ruhen edhe te fusha "Emra alternativë" e çdo punonjësi. Emrat që nuk janë në hartë importohen siç janë (si persona të veçantë).

Pas ndryshimit të skedarit ekzekutoni `npm run db:reset`.

---

## Deploy në Vercel

SQLite nuk funksionon në Vercel, sepse sistemi i skedarëve lejon vetëm leximin. Për prodhim duhet PostgreSQL (Supabase, Neon ose Vercel Postgres):

1. Te `prisma/schema.prisma` ndrysho `provider = "sqlite"` → `provider = "postgresql"`.
2. Vendos `DATABASE_URL` te Environment Variables në Vercel (për Supabase përdor connection pooler, `?pgbouncer=true`).
3. Lokalisht, me të njëjtin `DATABASE_URL`, ekzekuto `npx prisma db push` dhe `npm run db:seed`.
4. Deploy. Skripti `build` ekzekuton `prisma generate` vetë.

### Mbrojtja me fjalëkalim

Vendos `BASIC_AUTH_USER` dhe `BASIC_AUTH_PASSWORD`. Kështu i gjithë aplikacioni kërkon hyrje ([`src/middleware.ts`](src/middleware.ts)). Për përdorues të shumtë me role, hapi i ardhshëm është Supabase Auth ose NextAuth.

---

## Struktura e kodit

```
prisma/
  schema.prisma            skema
  seed.ts                  shift-et standarde + importi
  data/                    Excel-i origjinal
src/
  app/
    actions/               server actions (schedule, employees, shifts, import)
    api/export/excel/      eksporti Excel
    orari/ punonjesit/ shiftet/ statistikat/ importo/
  components/
    schedule/              grid-i, paneli i editimit, furça, PDF, kopjo javë
    employees/ shifts/ stats/ import/ layout/
    ui/                    shadcn/ui
  lib/
    constants.ts           statuset, emrat shqip, pragjet e rregullave
    dates.ts               datat "YYYY-MM-DD" (UTC), javët e muajit
    shifts.ts              kohëzgjatja, kategoria, ngjyrat
    rules.ts               mbivendosja, paralajmërimet, statistikat
    data.ts                leximi nga databaza
    import/                parseri i Excel-it + harta e emrave
    export/                eksporti Excel
```
