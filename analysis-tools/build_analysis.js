"use strict";
// Aneks B — ndërtohet tërësisht nga metrics.json (dalje e analyze.py).
// Përdorimi: node build_analysis.js [dosja_me_metrics] [skedari_dales]
const fs = require("fs");
const path = require("path");
const H = require("./helpers");
const {
  Document, Paragraph, TextRun, HeadingLevel, BorderStyle, AlignmentType,
  Header, Footer, PageNumber, Packer, TableOfContents,
  COLOR, FONT, t, bold, p, pRuns, h1, h2, h3, h4, pageBreak, note, needsValidation,
  stepList, bulletList, dataTable,
} = H;
const { ImageRun } = require("docx");

const DIR = process.argv[2] || __dirname;
const OUTFILE = process.argv[3] || path.join(DIR, "Gjirafa_Analiza_e_te_Dhenave_Aneks_B.docx");
const R = JSON.parse(fs.readFileSync(path.join(DIR, "metrics.json"), "utf8"));

// ---------- formatim shqip ----------
const nf = (v, dec = 0) => {
  if (v === null || v === undefined) return "—";
  const s = Number(v).toFixed(dec);
  const [i, d] = s.split(".");
  const ii = i.replace(/\B(?=(\d{3})+(?!\d))/g, ".");
  return d ? `${ii},${d}` : ii;
};
const sev = (s) => ({ Critical: "Kritike", Important: "E rëndësishme", Improvement: "Përmirësim" }[s] || s || "—");

const IMG = (file, w, h, caption) => {
  const fp = path.join(DIR, file);
  if (!fs.existsSync(fp)) return [];
  const out = [new Paragraph({
    alignment: AlignmentType.CENTER, spacing: { before: 160, after: 60 },
    children: [new ImageRun({ type: "png", data: fs.readFileSync(fp), transformation: { width: w, height: h } })],
  })];
  if (caption) out.push(new Paragraph({
    alignment: AlignmentType.CENTER, spacing: { after: 200 },
    children: [new TextRun({ text: caption, italics: true, color: COLOR.mid, size: 17, font: FONT })],
  }));
  return out;
};

const C = R.counts, T = R.time, DT = R.dates, CS = R.chainStats, CC = R.crossCheck;
const children = [];

// ================= COVER =================
children.push(new Paragraph({ spacing: { before: 800, after: 200 }, children: [
  new TextRun({ text: "ANEKS B — SOP-WH-2026-01", bold: true, color: COLOR.mid, size: 28, font: FONT })]}));
children.push(new Paragraph({ spacing: { after: 300 }, children: [
  new TextRun({ text: "Analiza e të Dhënave të Vëzhgimit", bold: true, color: COLOR.dark, size: 50, font: FONT })]}));
children.push(new Paragraph({ spacing: { after: 40 }, children: [
  new TextRun({ text: "Warehouse Observation & Diagnostic System — analizë e automatizuar", color: COLOR.accent, size: 25, font: FONT, bold: true })]}));
children.push(new Paragraph({ spacing: { after: 500 }, children: [
  new TextRun({ text: `Të dhëna nga ${DT.first} deri ${DT.last} · gjeneruar më ${R.source.analyzedAt}`, italics: true, color: COLOR.mid, size: 22, font: FONT })]}));

children.push(dataTable([2700, 8100], ["Fusha", "Të dhënat"], [
  ["Titulli", "Analiza e të Dhënave të Vëzhgimit — Warehouse Observation & Diagnostic System"],
  ["Numri", "ANEKS B / SOP-WH-2026-01"],
  ["Dokumentet prind", "SOP-WH-2026-01 dhe ANEKS A (struktura e personelit)"],
  ["Burimi i të dhënave", `${R.source.file} (${nf(R.source.sizeKB)} KB), eksportuar më ${R.source.fileMtime}`],
  ["Periudha e mbuluar", `${DT.first} – ${DT.last} (${DT.nDays} ditë; fillimi i programit: ${R.source.startDate})`],
  ["Vëllimi i importuar", `${C.measurements} matje · ${C.observations} vëzhgime · ${C.employees} punonjës · ${C.processes} procese · ${C.staffSkills} regjistrime aftësish · ${C.validations} validim · ${C.audit} hyrje auditimi`],
  ["Gjeneruar", `${R.source.analyzedAt} — automatikisht nga të dhënat, pa ndërhyrje manuale në numra`],
  ["Statusi", DT.nDays < 5 ? "Bazë e vogël mostre — kufizimet janë të deklaruara në Pjesën 2" : "Analizë mbi bazën aktuale të të dhënave"],
].map((r) => [{ content: r[0], bold: true, shading: COLOR.lightBg }, r[1]])));
children.push(pageBreak());

// ================= TOC =================
children.push(h1("Përmbajtja"));
children.push(new TableOfContents("Përmbajtja", { hyperlink: true, headingStyleRange: "1-2" }));
children.push(pageBreak());

// ================= PART 1 — findings =================
children.push(h1("PJESA 1 — Gjetjet Kryesore"));
const F = [];
if (CS) F.push(["Varianca, jo mesatarja, është problemi",
  `I njëjti zinxhir Claim → Picking → Packing kërkon ${nf(CS.min)} sekonda për porosi te operatori më i shpejtë dhe ${nf(CS.max)} te më i ngadalti — ${nf(CS.spread, 1)} herë më shumë (n=${CS.n} zinxhirë të plotë).`, "data-derived"]);
