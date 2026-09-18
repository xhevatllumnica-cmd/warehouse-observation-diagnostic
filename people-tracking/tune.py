"""
tune.py — Vleftesim dhe akordim i parametrave te tracking-ut.

Detektimi eshte hapi i shtrenjte, tracking-u praktikisht falas. Prandaj te dy
nenkomandat punojne mbi nje cache detektimesh: detektimi behet NJE HERE, pastaj
qindra konfigurime tracking-u provohen ne sekonda.

    build    Ndertojne cache-in e detektimeve nga nje video.
    sweep    Grid search mbi parametrat; rendit sipas ID-ve unike.
    stress   Test occlusion-i: sa gjate mund te zhduket nje person pa humbur ID-ne.

PSE DUHET `stress`
------------------
Nje klip ku njerezit rrine ne vend nuk e teston tracking-un. Pyetja e vertete
eshte: **sa gjate mund te jete nje person i padetektuar dhe prapeseprape te
mbaje te njejtin `person_id`?** `stress` e mat kete direkt: fshin artificialisht
detektimet e nje personi per N frame rresht dhe kontrollon nese ID-ja mbijeton.
Rezultati eshte nje numer konkret ne sekonda, jo nje ndjesi.

Perdorim:
    python tune.py build  --video video.mp4 --out dets.pkl
    python tune.py sweep  --detections dets.pkl --expected-persons 3
    python tune.py stress --detections dets.pkl
"""

from __future__ import annotations

import argparse
import itertools
import json
import logging
import pickle
import sys
import warnings
from dataclasses import dataclass
from pathlib import Path
from typing import Dict, List, Optional, Sequence, Tuple

import numpy as np
import supervision as sv

from tracking import PersonTracker, TrackingConfig, TrackingStats

warnings.simplefilter("ignore", FutureWarning)
LOGGER = logging.getLogger("tune")


# --------------------------------------------------------------------------- #
# Cache
# --------------------------------------------------------------------------- #
def load_cache(path: str | Path) -> dict:
    payload = pickle.loads(Path(path).read_bytes())
    if "frames" not in payload:
        raise ValueError(f"{path} nuk duket si cache detektimesh (mungon 'frames')")
    return payload


def detections_for(frames: dict, frame_index: int, conf_floor: float = 0.0) -> sv.Detections:
    xyxy, conf = frames.get(frame_index, (np.zeros((0, 4)), np.zeros(0)))
    xyxy = np.asarray(xyxy, dtype=float).reshape(-1, 4)
    conf = np.asarray(conf, dtype=float).ravel()
    keep = conf >= conf_floor
    return sv.Detections(
        xyxy=xyxy[keep],
        confidence=conf[keep],
        class_id=np.zeros(int(keep.sum()), dtype=int),
    )


# --------------------------------------------------------------------------- #
# Replay
# --------------------------------------------------------------------------- #
@dataclass
class ReplayResult:
    stats: TrackingStats
    per_frame_ids: Dict[int, List[Tuple[int, np.ndarray]]]  # frame -> [(id, xyxy)]


def replay(
    frames: dict,
    source_fps: float,
    effective_fps: float,
    cfg: TrackingConfig,
    conf_floor: float = 0.0,
    drop: Optional[Dict[int, np.ndarray]] = None,
    reid_cfg=None,
    embeddings: Optional[Dict[int, Tuple[np.ndarray, np.ndarray]]] = None,
) -> ReplayResult:
    """Riprodhon tracking-un mbi detektimet e ruajtura.

    `drop` hartezon frame -> bbox; cdo detektim me IoU > 0.5 me ate bbox fshihet.
    Kjo simulon occlusion total te nje personi.

    Kur jepen `reid_cfg` dhe `embeddings`, aplikohet edhe shtresa e
    ri-identifikimit — keshtu testi mat efektin e saj te matshem.
    """
    tracker = PersonTracker(cfg)
    stats = TrackingStats()
    per_frame: Dict[int, List[Tuple[int, np.ndarray]]] = {}

    linker = None
    if reid_cfg is not None:
        from reid import ReIDLinker

        linker = ReIDLinker(reid_cfg)

    for fi in sorted(frames):
        dets = detections_for(frames, fi, conf_floor)
        if drop is not None and fi in drop and len(dets):
            keep = _iou_to_box(dets.xyxy, drop[fi]) <= 0.5
            dets = dets[keep]

        tracked = tracker.update(dets)

        if linker is not None and len(tracked):
            emb = _lookup_embeddings(embeddings, fi, tracked.xyxy, linker.embedder)
            tracked.tracker_id = linker.assign(
                None, tracked.xyxy, tracked.tracker_id, fi / source_fps, embeddings=emb
            )

        stats.update(tracked, fi / source_fps, raw_count=len(dets))
        per_frame[fi] = [
            (int(t), box.copy()) for t, box in zip(tracked.tracker_id, tracked.xyxy)
        ] if len(tracked) else []

    return ReplayResult(stats=stats, per_frame_ids=per_frame)


