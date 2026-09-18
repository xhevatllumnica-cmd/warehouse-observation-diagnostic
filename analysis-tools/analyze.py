#!/usr/bin/env python3
"""
Warehouse Observation & Diagnostic System — analizë e automatizuar.

Lexon backup-in JSON më të fundit nga një dosje, llogarit të gjitha treguesit,
gjeneron grafikët, dhe shkruan metrics.json që e konsumon build_analysis.js.

Përdorimi:  python3 analyze.py <dosja_me_backup> <dosja_dalese>
"""
import json, sys, os, glob, datetime
from collections import defaultdict, Counter

import matplotlib
matplotlib.use("Agg")
import matplotlib.pyplot as plt

SRC = sys.argv[1] if len(sys.argv) > 1 else "/mnt/user-data/uploads/Warehouse"
OUT = sys.argv[2] if len(sys.argv) > 2 else "/home/claude/warehouse_sop"

# ---------- design tokens (validated palette, light surface) ----------
SURFACE, INK, INK2, MUTED, GRID, AXIS = "#ffffff", "#0b0b0b", "#52514e", "#898781", "#e1e0d9", "#c3c2b7"
S1, S2 = "#2a78d6", "#eb6834"
plt.rcParams.update({
    "font.family": "DejaVu Sans", "font.size": 9,
    "figure.facecolor": SURFACE, "axes.facecolor": SURFACE, "text.color": INK,
    "axes.labelcolor": INK2, "xtick.color": MUTED, "ytick.color": INK2, "axes.edgecolor": AXIS,
})

# ---------- load newest backup ----------
cands = sorted(glob.glob(os.path.join(SRC, "*backup*.json")), key=os.path.getmtime)
if not cands:
    print("ERROR: nuk u gjet asnjë skedar backup JSON në", SRC); sys.exit(2)
SRC_FILE = cands[-1]
D = json.load(open(SRC_FILE, encoding="utf-8"))

pn = {p["id"]: p["name"] for p in D.get("processes", [])}
en = {e["id"]: e["name"] for e in D.get("employees", [])}
M = D.get("measurements", [])
OBS = D.get("observations", [])

R = {}  # results
R["source"] = {
    "file": os.path.basename(SRC_FILE),
    "fileMtime": datetime.datetime.fromtimestamp(os.path.getmtime(SRC_FILE)).strftime("%Y-%m-%d %H:%M"),
    "sizeKB": round(os.path.getsize(SRC_FILE) / 1024),
    "analyzedAt": datetime.datetime.now().strftime("%Y-%m-%d %H:%M"),
    "warehouseName": D.get("config", {}).get("warehouseName", "—"),
    "startDate": D.get("config", {}).get("startDate", "—"),
}

# ---------- volumes ----------
R["counts"] = {k: len(D.get(k, [])) for k in
               ["measurements", "observations", "employees", "processes", "staffSkills",
                "validations", "audit", "orders", "products", "staffObs", "problems",
                "kpiRecords", "hqInteractions", "quickWins", "briefings"]}

dates = sorted({m["date"] for m in M} | {o["date"] for o in OBS})
R["dates"] = {"covered": dates, "nDays": len(dates), "first": dates[0] if dates else None,
              "last": dates[-1] if dates else None}

start = D.get("config", {}).get("startDate")
today = datetime.date.today()
if start:
    sd = datetime.date.fromisoformat(start)
    R["dates"]["programDay"] = (today - sd).days + 1
if dates:
    ld = datetime.date.fromisoformat(dates[-1])
    R["dates"]["daysSinceLastEntry"] = (today - ld).days

# ---------- processing vs waiting ----------
tp = sum(m.get("processingSec") or 0 for m in M)
tw = sum(m.get("waitingSec") or 0 for m in M)
nz = [m for m in M if (m.get("waitingSec") or 0) > 0]
R["time"] = {
    "processingHours": round(tp / 3600, 2), "waitingHours": round(tw / 3600, 2),
    "waitingSharePct": round(tw / (tp + tw) * 100, 1) if (tp + tw) else 0,
    "measurementsWithWaiting": len(nz), "measurementsTotal": len(M),
    "waitingCapturePct": round(len(nz) / len(M) * 100) if M else 0,
    "interruptions": sum(m.get("interruptions") or 0 for m in M),
    "rework": sum(m.get("rework") or 0 for m in M),
}