if (R.convergence) F.push([`${R.convergence.process} është pika ku konvergojnë provat`,
  `${R.convergence.process} ka variancë ${nf(R.convergence.spread, 1)}× në matje (${nf(R.convergence.min, 1)} kundrejt ${nf(R.convergence.max, 1)} sekonda për porosi) dhe njëkohësisht është shkaku i emëruar nga vetë vëzhguesi në: ${R.convergence.namedIn.map((x) => `"${x}"`).join(", ")}.`, "data-derived"]);
F.push([T.waitingCapturePct < 50
  ? `Pritja matet vetëm pjesërisht — ${T.waitingCapturePct}% e matjeve e regjistrojnë`
  : `Pritja zë ${nf(T.waitingSharePct, 1)}% të kohës së matur`,
  `${T.measurementsWithWaiting} nga ${T.measurementsTotal} matje (${T.waitingCapturePct}%) regjistrojnë ndonjë pritje, gjithsej ${nf(T.waitingHours, 2)} orë ose ${nf(T.waitingSharePct, 1)}% e kohës totale.${T.waitingCapturePct < 50 ? " Meqë shumica e matjeve shënojnë zero pritje, kjo shifër është dysheme e matjes, jo realitet." : ""}`,
  "data-derived"]);
if (R.worstWaiting && R.worstWaiting.waitPct > 0) F.push([`${R.worstWaiting.name} është procesi me pritjen më ekstreme`,
  `${nf(R.worstWaiting.procMin)} minuta punë kundrejt ${nf(R.worstWaiting.waitMin)} minuta pritje — ${R.worstWaiting.waitPct}% e kohës totale të matur për atë proces.`, "data-derived"]);
if (CC && CC.ordersPerPersonShift) F.push(["Modeli i personelit i Aneksit A kontrollohet nga matjet",
  `Llogaritja nga poshtë-lart mbi kohët reale jep ${nf(CC.ordersPerPersonShift, 1)} porosi për person-turn (katër procese); vlerësimi nga lart-poshtë i Aneksit A jepte ${CC.annexATopDown} duke përfshirë të gjitha proceset dhe rolet. Diferenca: ${CC.deltaPct > 0 ? "+" : ""}${nf(CC.deltaPct, 1)}%.`, "data-derived"]);
const crit = R.observations.filter((o) => o.severity === "Critical" || o.severity === "Important");
if (crit.length) F.push([`${crit.length} vëzhgime të shënuara si kritike ose të rëndësishme`,
  crit.slice(0, 2).map((o) => `"${o.what.slice(0, 90)}${o.what.length > 90 ? "…" : ""}"`).join(" · "), "observed"]);
if (DT.daysSinceLastEntry >= 2) F.push(["Mbledhja e të dhënave nuk është e vazhdueshme",
  `Sot është dita ${DT.programDay} e programit; e dhëna e fundit është e ${DT.last}, pra ${DT.daysSinceLastEntry} ditë pa asnjë hyrje.${R.overdueFollowUps.length ? ` ${R.overdueFollowUps.length} afate ndjekjeje kanë kaluar pa veprim.` : ""}`, "data-derived"]);

children.push(p(`${F.length} gjetje dalin nga të dhënat aktuale. Të gjitha shifrat janë llogaritur automatikisht nga backup-i; asnjë nuk është shkruar me dorë.`));
children.push(dataTable([500, 2900, 6000, 1400], ["#", "Gjetja", "Prova nga të dhënat", "Lloji"],
  F.map((r, i) => [{ content: String(i + 1), bold: true, align: AlignmentType.CENTER },
    { content: r[0], bold: true, shading: COLOR.lightBg }, r[1], { content: r[2], italics: true }])));
children.push(note("Rregull i trashëguar nga vetë softueri: vëzhgimi nuk është përfundim. 'data-derived' rrjedh nga matjet; 'observed' janë regjistrime të drejtpërdrejta; hipotezat janë shënuar shprehimisht kudo që shfaqen.", "info"));
children.push(pageBreak());

// ================= PART 2 — data state =================
children.push(h1("PJESA 2 — Gjendja e të Dhënave dhe Kufizimet e Analizës"));
children.push(p("Çdo përfundim më poshtë duhet lexuar përballë kësaj tabele."));

children.push(h2("A. Mbulimi sipas procesit"));
children.push(dataTable([2600, 1600, 1200, 5400], ["Procesi", "Kategoria", "Matje", "Shënim"],
  R.coverage.map((c) => [{ content: c.name, bold: true, shading: COLOR.lightBg }, c.category,
    { content: String(c.n), align: AlignmentType.CENTER, bold: c.n === 0 },
    c.n === 0 ? "ZERO matje" : (R.perProcess.find((x) => x.name === c.name)?.orders ? `${R.perProcess.find((x) => x.name === c.name).orders} porosi të matura` : "Matur, por pa numër porosish")])));
if (R.zeroProcesses.length) children.push(note(
  `${R.zeroProcesses.length} nga ${C.processes} procese nuk kanë asnjë matje: ${R.zeroProcesses.join(", ")}. Pjesa përkatëse e hartës së procesit mbetet e pamatur.`, "warn"));

children.push(h2("B. Mbulimi sipas punonjësit"));
children.push(dataTable([2400, 1800, 1800, 4800], ["Punonjësi", "Turni", "Matje", "Aftësi të regjistruara"],
  R.staff.map((s) => [{ content: s.name, bold: true, shading: COLOR.lightBg }, s.shift,
    { content: String(s.measurements), align: AlignmentType.CENTER },
    { content: String(s.skills), align: AlignmentType.CENTER }])));
children.push(p(`${R.staffNoMeasurements.length} punonjës nuk kanë asnjë matje dhe ${R.staffNoSkills.length} nga ${C.employees} nuk kanë asnjë aftësi të regjistruar. Matrica e aftësive ka ${C.staffSkills} regjistrime nga rreth ${C.employees * C.processes} kombinime të mundshme punonjës-proces, prandaj nuk mund të flagojë ende pikat e vetme të dështimit.`));