def _lookup_embeddings(
    store: Optional[Dict[int, Tuple[np.ndarray, np.ndarray]]],
    frame_index: int,
    xyxy: np.ndarray,
    embedder,
) -> np.ndarray:
    """Gjen nenshkrimet e para-llogaritura per kutite e track-uara te ketij frame-i.

    Tracker-i i kthen kutite e detektimit te pandryshuara, prandaj perputhja
    behet me kutine me IoU me te larte ne kete frame.
    """
    dim = getattr(embedder, "dim", 256)
    out = np.zeros((len(xyxy), dim), dtype=np.float32)
    if not store or frame_index not in store:
        return out
    boxes, embs = store[frame_index]
    if len(boxes) == 0:
        return out
    for i, box in enumerate(xyxy):
        ious = _iou_to_box(boxes, box)
        j = int(np.argmax(ious))
        if ious[j] > 0.5:
            out[i] = embs[j]
    return out


def precompute_embeddings(
    video: str, frames: dict, backend: str = "hist"
) -> Dict[int, Tuple[np.ndarray, np.ndarray]]:
    """Llogarit nje here nenshkrimin pamor per CDO detektim te ruajtur.

    Pa kete, testi i stresit (dhjetera riprodhime te te njejtit klip) do te
    ri-lexonte videon dhe do te ri-llogariste embedding-et cdo here.
    """
    import cv2

    from reid import build_embedder

    embedder = build_embedder(backend)
    cap = cv2.VideoCapture(video)
    if not cap.isOpened():
        raise RuntimeError(f"Nuk u hap dot videoja: {video}")

    from reid import ReIDLinker

    store: Dict[int, Tuple[np.ndarray, np.ndarray]] = {}
    wanted = set(frames)
    idx = -1
    while True:
        ok = cap.grab()
        if not ok:
            break
        idx += 1
        if idx not in wanted:
            continue
        ok, frame = cap.retrieve()
        if not ok:
            break
        boxes = np.asarray(frames[idx][0], dtype=float).reshape(-1, 4)
        if len(boxes) == 0:
            store[idx] = (boxes, np.zeros((0, embedder.dim), np.float32))
            continue
        crops = [ReIDLinker._crop(frame, b) for b in boxes]
        store[idx] = (boxes, embedder(crops))
    cap.release()
    LOGGER.info("Nenshkrime te para-llogaritura per %d frame", len(store))
    return store


def _iou_to_box(boxes: np.ndarray, ref: np.ndarray) -> np.ndarray:
    boxes = np.asarray(boxes, dtype=float).reshape(-1, 4)
    ref = np.asarray(ref, dtype=float).ravel()
    x1 = np.maximum(boxes[:, 0], ref[0])
    y1 = np.maximum(boxes[:, 1], ref[1])
    x2 = np.minimum(boxes[:, 2], ref[2])
    y2 = np.minimum(boxes[:, 3], ref[3])
    inter = np.clip(x2 - x1, 0, None) * np.clip(y2 - y1, 0, None)
    area_b = (boxes[:, 2] - boxes[:, 0]) * (boxes[:, 3] - boxes[:, 1])
    area_r = (ref[2] - ref[0]) * (ref[3] - ref[1])
    union = area_b + area_r - inter
    return np.where(union > 0, inter / union, 0.0)


def make_config(
    activation: float, high_conf: float, min_iou: float, min_consec: int,
    lost_buffer: int, effective_fps: float, algorithm: str = "bytetrack",
) -> TrackingConfig:
    return TrackingConfig(
        track_activation_threshold=activation,
        high_conf_det_threshold=high_conf,
        lost_track_buffer=lost_buffer,
        minimum_iou_threshold=min_iou,
        frame_rate=effective_fps,
        minimum_consecutive_frames=min_consec,
        algorithm=algorithm,
    )