# ---------- per process ----------
g = defaultdict(lambda: {"n": 0, "proc": 0, "wait": 0, "orders": 0})
for m in M:
    k = pn.get(m["processId"], "?")
    g[k]["n"] += 1
    g[k]["proc"] += m.get("processingSec") or 0
    g[k]["wait"] += m.get("waitingSec") or 0
    g[k]["orders"] += m.get("orders") or 0
per_proc = []
for name, v in sorted(g.items(), key=lambda kv: -(kv[1]["proc"] + kv[1]["wait"])):
    tot = v["proc"] + v["wait"]
    per_proc.append({"name": name, "n": v["n"], "procMin": round(v["proc"] / 60),
                     "waitMin": round(v["wait"] / 60), "orders": v["orders"],
                     "waitPct": round(v["wait"] / tot * 100) if tot else 0})
R["perProcess"] = per_proc
R["worstWaiting"] = max(per_proc, key=lambda x: x["waitPct"]) if per_proc else None

# ---------- coverage ----------
measured = Counter(pn.get(m["processId"]) for m in M)
R["coverage"] = [{"name": p["name"], "category": p.get("category", ""),
                  "n": measured.get(p["name"], 0)} for p in D.get("processes", [])]
R["zeroProcesses"] = [c["name"] for c in R["coverage"] if c["n"] == 0]

skl = Counter(en.get(s["employeeId"]) for s in D.get("staffSkills", []))
mc = Counter(en.get(m.get("employeeId")) for m in M)
R["staff"] = [{"name": e["name"], "shift": e.get("shift", "—"),
               "measurements": mc.get(e["name"], 0), "skills": skl.get(e["name"], 0)}
              for e in sorted(D.get("employees", []), key=lambda x: -mc.get(x["name"], 0))]
R["staffNoMeasurements"] = [s["name"] for s in R["staff"] if s["measurements"] == 0]
R["staffNoSkills"] = [s["name"] for s in R["staff"] if s["skills"] == 0]
R["emptyModules"] = [k for k in ["orders", "products", "staffObs", "problems", "kpiRecords",
                                 "hqInteractions", "quickWins", "briefings"] if not D.get(k)]

# ---------- per-order rates ----------
OUTB = ("Claim", "Picking", "Packing/Check-out", "Check-out", "Packing")
rates = defaultdict(list)
for m in M:
    o = m.get("orders")
    if o and (m.get("processingSec") or 0) > 0:
        rates[pn.get(m["processId"])].append({
            "date": m["date"], "time": m.get("time"), "emp": en.get(m.get("employeeId")),
            "orders": o, "units": m.get("units"), "secPerOrder": round((m["processingSec"]) / o, 1)})
R["rates"] = {k: sorted(v, key=lambda x: x["secPerOrder"]) for k, v in rates.items()}
R["rateStats"] = {}
for k, v in rates.items():
    vals = [x["secPerOrder"] for x in v]
    # drop single-order measurements from spread stats (not comparable)
    comp = [x["secPerOrder"] for x in v if x["orders"] > 1]
    if comp:
        R["rateStats"][k] = {"n": len(v), "min": min(comp), "max": max(comp),
                             "avg": round(sum(comp) / len(comp), 1),
                             "spread": round(max(comp) / min(comp), 1) if min(comp) else None}

# ---------- complete outbound chains ----------
ch = defaultdict(dict)
for m in M:
    p = pn.get(m["processId"])
    if p in ("Claim", "Picking", "Packing/Check-out") and m.get("orders"):
        ch[(m["date"], en.get(m.get("employeeId")), m["orders"])][p] = {
            "proc": m.get("processingSec") or 0, "wait": m.get("waitingSec") or 0,
            "units": m.get("units")}
chains = []
for (date, emp, orders), v in ch.items():
    if set(v) == {"Claim", "Picking", "Packing/Check-out"}:
        proc = sum(x["proc"] for x in v.values())
        wait = sum(x["wait"] for x in v.values())
        units = next((x["units"] for x in v.values() if x["units"]), None)
        chains.append({"date": date, "emp": emp, "orders": orders, "units": units,
                       "procSec": proc, "waitSec": wait,
                       "secPerOrder": round(proc / orders, 1),
                       "minPerOrder": round(proc / orders / 60, 1),
                       "unitsPerOrder": round(units / orders, 1) if units else None})