if (R.emptyModules.length) {
  children.push(h2("C. Modulet e pambushura"));
  const modNames = { orders: "Order Flow — ndjekja e porosisë nga Claim te Dispatch me vula kohore",
    products: "Product / Inbound Flow — ndjekja e produktit nga mbërritja te ruajtja",
    staffObs: "Staff Observation Log — klasifikimi person/proces/sistem/kapacitet",
    problems: "Bottleneck Register — regjistrimi formal i pikave të ngushta",
    kpiRecords: "KPI Baseline — pa bazë, targete nuk vendosen dot",
    hqInteractions: "HQ Interface", quickWins: "Quick Wins", briefings: "Briefings" };
  children.push(...bulletList(R.emptyModules.map((k) => `${modNames[k] || k} (0 regjistrime)`)));
  children.push(note(`${R.emptyModules.length} module janë bosh. Raporti 30-ditor diagnostik do të dilte me "Not yet observed" në ato seksione.`, "warn"));
}

children.push(h2("D. Vazhdimësia e mbledhjes së të dhënave"));
children.push(dataTable([3000, 2200, 5600], ["Treguesi", "Vlera", "Shënim"], [
  ["Dita e programit", `${DT.programDay} nga 30`, `Fillimi: ${R.source.startDate}`],
  ["Ditë me të dhëna", String(DT.nDays), DT.covered.join(", ")],
  ["Ditë nga hyrja e fundit", String(DT.daysSinceLastEntry), DT.daysSinceLastEntry >= 2 ? "Mbledhja është ndërprerë" : "Mbledhja është aktive"],
  ["Aktiviteti në sistem", R.activity.map((a) => `${a[0]}: ${a[1]}`).join(" · "), "Veprime të regjistruara në audit log"],
  ["Afate ndjekjeje të kaluara", String(R.overdueFollowUps.length), R.overdueFollowUps.length ? R.overdueFollowUps.map((r) => r.followUp).join(", ") : "Asnjë"],
].map((r) => [{ content: r[0], bold: true, shading: COLOR.lightBg }, r[1], r[2]])));
children.push(pageBreak());

// ================= PART 3 — outbound cycle =================
if (CS) {
  children.push(h1("PJESA 3 — Cikli Outbound: Varianca si Gjetja Kryesore"));
  children.push(p(`${CS.n} zinxhirë të plotë Claim → Picking → Packing/Check-out u rindërtuan nga matjet (i njëjti operator, i njëjti grup porosish, hapa të njëpasnjëshëm). Ata janë baza e çdo llogaritjeje kapaciteti më poshtë.`));
  children.push(...IMG(R.charts.variance, 650, Math.round(650 * (0.62 * CS.n + 1.0) / 7.2),
    `Grafiku 1 — Puna e matur për porosi, sipas zinxhirëve të plotë të vëzhguar (n=${CS.n})`));
  children.push(dataTable([1500, 1400, 1100, 1100, 1400, 1500, 1400, 1400],
    ["Data", "Operatori", "Porosi", "Njësi", "Njësi/porosi", "Sekonda pune", "Sek/porosi", "Min/porosi"],
    R.chains.map((c) => [c.date, { content: c.emp, bold: true, shading: COLOR.lightBg },
      { content: String(c.orders), align: AlignmentType.CENTER },
      { content: c.units ? String(c.units) : "—", align: AlignmentType.CENTER },
      { content: c.unitsPerOrder ? nf(c.unitsPerOrder, 1) : "—", align: AlignmentType.CENTER },
      { content: nf(c.procSec), align: AlignmentType.CENTER },
      { content: nf(c.secPerOrder), align: AlignmentType.CENTER, bold: true },
      { content: nf(c.minPerOrder, 1), align: AlignmentType.CENTER }])));

  const withUnits = R.chains.filter((c) => c.unitsPerOrder);
  if (withUnits.length >= 2) {
    const fast = withUnits[0], slow = withUnits[withUnits.length - 1];
    children.push(h2("A shpjegohet varianca me ngarkesën e punës?"));
    children.push(p(`Hipoteza e parë e natyrshme është se zinxhirët më të ngadaltë kishin më shumë njësi për porosi. Të dhënat: zinxhiri më i shpejtë (${fast.emp}) kishte ${nf(fast.unitsPerOrder, 1)} njësi për porosi në ${nf(fast.secPerOrder)} sekonda, ndërsa më i ngadalti (${slow.emp}) kishte ${nf(slow.unitsPerOrder, 1)} njësi në ${nf(slow.secPerOrder)} sekonda.`));
    const explained = slow.unitsPerOrder / fast.unitsPerOrder >= slow.secPerOrder / fast.secPerOrder * 0.8;
    children.push(note(explained
      ? "[E mundshme] Ngarkesa e punës e shpjegon një pjesë të mirë të diferencës — varianca duhet rilexuar pasi të ketë më shumë matje me numër njësish të regjistruar."
      : "[E mundshme — jo e sigurt] Ngarkesa e punës nuk e shpjegon diferencën: raporti i njësive për porosi është shumë më i vogël se raporti i kohës. Varianca duket të vijë nga metoda e punës. Me këtë numër zinxhirësh kjo mbetet hipotezë që kërkon 10–15 matje shtesë, por tregon ku duhet parë e para: te mënyra si punon operatori më i shpejtë.", "warn"));
  }

  if (R.spreadRanking && R.spreadRanking.length) {
    children.push(h2("Varianca sipas procesit"));
    children.push(dataTable([2600, 1000, 1600, 1600, 1400, 2600],
      ["Procesi", "Matje", "Min (sek/porosi)", "Max (sek/porosi)", "Mesatare", "Varianca"],
      R.spreadRanking.map((r) => [{ content: r.process, bold: true, shading: COLOR.lightBg },
        { content: String(r.n), align: AlignmentType.CENTER },
        { content: nf(r.min, 1), align: AlignmentType.CENTER },
        { content: nf(r.max, 1), align: AlignmentType.CENTER },
        { content: nf(r.avg, 1), align: AlignmentType.CENTER },
        { content: `${nf(r.spread, 1)}×`, align: AlignmentType.CENTER, bold: true }])));
    children.push(p("Kur vlera minimale është shumë e vogël në terma absolutë, raporti i variancës fryhet — prandaj tabela jep edhe vlerat absolute, jo vetëm raportin."));
  }
  children.push(pageBreak());
}