# --------------------------------------------------------------------------- #
# build
# --------------------------------------------------------------------------- #
def cmd_build(args: argparse.Namespace) -> int:
    import subprocess

    cmd = [
        sys.executable, "main.py",
        "--video", args.video,
        "--save-detections", args.out,
        "--no-video",
        "--output-dir", args.output_dir,
        "--model", args.model,
        "--imgsz", str(args.imgsz),
        "--conf", str(args.conf),
        "--target-fps", str(args.target_fps),
    ]
    LOGGER.info("Po ndertohet cache-i i detektimeve (kjo eshte pjesa e ngadalte)...")
    return subprocess.call(cmd)


# --------------------------------------------------------------------------- #
# sweep
# --------------------------------------------------------------------------- #
def cmd_sweep(args: argparse.Namespace) -> int:
    payload = load_cache(args.detections)
    frames = payload["frames"]
    source_fps = args.source_fps
    effective_fps = source_fps / payload.get("step", 5)

    grid = list(itertools.product(
        _floats(args.conf_floor), _floats(args.activation), _floats(args.high_conf),
        _floats(args.min_iou), _ints(args.min_consecutive), _ints(args.lost_buffer),
    ))
    LOGGER.info("Po provohen %d kombinime mbi %d frame te ruajtur...", len(grid), len(frames))

    rows = []
    for conf_floor, activation, high_conf, min_iou, min_consec, lost in grid:
        cfg = make_config(activation, high_conf, min_iou, min_consec, lost,
                          effective_fps, args.tracker)
        res = replay(frames, source_fps, effective_fps, cfg, conf_floor=conf_floor)
        st = res.stats
        rows.append({
            "conf_floor": conf_floor, "activation": activation, "high_conf": high_conf,
            "min_iou": min_iou, "min_consecutive": min_consec, "lost_buffer": lost,
            "unique_ids": st.unique_ids,
            "avg_per_frame": round(st.avg_persons_per_frame, 3),
            "coverage": round(st.total_detections / max(st.raw_detections, 1), 3),
            "short_lived": len(st.short_lived_ids(3)),
        })

    expected = args.expected_persons
    # Renditja: sa afer numrit te pritur te personave, pastaj mbulimi me i madh.
    rows.sort(key=lambda r: (
        abs(r["unique_ids"] - expected) if expected else r["unique_ids"],
        -r["avg_per_frame"],
    ))

    hdr = f"{'conf':>5} {'act':>5} {'high':>5} {'mIoU':>5} {'cons':>4} {'lost':>5} | {'IDs':>4} {'avg/f':>6} {'mbul.':>6} {'shkurt':>6}"
    print(hdr)
    print("-" * len(hdr))
    for r in rows[: args.top]:
        print(f"{r['conf_floor']:5.2f} {r['activation']:5.2f} {r['high_conf']:5.2f} "
              f"{r['min_iou']:5.2f} {r['min_consecutive']:4d} {r['lost_buffer']:5d} | "
              f"{r['unique_ids']:4d} {r['avg_per_frame']:6.2f} {r['coverage']:6.2f} {r['short_lived']:6d}")

    if expected:
        ok = [r for r in rows if r["unique_ids"] == expected]
        print(f"\n{len(ok)} nga {len(rows)} konfigurime japin saktesisht {expected} ID.")
        if ok:
            b = ok[0]
            print("Me i miri (mbulimi me i madh me numrin e sakte te ID-ve):")
            print(f"  --conf {b['conf_floor']} --track-activation {b['activation']} "
                  f"--high-conf {b['high_conf']} --min-iou {b['min_iou']} "
                  f"--min-consecutive {b['min_consecutive']} --lost-buffer {b['lost_buffer']}")

    if args.out:
        Path(args.out).write_text(json.dumps(rows, indent=2), encoding="utf-8")
        print(f"\nRezultatet e plota -> {args.out}")
    return 0