chains.sort(key=lambda c: c["secPerOrder"])
R["chains"] = chains
if chains:
    sp = [c["secPerOrder"] for c in chains]
    avg = sum(sp) / len(sp)
    R["chainStats"] = {"n": len(sp), "min": min(sp), "max": max(sp), "avg": round(avg, 1),
                       "spread": round(max(sp) / min(sp), 1)}
    R["capacity"] = []
    for label, v in [("Ritmi më i shpejtë i vëzhguar", min(sp)),
                     ("Mesatarja e vëzhguar", avg),
                     ("Ritmi më i ngadaltë i vëzhguar", max(sp))]:
        hours = 1000 * v / 3600
        R["capacity"].append({"label": label, "secPerOrder": round(v),
                              "hoursPerDay": round(hours, 1),
                              "personShifts": round(hours / 6.5, 1)})
    # bottom-up cross check vs Annex A top-down 84
    mapping = R["rateStats"].get("Mapping", {}).get("avg", 0)
    partial = avg + mapping
    R["crossCheck"] = {"outboundAvg": round(avg, 1), "mappingAvg": mapping,
                       "partialTotal": round(partial, 1),
                       "ordersPerPersonShift": round(6.5 * 3600 / partial, 1) if partial else None,
                       "annexATopDown": 84}
    if R["crossCheck"]["ordersPerPersonShift"]:
        R["crossCheck"]["deltaPct"] = round(
            (R["crossCheck"]["ordersPerPersonShift"] - 84) / 84 * 100, 1)

# ---------- quantity gaps: labor that cannot be converted to per-order rates ----------
qg = defaultdict(lambda: {"n": 0, "orders": 0, "units": 0, "packages": 0, "laborSec": 0})
for m in M:
    k = pn.get(m["processId"], "?")
    w = m.get("workers") or 1
    qg[k]["n"] += 1
    qg[k]["laborSec"] += (m.get("processingSec") or 0) * w
    for f in ("orders", "units", "packages"):
        if m.get(f) not in (None, ""):
            qg[k][f] += 1
R["quantityGaps"] = [{"process": k, **v,
                      "laborHours": round(v["laborSec"] / 3600, 2),
                      "convertible": v["orders"] > 0}
                     for k, v in sorted(qg.items(), key=lambda kv: -kv[1]["laborSec"])]
R["fieldCoverage"] = {f: sum(1 for m in M if m.get(f) not in (None, "")) for f in
                      ("orders", "lines", "units", "packages")}
outside = [g for g in R["quantityGaps"] if not g["convertible"]]
R["laborOutsideModel"] = {
    "processes": [g["process"] for g in outside],
    "hours": round(sum(g["laborSec"] for g in outside) / 3600, 2),
    "sharePct": round(sum(g["laborSec"] for g in outside) /
                      max(1, sum(g["laborSec"] for g in R["quantityGaps"])) * 100, 1),
}
# what adding a package-measured process to the per-order model would do
rec = next((g for g in R["quantityGaps"] if g["process"] == "Receiving" and g["packages"]), None)
if rec and R.get("crossCheck"):
    pkgs = sum(m.get("packages") or 0 for m in M if pn.get(m["processId"]) == "Receiving")
    if pkgs:
        sec_per_pkg = rec["laborSec"] / pkgs
        base = R["crossCheck"]["partialTotal"]
        R["bridgeScenarios"] = {
            "secPerPackage": round(sec_per_pkg, 1), "packagesMeasured": pkgs,
            "base": base,
            "rows": [{"assumption": lbl, "secPerOrder": round(base + sec_per_pkg / ratio, 1),
                      "ordersPerPersonShift": round(6.5 * 3600 / (base + sec_per_pkg / ratio), 1)}
                     for lbl, ratio in [("siç llogaritet sot (Receiving jashtë modelit)", 1e9),
                                        ("nëse 1 pako = 3 porosi", 3),
                                        ("nëse 1 pako = 2 porosi", 2),
                                        ("nëse 1 pako = 1 porosi", 1)]],
        }