// ================= PART 4 — capacity =================
if (R.capacity) {
  children.push(h1("PJESA 4 — Çfarë Do të Thotë për 1.000 Porosi/Ditë"));
  children.push(p("Llogaritja përdor vetëm tre proceset outbound të matura (Claim + Picking + Packing/Check-out). Ajo NUK përfshin check-in, receiving, mapping, boxing, dispatch, verification, kthimet dhe mbikëqyrjen — pra rezultati është dysheme, jo total."));
  children.push(dataTable([3200, 1800, 2000, 3800],
    ["Skenari nga të dhënat", "Sek/porosi", "Orë pune/ditë", "Person-turne (6,5 orë) vetëm për outbound"],
    R.capacity.map((c) => [{ content: c.label, bold: true, shading: COLOR.lightBg },
      { content: nf(c.secPerOrder), align: AlignmentType.CENTER },
      { content: nf(c.hoursPerDay, 1), align: AlignmentType.CENTER },
      { content: nf(c.personShifts, 1), align: AlignmentType.CENTER, bold: true }])));
  const lo = R.capacity[0].personShifts, hi = R.capacity[2].personShifts;
  children.push(note(`Leximi: vetëm nga standardizimi i ritmit — pa asnjë punësim — nevoja për outbound luhatet mes ${nf(lo, 1)} dhe ${nf(hi, 1)} person-turneve në ditë. Kjo është prova numerike e asaj që Aneksi A e pohonte: produktiviteti, jo numri i njerëzve, është variabli që komandon.`, "ok"));

  if (CC && CC.ordersPerPersonShift) {
    children.push(h2("Kontrolli i kryqëzuar me modelin e Aneksit A"));
    children.push(...stepList([
      `Outbound mesatare e matur (Claim + Picking + Packing): ${nf(CC.outboundAvg, 1)} sekonda për porosi.`,
      `Mapping mesatare e matur: ${nf(CC.mappingAvg, 1)} sekonda për porosi.`,
      `Shuma e proceseve të matura: ${nf(CC.partialTotal, 1)} sekonda për porosi.`,
      `Një person-turn prej 6,5 orësh = 23.400 sekonda → 23.400 ÷ ${nf(CC.partialTotal, 1)} = ${nf(CC.ordersPerPersonShift, 1)} porosi për person-turn.`,
    ]));
    children.push(dataTable([4200, 2200, 4400], ["Metoda", "Rezultati", "Çfarë përfshin"], [
      ["Nga lart-poshtë (Aneksi A)", `${CC.annexATopDown} porosi/person-turn`, "Të gjitha proceset dhe rolet, përfshirë mbikëqyrjen"],
      ["Nga poshtë-lart (të dhënat)", `${nf(CC.ordersPerPersonShift, 1)} porosi/person-turn`, "Vetëm proceset e matura; pa check-in, receiving, boxing, dispatch, verification, kthime, mbikëqyrje"],
      ["Diferenca", `${CC.deltaPct > 0 ? "+" : ""}${nf(CC.deltaPct, 1)}%`, Math.abs(CC.deltaPct) <= 15 ? "Në drejtimin e duhur: metoda e dytë mat më pak punë, prandaj jep numër më të lartë" : "Diferencë e madhe — modeli i Aneksit A duhet rishikuar me këto matje"],
    ].map((r) => [{ content: r[0], bold: true, shading: COLOR.lightBg }, { content: r[1], bold: true }, r[2]])));
    children.push(note(Math.abs(CC.deltaPct) <= 15
      ? `Dy metoda të pavarura — njëra nga volumi ditor, tjetra nga kronometri — bien brenda ${nf(Math.abs(CC.deltaPct), 1)}% nga njëra-tjetra. Modeli i personelit i Aneksit A ka mbështetje empirike.`
      : `Dy metodat ndryshojnë ${nf(Math.abs(CC.deltaPct), 1)}%. Kjo kërkon rishikim të modelit të Aneksit A përpara se numri i pozitave të përdoret për vendim.`,
      Math.abs(CC.deltaPct) <= 15 ? "ok" : "warn"));
    children.push(needsValidation(`Kjo bazohet në ${CS.n} zinxhirë të plotë. Duhen të paktën 15–20 zinxhirë, të shpërndarë mes operatorëve dhe turneve, përpara se numri të përdoret për vendim punësimi.`));
  }

  // ---- labor that cannot enter the per-order model ----
  if (R.laborOutsideModel && R.laborOutsideModel.hours > 0) {
    children.push(h2("Puna që mbetet jashtë modelit"));
    children.push(p(`Modeli i mësipërm punon në sekonda për porosi. Çdo proces që matet pa numër porosish nuk hyn dot në të — puna e tij është reale, por e padukshme për llogaritjen. Sot kjo prek ${R.laborOutsideModel.processes.join(", ")}: gjithsej ${nf(R.laborOutsideModel.hours, 2)} orë punë njerëzore, ose ${nf(R.laborOutsideModel.sharePct, 1)}% e gjithë punës së matur.`));
    children.push(dataTable([2400, 1200, 1300, 1300, 1400, 1600, 1600],
      ["Procesi", "Matje", "Me porosi", "Me njësi", "Me pako", "Orë pune", "Hyn në model"],
      R.quantityGaps.map((g) => [{ content: g.process, bold: true, shading: COLOR.lightBg },
        { content: String(g.n), align: AlignmentType.CENTER },
        { content: String(g.orders), align: AlignmentType.CENTER },
        { content: String(g.units), align: AlignmentType.CENTER },
        { content: String(g.packages), align: AlignmentType.CENTER },
        { content: nf(g.laborHours, 2), align: AlignmentType.CENTER },
        { content: g.convertible ? "Po" : "JO", align: AlignmentType.CENTER, bold: !g.convertible }])));
    children.push(new Paragraph({ spacing: { after: 160 }, children: [] }));

    if (R.bridgeScenarios) {
      children.push(h3("Sa e zhvendos rezultatin kjo mungesë"));
      children.push(p(`Receiving matet në pako: ${nf(R.bridgeScenarios.packagesMeasured)} pako gjithsej, me ${nf(R.bridgeScenarios.secPerPackage, 1)} sekonda punë njerëzore për pako. Pako është njësia e duhur për pranimin — problemi nuk është ajo, por mungesa e urës drejt porosive. Sa ndryshon rezultati varet nga sa porosi ka brenda një pakoje:`));
      children.push(dataTable([5000, 2800, 3000],
        ["Supozimi", "Sek/porosi gjithsej", "Porosi për person-turn"],
        R.bridgeScenarios.rows.map((r) => [{ content: r.assumption, bold: true, shading: COLOR.lightBg },
          { content: nf(r.secPerOrder, 1), align: AlignmentType.CENTER },
          { content: nf(r.ordersPerPersonShift, 1), align: AlignmentType.CENTER, bold: true }])));
      const hi = R.bridgeScenarios.rows[0].ordersPerPersonShift;
      const lo = R.bridgeScenarios.rows[R.bridgeScenarios.rows.length - 1].ordersPerPersonShift;
      children.push(note(`Një fushë e vetme e paplotësuar e lëkund rezultatin nga ${nf(hi, 1)} në ${nf(lo, 1)} porosi për person-turn — pra nga "Aneksi A është i saktë" në "Aneksi A është optimist". Zgjidhja: te çdo matje e Receiving shënohen edhe njësitë, dhe kur dihet, porositë brenda pakove. Formulari 'Edit measurement' i aplikacionit lejon plotësimin e sasive të harruara edhe për matjet e vjetra.`, "warn"));
    }

    const fc = R.fieldCoverage || {};
    const missing = Object.entries(fc).filter(([, v]) => v === 0).map(([k]) => k);
    if (missing.length) children.push(note(`Fusha të paplotësuara asnjëherë në asnjë matje: ${missing.join(", ")}. Nëse nuk planifikohen për përdorim, mund të hiqen nga formulari që të mos zënë vëmendje; nëse po, duhen filluar.`, "info"));
  }
  children.push(pageBreak());
}