# --------------------------------------------------------------------------- #
# stress
# --------------------------------------------------------------------------- #
def cmd_stress(args: argparse.Namespace) -> int:
    payload = load_cache(args.detections)
    frames = payload["frames"]
    source_fps = args.source_fps
    step = payload.get("step", 5)
    effective_fps = source_fps / step

    base_cfg = make_config(args.activation, args.high_conf, args.min_iou,
                           args.min_consecutive, args.lost_buffer, effective_fps, args.tracker)

    # ReID kerkon pamjen, prandaj aktivizohet vetem nese jepet videoja.
    reid_cfg = None
    embeddings = None
    if args.video:
        from reid import ReIDConfig

        reid_cfg = ReIDConfig(
            backend=args.reid_backend,
            similarity_threshold=args.reid_threshold,
            max_gap_sec=args.reid_max_gap,
            min_margin=args.reid_margin,
        )
        embeddings = precompute_embeddings(args.video, frames, args.reid_backend)

    def run_replay(drop=None, with_reid=False):
        return replay(
            frames, source_fps, effective_fps, base_cfg, conf_floor=args.conf_floor,
            drop=drop,
            reid_cfg=reid_cfg if with_reid else None,
            embeddings=embeddings if with_reid else None,
        )

    base = run_replay()

    tracked_frames = sorted(base.per_frame_ids)
    id_frames: Dict[int, List[int]] = {}
    for fi in tracked_frames:
        for tid, _ in base.per_frame_ids[fi]:
            id_frames.setdefault(tid, []).append(fi)

    long_ids = [t for t, fl in id_frames.items() if len(fl) >= args.min_track_frames]
    if not long_ids:
        print("Asnje track mjaftueshem i gjate per testim.")
        return 1

    print("=" * 78)
    print("  TEST OCCLUSION-I — sa gjate mund te zhduket nje person pa humbur ID-ne")
    print("=" * 78)
    print(f"  Baza: {base.stats.unique_ids} ID unike, {len(long_ids)} track te gjate te testueshem")
    print(f"  Konfigurimi: lost_buffer={args.lost_buffer} frame "
          f"(~{args.lost_buffer / effective_fps:.1f}s @ {effective_fps:.2f} fps), min_iou={args.min_iou}")
    print("-" * 78)
    header = f"  {'ID':>4} {'gap(frame)':>11} {'gap(sek)':>9}"
    if args.video:
        header += f" {'gap+ReID':>11} {'gap+ReID(s)':>11}"
    print(header)

    def max_survivable(tid: int, with_reid: bool) -> int:
        """Hendeku me i gjate qe ky person e kalon pa humbur ID-ne."""
        flist = id_frames[tid]
        start_idx = len(flist) // 3  # ne mes te track-ut, ku personi eshte i qendrueshem
        survived = 0
        for gap in range(1, args.max_gap + 1):
            gap_frames = flist[start_idx: start_idx + gap]
            if len(gap_frames) < gap:
                break
            drop = {fi: _box_of(base.per_frame_ids[fi], tid) for fi in gap_frames}
            drop = {k: v for k, v in drop.items() if v is not None}

            res = run_replay(drop=drop, with_reid=with_reid)
            after = [fi for fi in flist if fi > gap_frames[-1]][: args.check_frames]
            kept = any(tid in [t for t, _ in res.per_frame_ids.get(fi, [])] for fi in after)
            if not kept:
                break
            survived = gap
        return survived

    results = []
    for tid in sorted(long_ids):
        plain = max_survivable(tid, with_reid=False)
        line = (f"  {tid:>4} {plain:>11} {plain / effective_fps:>9.2f}")
        row = {
            "person_id": tid,
            "max_survivable_gap_frames": plain,
            "max_survivable_gap_sec": round(plain / effective_fps, 2),
        }
        if reid_cfg is not None:
            with_reid = max_survivable(tid, with_reid=True)
            line += f" {with_reid:>11} {with_reid / effective_fps:>11.2f}"
            row["max_survivable_gap_frames_reid"] = with_reid
            row["max_survivable_gap_sec_reid"] = round(with_reid / effective_fps, 2)
        print(line)
        results.append(row)

    print("-" * 78)
    worst = min(r["max_survivable_gap_sec"] for r in results)
    best = max(r["max_survivable_gap_sec"] for r in results)
    print("  PERFUNDIM")
    print(f"    Vetem tracking : person i padetektuar per {worst:.1f}-{best:.1f} s "
          f"-> ID-ja mbijeton.")
    if reid_cfg is not None:
        rworst = min(r["max_survivable_gap_sec_reid"] for r in results)
        rbest = max(r["max_survivable_gap_sec_reid"] for r in results)
        improved = [r for r in results
                    if r["max_survivable_gap_sec_reid"] > r["max_survivable_gap_sec"]]
        ceiling = [r for r in results
                   if r["max_survivable_gap_frames_reid"] >= args.max_gap]
        print(f"    Me ReID        : {rworst:.1f}-{rbest:.1f} s.")
        print(f"    -> permiresim per {len(improved)} nga {len(results)} persona"
              + (f" (ID: {[r['person_id'] for r in improved]})" if improved else ""))
        if ceiling:
            print(f"    -> ID {[r['person_id'] for r in ceiling]} arriten tavanin e testit "
                  f"(--max-gap {args.max_gap}); kufiri real eshte me i larte.")
        if not improved:
            print("    -> Per personat e tjere ReID refuzoi bashkimin: shih 'te refuzuara si")
            print("       te paqarta' — dy persona prane njeri-tjetrit duken shume ngjashem.")
    print("    Kufizuesi nuk eshte --lost-buffer por rreshqitja e filtrit Kalman:")
    print("    kutia e parashikuar largohet nga pozicioni real dhe IoU bie nen prag.")
    print("=" * 78)

    if args.out:
        Path(args.out).write_text(json.dumps(results, indent=2), encoding="utf-8")
        print(f"Rezultatet -> {args.out}")
    return 0