# ---------- observations ----------
sev_rank = {"Critical": 0, "Important": 1, "Improvement": 2, "": 3, None: 3}
obs_rows = []
for o in OBS:
    obs_rows.append({
        "date": o["date"], "time": o.get("time"), "type": o.get("type") or "—",
        "process": pn.get(o.get("processId")) or "—",
        "what": (o.get("what") or "").replace("\n", " ").strip(),
        "impact": (o.get("impact") or "").replace("\n", " ").strip(),
        "cause": o.get("cause") or o.get("errorDetail") or "—",
        "severity": o.get("severity") or "—",
        "status": o.get("status") or "—",
        "waitingMin": o.get("waitingMin"),
        "followUp": o.get("followUpDate") or None,
    })
obs_rows.sort(key=lambda r: (sev_rank.get(r["severity"], 3), r["date"]))
R["observations"] = obs_rows
R["severityCounts"] = Counter(r["severity"] for r in obs_rows)
R["overdueFollowUps"] = [r for r in obs_rows if r["followUp"] and
                         datetime.date.fromisoformat(r["followUp"]) < today]
causes = Counter(r["cause"] for r in obs_rows if r["cause"] != "—")
R["namedCauses"] = causes.most_common()

# converging-evidence check: a process that BOTH has high measured spread AND is
# named as a cause in the observations. Ranking is reported separately so a spread
# driven by very small absolute values stays visible rather than hidden.
R["spreadRanking"] = sorted(
    [{"process": k, **v} for k, v in R["rateStats"].items() if v["n"] >= 2],
    key=lambda x: -(x["spread"] or 0))
def _named_for(proc):
    stem = proc.lower()[:4]
    return [c for c, _ in R["namedCauses"] if stem in c.lower()]
R["namedCauseProcesses"] = [{"process": r["process"], "spread": r["spread"],
                             "namedIn": _named_for(r["process"])}
                            for r in R["spreadRanking"] if _named_for(r["process"])]
R["convergence"] = (R["namedCauseProcesses"][0] if R["namedCauseProcesses"] else None)
if R["convergence"]:
    R["convergence"]["isConverging"] = True
    st = next(r for r in R["spreadRanking"] if r["process"] == R["convergence"]["process"])
    R["convergence"].update({"min": st["min"], "max": st["max"], "n": st["n"]})

R["validations"] = [{k: v.get(k) for k in ("date", "source", "claim", "observed", "data",
                                           "finding", "status")} for v in D.get("validations", [])]

# ---------- staff observations (person / process / system / capacity) ----------
R["staffObs"] = []
for s in D.get("staffObs", []):
    emps = [en.get(e, e) for e in (s.get("employees") or ([s["employeeId"]] if s.get("employeeId") else []))]
    R["staffObs"].append({
        "date": s.get("date"), "attribution": s.get("attribution") or "—",
        "situation": (s.get("situation") or "").replace("\n", " ").strip(),
        "observation": (s.get("observation") or "").replace("\n", " ").strip(),
        "evidence": (s.get("evidence") or "").replace("\n", " ").strip(),
        "result": (s.get("result") or "").replace("\n", " ").strip(),
        "cause": (s.get("cause") or "—").replace("\n", " ").strip(),
        "employees": sorted(set(e for e in emps if e)),
    })
R["staffObsByAttribution"] = dict(Counter(x["attribution"] for x in R["staffObs"]))

# ---------- HQ interface ----------
dn = {d["id"]: d["name"] for d in D.get("departments", [])}
R["hq"] = [{
    "department": dn.get(h.get("departmentId"), "—"), "date": h.get("date"),
    "receive": (h.get("receive") or "").replace("\n", " ").strip(),
    "send": (h.get("send") or "").replace("\n", " ").strip(),
    "problem": (h.get("problem") or "").replace("\n", " ").strip(),
    "expectation": (h.get("expectation") or h.get("expectations") or "").replace("\n", " ").strip(),
} for h in D.get("hqInteractions", [])]

# ---------- audit activity ----------
R["activity"] = sorted(Counter(a["at"][:10] for a in D.get("audit", [])).items())

# =================== CHARTS ===================
def style(ax, xlabel=None):
    ax.spines["top"].set_visible(False); ax.spines["right"].set_visible(False)
    ax.spines["left"].set_visible(False); ax.spines["bottom"].set_color(AXIS)
    ax.spines["bottom"].set_linewidth(0.8)
    ax.xaxis.grid(True, color=GRID, linewidth=0.7); ax.set_axisbelow(True)
    ax.yaxis.grid(False); ax.tick_params(length=0)
    if xlabel: ax.set_xlabel(xlabel, color=INK2, fontsize=8.5, labelpad=8)