// ================= PART 5 — waiting =================
children.push(h1("PJESA 5 — Pritja, Ndërprerjet dhe Ajo që Instrumenti Nuk e Kap"));
children.push(...IMG(R.charts.waiting, 650, Math.round(650 * (0.44 * R.perProcess.length + 1.3) / 7.2),
  `Grafiku 2 — Kohë pune kundrejt kohë pritjeje, sipas procesit (${DT.first} – ${DT.last})`));
children.push(dataTable([2800, 1800, 1600, 4600], ["Treguesi", "Vlera", "Njësia", "Shënim"], [
  ["Kohë pune gjithsej", nf(T.processingHours, 2), "orë", `Shuma e ${T.measurementsTotal} matjeve`],
  ["Kohë pritjeje gjithsej", nf(T.waitingHours, 2), "orë", `${nf(T.waitingSharePct, 1)}% e kohës totale të matur`],
  ["Matje me pritje > 0", `${T.measurementsWithWaiting} nga ${T.measurementsTotal}`, "matje", `Vetëm ${T.waitingCapturePct}% e matjeve regjistrojnë ndonjë pritje`],
  ["Pritja më e lartë", R.worstWaiting ? `${R.worstWaiting.waitPct}%` : "—", "e kohës", R.worstWaiting ? `${R.worstWaiting.name}: ${nf(R.worstWaiting.procMin)} min punë kundrejt ${nf(R.worstWaiting.waitMin)} min pritje` : "—"],
  ["Ndërprerje të regjistruara", String(T.interruptions), "raste", "Shuma e fushës 'interruptions'"],
  ["Rework i regjistruar", String(T.rework), "raste", "Shuma e fushës 'rework'"],
].map((r) => [{ content: r[0], bold: true, shading: COLOR.lightBg }, { content: r[1], bold: true }, r[2], r[3]])));