def _box_of(entries: Sequence[Tuple[int, np.ndarray]], tid: int) -> Optional[np.ndarray]:
    for t, box in entries:
        if t == tid:
            return box
    return None


# --------------------------------------------------------------------------- #
# CLI
# --------------------------------------------------------------------------- #
def _floats(raw: str) -> List[float]:
    return [float(v) for v in str(raw).split(",") if v.strip()]


def _ints(raw: str) -> List[int]:
    return [int(v) for v in str(raw).split(",") if v.strip()]


def main(argv: Optional[List[str]] = None) -> int:
    p = argparse.ArgumentParser(description="Akordim dhe vleftesim i tracking-ut.")
    sub = p.add_subparsers(dest="cmd", required=True)

    b = sub.add_parser("build", help="Ndertoje cache-in e detektimeve nga nje video")
    b.add_argument("--video", required=True)
    b.add_argument("--out", default="dets.pkl")
    b.add_argument("--output-dir", default="output/tune")
    b.add_argument("--model", default="yolov8m.pt")
    b.add_argument("--imgsz", type=int, default=1280)
    b.add_argument("--conf", type=float, default=0.15)
    b.add_argument("--target-fps", type=float, default=6.0)
    b.set_defaults(func=cmd_build)

    s = sub.add_parser("sweep", help="Grid search mbi parametrat e tracking-ut")
    s.add_argument("--detections", required=True)
    s.add_argument("--source-fps", type=float, default=29.93)
    s.add_argument("--tracker", default="bytetrack",
                   choices=["bytetrack", "botsort", "ocsort", "sort"])
    s.add_argument("--conf-floor", default="0.15,0.25")
    s.add_argument("--activation", default="0.35,0.50")
    s.add_argument("--high-conf", default="0.35,0.50")
    s.add_argument("--min-iou", default="0.10,0.20,0.30")
    s.add_argument("--min-consecutive", default="1,2")
    s.add_argument("--lost-buffer", default="30,60")
    s.add_argument("--expected-persons", type=int, default=0)
    s.add_argument("--top", type=int, default=15)
    s.add_argument("--out", default=None)
    s.set_defaults(func=cmd_sweep)

    t = sub.add_parser("stress", help="Test i qendrueshmerise ndaj occlusion-it")
    t.add_argument("--detections", required=True)
    t.add_argument("--source-fps", type=float, default=29.93)
    t.add_argument("--tracker", default="bytetrack",
                   choices=["bytetrack", "botsort", "ocsort", "sort"])
    t.add_argument("--conf-floor", type=float, default=0.15)
    t.add_argument("--activation", type=float, default=0.35)
    t.add_argument("--high-conf", type=float, default=0.50)
    t.add_argument("--min-iou", type=float, default=0.10)
    t.add_argument("--min-consecutive", type=int, default=1)
    t.add_argument("--lost-buffer", type=int, default=60)
    t.add_argument("--max-gap", type=int, default=25, help="Hendeku maksimal i testuar (frame)")
    t.add_argument("--check-frames", type=int, default=5,
                   help="Sa frame pas hendekut kontrollohen per rikthimin e ID-se")
    t.add_argument("--min-track-frames", type=int, default=30)
    t.add_argument("--video", default=None,
                   help="Videoja origjinale; e detyrueshme per te matur edhe efektin e ReID-it")
    t.add_argument("--reid-backend", default="hist", choices=["hist", "cnn"])
    t.add_argument("--reid-threshold", type=float, default=0.80)
    t.add_argument("--reid-max-gap", type=float, default=30.0)
    t.add_argument("--reid-margin", type=float, default=0.05)
    t.add_argument("--out", default=None)
    t.set_defaults(func=cmd_stress)

    args = p.parse_args(argv)
    logging.basicConfig(level=logging.WARNING, format="%(message)s")
    return args.func(args)


if __name__ == "__main__":
    raise SystemExit(main())