charts = {}

# Chart 1 — variance across complete chains
if chains:
    labels = [f"{c['emp']} · {c['date'][8:10]}.{c['date'][5:7]} · {c['orders']} porosi" for c in chains]
    vals = [c["secPerOrder"] for c in chains]
    avg = R["chainStats"]["avg"]
    fig, ax = plt.subplots(figsize=(7.2, max(2.2, 0.62 * len(vals) + 1.0)), dpi=200)
    y = list(range(len(vals)))
    ax.barh(y, vals, height=0.55, color=S1, zorder=3)
    ax.axvline(avg, color=MUTED, linewidth=1.2, linestyle=(0, (4, 3)), zorder=4)
    ax.text(avg + max(vals) * 0.02, 0.55, f"mesatarja {avg:.0f}s", color=MUTED, fontsize=8, va="center")
    for i, v in enumerate(vals):
        ax.text(v + max(vals) * 0.015, i, f"{v:.0f}s  ({v/60:.1f} min)", va="center", color=INK, fontsize=8.5)
    ax.set_yticks(y); ax.set_yticklabels(labels, fontsize=8.5); ax.invert_yaxis()
    ax.set_xlim(0, max(vals) * 1.32)
    style(ax, "Sekonda pune për porosi (Claim + Picking + Packing/Check-out)")
    ax.set_title(f"Puna për porosi ndryshon {R['chainStats']['spread']:.1f} herë mes operatorëve".replace(".", ","),
                 loc="left", color=INK, fontsize=11, fontweight="bold", pad=12)
    fig.tight_layout(); fig.savefig(os.path.join(OUT, "chart1_variance.png"), facecolor=SURFACE, bbox_inches="tight")
    plt.close(fig); charts["variance"] = "chart1_variance.png"

# Chart 2 — processing vs waiting
if per_proc:
    names = [r["name"] for r in per_proc]
    proc = [r["procMin"] for r in per_proc]
    wait = [r["waitMin"] for r in per_proc]
    fig, ax = plt.subplots(figsize=(7.2, max(2.4, 0.44 * len(names) + 1.3)), dpi=200)
    y = list(range(len(names)))
    ax.barh(y, proc, height=0.55, color=S1, label="Kohë pune (processing)", zorder=3)
    wd = [w if w >= 1 else 0 for w in wait]
    ax.barh(y, wd, left=[p + 1.2 if w >= 1 else p for p, w in zip(proc, wait)],
            height=0.55, color=S2, label="Kohë pritjeje (waiting)", zorder=3)
    mx = max(p + w for p, w in zip(proc, wait)) or 1
    for i, (p_, w_, r_) in enumerate(zip(proc, wait, per_proc)):
        if w_ >= 1:
            ax.text(p_ + w_ + mx * 0.02, i, f"{w_} min pritje ({r_['waitPct']}%)", va="center", color=INK, fontsize=8.2)
        else:
            ax.text(p_ + mx * 0.02, i, "pa pritje të regjistruar", va="center", color=MUTED, fontsize=8.2)
    ax.set_yticks(y); ax.set_yticklabels(names, fontsize=8.5); ax.invert_yaxis()
    ax.set_xlim(0, mx * 1.45)
    style(ax, f"Minuta të matura gjithsej ({R['dates']['first']} – {R['dates']['last']})")
    ww = R["worstWaiting"]
    ax.set_title(f"Pritja është e përqendruar te {ww['name']} — {ww['waitPct']}% e kohës së matur",
                 loc="left", color=INK, fontsize=11, fontweight="bold", pad=12)
    ax.legend(frameon=False, loc="lower right", fontsize=8.5, labelcolor=INK2)
    fig.tight_layout(); fig.savefig(os.path.join(OUT, "chart2_waiting.png"), facecolor=SURFACE, bbox_inches="tight")
    plt.close(fig); charts["waiting"] = "chart2_waiting.png"

R["charts"] = charts

with open(os.path.join(OUT, "metrics.json"), "w", encoding="utf-8") as f:
    json.dump(R, f, ensure_ascii=False, indent=1, default=str)

print(f"OK  burimi: {R['source']['file']}  |  {R['counts']['measurements']} matje, "
      f"{R['counts']['observations']} vëzhgime, {R['dates']['nDays']} ditë  |  "
      f"zinxhirë të plotë: {len(chains)}")