const idleObs = R.observations.filter((o) => o.waitingMin || /bredh|koh[ëe] e lir|pa objektiv/i.test(o.what + " " + o.impact));
if (idleObs.length && T.waitingCapturePct < 60) {
  children.push(h2("Kundërshtia mes matjeve dhe vëzhgimeve"));
  children.push(p(`Matjet thonë se pritja është ${nf(T.waitingSharePct, 1)}% e kohës. Vëzhgimet e të njëjtave ditë përshkruajnë diçka tjetër: ${idleObs.slice(0, 2).map((o) => `"${o.what.slice(0, 110)}${o.what.length > 110 ? "…" : ""}"`).join(" · ")}`));
  children.push(note("[E mundshme] Shpjegimi më i besueshëm nuk është se pritja nuk ekziston, por se kronometri ndalohet vetëm kur operatori e kërkon vetë. Pritja që ndodh MES proceseve — porosia që qëndron në tavolinë deri sa dikush ta marrë — nuk hyn fare në asnjë matje, sepse matja fillon kur fillon puna.", "warn"));
  children.push(p("Për ta kapur atë duhet moduli Order Flow (vulat kohore Claim → Dispatch)" + (R.emptyModules.includes("orders") ? ", i cili sot ka zero regjistrime." : ".")));
}
children.push(pageBreak());

// ================= PART 6 — per-process detail =================
children.push(h1("PJESA 6 — Detaje sipas Procesit"));
children.push(dataTable([2600, 1200, 1600, 1600, 1400, 2400],
  ["Procesi", "Matje", "Minuta pune", "Minuta pritje", "% pritje", "Porosi të matura"],
  R.perProcess.map((r) => [{ content: r.name, bold: true, shading: COLOR.lightBg },
    { content: String(r.n), align: AlignmentType.CENTER },
    { content: nf(r.procMin), align: AlignmentType.CENTER },
    { content: nf(r.waitMin), align: AlignmentType.CENTER },
    { content: `${r.waitPct}%`, align: AlignmentType.CENTER, bold: r.waitPct >= 30 },
    { content: r.orders ? nf(r.orders) : "—", align: AlignmentType.CENTER }])));

if (R.convergence) {
  children.push(h2(`${R.convergence.process} — procesi ku konvergojnë provat`));
  const mrows = (R.rates[R.convergence.process] || []).map((x) => [
    x.date, x.emp || "—", String(x.orders), nf(x.secPerOrder, 1)]);
  if (mrows.length) children.push(dataTable([2200, 2400, 1800, 4400],
    ["Data", "Operatori", "Porosi", "Sekonda për porosi"],
    mrows.map((r) => [r[0], { content: r[1], bold: true, shading: COLOR.lightBg },
      { content: r[2], align: AlignmentType.CENTER }, { content: r[3], align: AlignmentType.CENTER, bold: true }])));
  children.push(note(`Varianca ${nf(R.convergence.spread, 1)}× te ${R.convergence.process}, plus fakti që i njëjti proces është shkaku i emëruar në ${R.convergence.namedIn.length} vëzhgime (${R.convergence.namedIn.join("; ")}), e bën këtë pikën e parë ku duhet parë në terren.`, "warn"));
}
children.push(pageBreak());

// ================= PART 7 — observations =================
children.push(h1(`PJESA 7 — Vëzhgimet Cilësore (${C.observations} regjistrime)`));
children.push(p("Renditur sipas rëndësisë së shënuar nga vëzhguesi. Kolona 'Shkaku' përmban vetëm shkakun që e ka shënuar vëzhguesi — jo interpretim të shtuar."));
children.push(dataTable([1300, 1500, 3700, 1500, 2800], ["Data", "Lloji", "Vëzhgimi", "Rëndësia", "Shkaku i shënuar"],
  R.observations.map((o) => [o.date, o.type,
    o.what.slice(0, 180) + (o.what.length > 180 ? "…" : ""),
    { content: sev(o.severity), bold: o.severity === "Critical" }, o.cause])));

const impacts = R.observations.filter((o) => o.impact);
if (impacts.length) {
  children.push(h2("Ndikimet e shënuara"));
  children.push(...bulletList(impacts.map((o) => `${o.date} — ${o.impact}`)));
}
if (R.overdueFollowUps.length) {
  children.push(note(`${R.overdueFollowUps.length} vëzhgime kanë afat ndjekjeje të kaluar (${R.overdueFollowUps.map((r) => r.followUp).join(", ")}) pa veprim të regjistruar.`, "warn"));
}
children.push(pageBreak());

// ================= PART 7B — staff observations =================
if (R.staffObs && R.staffObs.length) {
  children.push(h1(`PJESA 8 — Vëzhgimet e Stafit (${R.staffObs.length} regjistrime)`));
  children.push(p("Ky modul e detyron klasifikimin e shkakut: a është çështje personi, procesi, sistemi, apo kapaciteti. Ky klasifikim është ai që përcakton nëse zgjidhja është trajnim, ndryshim procedure, ndërhyrje teknike, apo më shumë njerëz."));
  const byAttr = Object.entries(R.staffObsByAttribution || {});
  if (byAttr.length) children.push(dataTable([5400, 5400], ["Klasifikimi", "Numri i rasteve"],
    byAttr.map(([k, v]) => [{ content: k, bold: true, shading: COLOR.lightBg }, { content: String(v), align: AlignmentType.CENTER }])));
  children.push(new Paragraph({ spacing: { after: 160 }, children: [] }));
  children.push(dataTable([1300, 1900, 2400, 2900, 2300],
    ["Data", "Klasifikimi", "Situata", "Vëzhgimi", "Shkaku / Personat"],
    R.staffObs.map((s) => [s.date, { content: s.attribution, bold: true, shading: COLOR.lightBg },
      s.situation || "—", s.observation.slice(0, 200) + (s.observation.length > 200 ? "…" : ""),
      [s.cause, s.employees.length ? `(${s.employees.join(", ")})` : ""].filter(Boolean).join(" ")])));
  const procIssues = R.staffObs.filter((s) => /process/i.test(s.attribution));
  if (procIssues.length) children.push(note(
    `${procIssues.length} nga ${R.staffObs.length} raste janë klasifikuar si çështje procesi, jo personi. Kjo është dallimi që mban vëmendjen te sistemi dhe jo te faji individual — dhe është pikërisht qëllimi i këtij moduli.`, "ok"));
  children.push(pageBreak());
}

// ================= PART 7C — HQ interface =================
if (R.hq && R.hq.length) {
  children.push(h1(`PJESA 9 — Ndërfaqja me Departamentet (${R.hq.length} regjistrime)`));
  children.push(p("Harta e asaj që depoja merr dhe dërgon te secili departament, plus problemet dhe pritshmëritë e regjistruara. Kjo është baza për të përcaktuar ku ndodhin dorëzimet jashtë depos — pikat ku SOP-ja mbaron dhe përgjegjësia kalon te dikush tjetër."));
  R.hq.forEach((hq) => {
    children.push(h3(`${hq.department}${hq.date ? " · " + hq.date : ""}`));
    const rows = [["Depoja merr", hq.receive || "—"], ["Depoja dërgon", hq.send || "—"]];
    if (hq.problem) rows.push(["Problemi i regjistruar", hq.problem]);
    if (hq.expectation) rows.push(["Pritshmëria", hq.expectation]);
    children.push(dataTable([2400, 8400], ["Drejtimi", "Përmbajtja"],
      rows.map((r) => [{ content: r[0], bold: true, shading: COLOR.lightBg }, r[1]])));
    children.push(new Paragraph({ spacing: { after: 140 }, children: [] }));
  });
  children.push(pageBreak());
}

// ================= PART 8 — validations =================
if (R.validations.length) {
  children.push(h1("PJESA 10 — Validimet: Çfarë Thuhet kundrejt Çfarë Vëzhgohet"));
  R.validations.forEach((v) => {
    children.push(dataTable([2200, 8600], ["Fusha", "Përmbajtja"], [
      ["Data / Burimi", `${v.date} — ${v.source}`],
      ["Pretendimi", v.claim || "—"],
      ["E vëzhguar", v.observed || "—"],
      ["Të dhënat tregojnë", v.data || "—"],
      ["Gjetja", v.finding || "—"],
      ["Statusi", v.status || "—"],
    ].map((r) => [{ content: r[0], bold: true, shading: COLOR.lightBg }, r[1]])));
    children.push(new Paragraph({ spacing: { after: 200 }, children: [] }));
  });
  children.push(pageBreak());
}

// ================= PART 9 — measurement plan =================
children.push(h1("PJESA 11 — Plani i Matjes për Ditët e Mbetura"));
const remaining = Math.max(0, 30 - (DT.programDay || 0));
children.push(p(`Programi është në ditën ${DT.programDay} nga 30. Mbeten ${remaining} ditë. Ky është plani minimal që do t'i mbyllte boshllëqet e Pjesës 2.`));
const plan = [];
if (CS && CS.n < 15) plan.push(["Zinxhirë të plotë outbound", `${15 - CS.n}–${20 - CS.n} shtesë`, "Të shpërndara mes së paku 5 operatorëve dhe të dy turneve", `Konfirmon ose përgënjeshtron variancën ${nf(CS.spread, 1)}× dhe fikson numrin e personelit`]);
if (R.convergence) plan.push([R.convergence.process, "8–10 matje", "Të njëjtët operatorë, ditë të ndryshme", `Shpjegon variancën ${nf(R.convergence.spread, 1)}× — prioriteti më i lartë`]);
R.zeroProcesses.slice(0, 5).forEach((z) => plan.push([z, "5 matje", "Aktualisht zero", "Pa të, pjesa përkatëse e fluksit mbetet e pamatur"]));
if (R.emptyModules.includes("orders")) plan.push(["Order Flow (vulat kohore)", "20 porosi", "Claim → Dispatch për të njëjtën porosi", "E vetmja mënyrë për të kapur pritjen MES proceseve"]);
if (C.staffSkills < C.employees * 3) plan.push(["Matrica e aftësive", `${C.employees} punonjës × proceset kryesore`, `Sot ${C.staffSkills} regjistrime`, "Pa të nuk flagohen dot pikat e vetme të dështimit"]);
children.push(dataTable([2600, 1800, 2800, 3600], ["Çfarë të matet", "Sa mostra", "Si", "Pse"],
  plan.map((r) => [{ content: r[0], bold: true, shading: COLOR.lightBg }, { content: r[1], align: AlignmentType.CENTER }, r[2], r[3]])));
if (R.convergence) children.push(note(`Nëse duhet zgjedhur vetëm një gjë nga kjo listë: matni ${R.convergence.process}. Ka variancën më të lartë mes proceseve të emëruara si shkak, dhe është shkaku i shënuar në ${R.convergence.namedIn.length} vëzhgime.`, "warn"));
children.push(pageBreak());

// ================= PART 10 — recommendations =================
children.push(h1("PJESA 12 — Rekomandime me Prioritet"));
const rec = [];
if (DT.daysSinceLastEntry >= 2) rec.push(["Rifillo mbledhjen e të dhënave", `${DT.daysSinceLastEntry} ditë pa asnjë hyrje${R.overdueFollowUps.length ? `; ${R.overdueFollowUps.length} afate ndjekjeje të kaluara` : ""}`, "I ulët — 15–20 minuta në ditë", "Menjëherë"]);
if (R.convergence) rec.push([`Hulumto variancën e ${R.convergence.process} (${nf(R.convergence.spread, 1)}×)`, `${nf(R.convergence.min)} kundrejt ${nf(R.convergence.max)} sek/porosi; shkak i emëruar në ${R.convergence.namedIn.length} vëzhgime`, "I ulët — një bisedë dhe dy matje", "Këtë javë"]);
if (CS) rec.push(["Studio metodën e operatorit më të shpejtë", `${nf(CS.min)} sek/porosi kundrejt ${nf(CS.max)} — diferenca kushton deri në ${nf(R.capacity[2].personShifts - R.capacity[0].personShifts, 1)} person-turne në ditë`, "I ulët — vëzhgim i strukturuar", "Këtë javë"]);
const dispatchFail = R.observations.find((o) => /nuk ka shku|nuk ka arritur|vones/i.test(o.what + " " + o.impact));
if (dispatchFail) rec.push(["Vendos kontroll moshe për porositë e dërguara", `Vëzhgim: "${dispatchFail.what.slice(0, 70)}…"; asnjë proces nuk e kap një porosi që ngec pas dispatch-it`, "I ulët — një raport javor", "Këtë javë"]);
if (R.emptyModules.includes("orders")) rec.push(["Fillo Order Flow me vula kohore", "Pritja mes proceseve nuk matet fare sot", "Mesatar — 20 porosi të ndjekura", "Brenda 2 javësh"]);
if (C.staffSkills < C.employees * 3) rec.push(["Plotëso matricën e aftësive", `${C.staffSkills} regjistrime nga rreth ${C.employees * C.processes} kombinime`, "I ulët — një orë punë", "Brenda 2 javësh"]);
children.push(dataTable([500, 3000, 3400, 2100, 1800], ["#", "Veprimi", "Prova që e kërkon", "Mundi", "Afati"],
  rec.map((r, i) => [{ content: String(i + 1), bold: true, align: AlignmentType.CENTER },
    { content: r[0], bold: true, shading: COLOR.lightBg }, r[1], r[2], r[3]])));

children.push(h2("Përfundim"));
if (CS && R.convergence) {
  children.push(p(`${DT.nDays} ditë matjeje kanë prodhuar një gjetje që nuk dilte nga asnjë analizë e mëparshme: puna për porosi ndryshon ${nf(CS.spread, 1)} herë mes operatorëve, dhe ${R.convergence.process} ndryshon ${nf(R.convergence.spread, 1)} herë. Përpara se të kërkohet qoftë një punësim i vetëm, kjo variancë duhet kuptuar — sepse mbyllja e saj vlen më shumë se çdo rekrutim që Aneksi A i llogarit.`));
}
children.push(note(`Baza e kësaj analize: ${C.measurements} matje dhe ${C.observations} vëzhgime, ${DT.nDays} ditë nga 30, ${C.processes - R.zeroProcesses.length} procese të matura nga ${C.processes}. Asnjë përfundim këtu nuk duhet paraqitur si përfundimtar — por të gjithë janë mjaftueshëm të fortë për të vendosur se çfarë matet më pas.`, "info"));

// ================= HEADER / FOOTER =================
const header = new Header({ children: [new Paragraph({
  alignment: AlignmentType.RIGHT,
  children: [new TextRun({ text: "Aneks B — Analiza e të Dhënave të Vëzhgimit | SOP-WH-2026-01", size: 16, color: COLOR.mid, font: FONT })],
  border: { bottom: { color: COLOR.border, space: 4, style: BorderStyle.SINGLE, size: 4 } },
})]});
const footer = new Footer({ children: [new Paragraph({
  alignment: AlignmentType.CENTER,
  children: [
    new TextRun({ text: "Faqja ", size: 16, color: COLOR.mid, font: FONT }),
    new TextRun({ children: [PageNumber.CURRENT], size: 16, color: COLOR.mid, font: FONT }),
    new TextRun({ text: " / ", size: 16, color: COLOR.mid, font: FONT }),
    new TextRun({ children: [PageNumber.TOTAL_PAGES], size: 16, color: COLOR.mid, font: FONT }),
    new TextRun({ text: `   |   ${C.measurements} matje · ${C.observations} vëzhgime · ${DT.first}–${DT.last} · gjeneruar ${R.source.analyzedAt}`, size: 16, color: COLOR.accent, font: FONT, italics: true }),
  ],
})]});

const doc = new Document({
  creator: "Xhevat Llumnica",
  title: "Aneks B — Analiza e të Dhënave të Vëzhgimit",
  features: { updateFields: true },
  styles: {
    default: { document: { run: { font: FONT, size: 21, color: COLOR.text } } },
    paragraphStyles: [
      { id: "Heading1", name: "Heading 1", basedOn: "Normal", next: "Normal", quickFormat: true,
        run: { size: 32, bold: true, color: COLOR.dark, font: FONT },
        paragraph: { spacing: { before: 480, after: 240 }, outlineLevel: 0 } },
      { id: "Heading2", name: "Heading 2", basedOn: "Normal", next: "Normal", quickFormat: true,
        run: { size: 26, bold: true, color: COLOR.mid, font: FONT },
        paragraph: { spacing: { before: 320, after: 160 }, outlineLevel: 1 } },
      { id: "Heading3", name: "Heading 3", basedOn: "Normal", next: "Normal", quickFormat: true,
        run: { size: 23, bold: true, color: COLOR.accent, font: FONT },
        paragraph: { spacing: { before: 240, after: 120 }, outlineLevel: 2 } },
    ],
  },
  sections: [{
    properties: { page: { size: { width: 12240, height: 15840 }, margin: { top: 1080, bottom: 1080, left: 720, right: 720 } } },
    headers: { default: header }, footers: { default: footer }, children,
  }],
});

Packer.toBuffer(doc).then((buf) => {
  fs.writeFileSync(OUTFILE, buf);
  console.log("OK written", OUTFILE, buf.length, "bytes");
}).catch((e) => { console.error("BUILD ERROR", e); process.exit(1); });
