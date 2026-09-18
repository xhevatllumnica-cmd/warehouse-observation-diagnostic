"""
main.py — Pipeline i plote: video hyrese -> video e anotuar + results.csv.

FAZA 1 (pilot) + infrastruktura e pergatitur per Fazen 2:
  * detektim personash (YOLO) + tracking me ID te qendrueshem (ByteTrack)
  * ankorim BOTTOM_CENTER (pika e kontaktit me dyshemene)
  * opsionalisht koordinata metrike mbi dysheme (`--calibration`)
  * opsionalisht ri-identifikim pamor per hendeqe te gjata (`--reid`)

Privatesi: nuk behet asnje njohje fytyre apo identifikim emeror. `person_id`
eshte nje numer i perkohshem, i vlefshem VETEM brenda ketij klipi.

Perdorim:
    python main.py --video "shtegu/drejt/video.mp4"
    python main.py --video video.mp4 --device cuda --model yolov8l.pt
    python main.py --video video.mp4 --calibration calib.json --reid
"""

from __future__ import annotations

import argparse
import csv
import json
import logging
import pickle
import sys
import time
from pathlib import Path
from typing import List, Optional

import cv2
import numpy as np
import supervision as sv

from calibration import GroundPlaneCalibration, bbox_anchor
from detection import DetectionConfig, PersonDetector
from tracking import PersonTracker, TrackAnnotator, TrackingConfig, TrackingStats

LOGGER = logging.getLogger("pilot")

# Tete kolonat e para jane kontrata origjinale e Fazes 1 dhe nuk ndryshojne.
# Kolonat pasuese jane shtesa additive per Fazen 2.
CSV_COLUMNS = [
    "frame_id",
    "timestamp_sec",
    "person_id",
    "bbox_x",
    "bbox_y",
    "bbox_width",
    "bbox_height",
    "confidence_score",
    # --- shtesa ---
    "anchor_x",      # BOTTOM_CENTER i bbox-it, piksele
    "anchor_y",
    "ground_x_m",    # e njejta pike ne metra mbi dysheme (bosh pa kalibrim)
    "ground_y_m",
]


# --------------------------------------------------------------------------- #
# CLI
# --------------------------------------------------------------------------- #
def parse_args(argv: Optional[List[str]] = None) -> argparse.Namespace:
    p = argparse.ArgumentParser(
        description="Faza 1 — Detektim + tracking personash nga video magazine.",
        formatter_class=argparse.ArgumentDefaultsHelpFormatter,
    )

    # Hyrje / dalje
    p.add_argument("--video", required=True, help="Shtegu i videos hyrese (.mp4)")
    p.add_argument("--output-dir", default="output", help="Direktoria e rezultateve")
    p.add_argument("--csv-name", default="results.csv")
    p.add_argument("--video-name", default="annotated.mp4")
    p.add_argument("--no-video", action="store_true", help="Mos gjenero video output")

    # Mostrimi
    p.add_argument(
        "--target-fps",
        type=float,
        default=6.0,
        help="Frame/sekonde qe procesohen (0 = cdo frame i videos)",
    )
    p.add_argument("--max-frames", type=int, default=0, help="Kufizo frame-t e procesuar (0 = pa kufi)")

    # Detektimi
    p.add_argument("--model", default="yolov8m.pt", help="yolov8n/s/m/l/x.pt ose yolo11n/s/m/l/x.pt")
    p.add_argument(
        "--conf",
        type=float,
        default=0.15,
        help="Confidence threshold i detektorit (i ulet me qellim: ushqim per ByteTrack)",
    )
    p.add_argument("--iou", type=float, default=0.55, help="NMS IoU threshold")
    p.add_argument("--imgsz", type=int, default=1280, help="Rezolucioni i inference-it")
    p.add_argument("--device", default="auto", help="auto | cpu | cuda | 0")
    p.add_argument("--half", action=argparse.BooleanOptionalAction, default=None,
                   help="Inference FP16. Default: aktiv automatikisht ne CUDA, joaktiv ne CPU")
    p.add_argument("--slice", dest="use_slicing", action="store_true",
                   help="Ndaj frame-in ne rajone (ndihmon te skajet fisheye / personat e vegjel)")
    p.add_argument("--slice-size", type=int, default=960)
    p.add_argument("--slice-overlap", type=float, default=0.2)

    # Tracking
    p.add_argument("--tracker", default="bytetrack",
                   choices=["bytetrack", "botsort", "ocsort", "sort"],
                   help="Algoritmi i tracking-ut")
    p.add_argument("--track-activation", type=float, default=0.35,
                   help="Besueshmeria minimale qe nis nje track te ri")
    p.add_argument("--lost-buffer", type=int, default=60,
                   help="Frame-t (ne fps-ne e mostrimit) qe nje track mbahet gjalle gjate occlusion-it")
    p.add_argument("--min-iou", type=float, default=0.10,
                   help="IoU minimal per matching track<->detektim")
    p.add_argument("--high-conf", type=float, default=0.50,
                   help="Ndarja high/low confidence e ByteTrack-ut (te uletat perdoren vetem per asociim)")
    p.add_argument("--tracker-backend", default="auto", choices=["auto", "trackers", "supervision"],
                   help="Implementimi i ByteTrack-ut qe perdoret")
    p.add_argument("--min-consecutive", type=int, default=1,
                   help="Frame rresht para se nje track te raportohet (>1 heq false positives)")
    p.add_argument("--no-cmc", action="store_true",
                   help="Cakti kompensimin e levizjes se kameres (vetem --tracker botsort)")

    # Ri-identifikim pamor
    p.add_argument("--reid", action="store_true",
                   help="Aktivizo ri-identifikimin pamor per hendeqe te gjata occlusion-i")
    p.add_argument("--reid-backend", default="hist", choices=["hist", "cnn"])
    p.add_argument("--reid-threshold", type=float, default=0.80,
                   help="Ngjashmeria minimale (kosinus) per te bashkuar dy ID")
    p.add_argument("--reid-max-gap", type=float, default=30.0,
                   help="Sekonda pas te cilave nje ID e humbur nuk ri-lidhet me")
    p.add_argument("--reid-margin", type=float, default=0.05,
                   help="Diferenca minimale nga kandidati i dyte (mbron nga bashkimi i gabuar)")

    # Kalibrimi toke-plan
    p.add_argument("--calibration", default=None, metavar="PATH",
                   help="JSON i kalibrimit toke-plan; shton koordinata metrike ne CSV")

    # Vizualizim / raport
    p.add_argument("--no-traces", action="store_true", help="Mos vizato gjurmen e levizjes")
    p.add_argument("--trace-length", type=int, default=30)
    p.add_argument("--expected-persons", type=int, default=0,
                   help="Sa persona prisni realisht ne klip (per indikatorin e ID-switching)")
    p.add_argument("--verbose", action="store_true")

    # Cache i detektimeve — detektimi eshte hapi i shtrenjte; ruajtja e tij lejon
    # rinisjen e tracking-ut me parametra te tjere pa e perseritur YOLO-n.
    p.add_argument("--save-detections", default=None, metavar="PATH",
                   help="Ruaj detektimet e papershkuara nga tracking-u ne kete file")
    p.add_argument("--load-detections", default=None, metavar="PATH",
                   help="Lexo detektimet nga cache ne vend qe te ekzekutohet YOLO")

    return p.parse_args(argv)


# --------------------------------------------------------------------------- #
# Pipeline
# --------------------------------------------------------------------------- #
def run(args: argparse.Namespace) -> dict:
    video_path = Path(args.video)
    if not video_path.exists():
        raise FileNotFoundError(f"Video nuk u gjet: {video_path}")

    out_dir = Path(args.output_dir)
    out_dir.mkdir(parents=True, exist_ok=True)

    cap = cv2.VideoCapture(str(video_path))
    if not cap.isOpened():
        raise RuntimeError(f"OpenCV nuk e hapi dot videon: {video_path}")

    source_fps = cap.get(cv2.CAP_PROP_FPS) or 30.0
    total_frames = int(cap.get(cv2.CAP_PROP_FRAME_COUNT) or 0)
    width = int(cap.get(cv2.CAP_PROP_FRAME_WIDTH))
    height = int(cap.get(cv2.CAP_PROP_FRAME_HEIGHT))
    duration = total_frames / source_fps if source_fps else 0.0

    # Hapi i mostrimit: procesohet cdo frame i N-te.
    if args.target_fps and args.target_fps > 0:
        step = max(1, int(round(source_fps / args.target_fps)))
    else:
        step = 1
    effective_fps = source_fps / step

    LOGGER.info("=" * 74)
    LOGGER.info("VIDEO   : %s", video_path.name)
    LOGGER.info("Formati : %dx%d @ %.2f fps | %d frame | %.1f s", width, height, source_fps, total_frames, duration)
    LOGGER.info("Mostrimi: cdo frame i %d-te -> %.2f fps efektive (~%d frame per procesim)",
                step, effective_fps, (total_frames + step - 1) // step if total_frames else 0)
    if effective_fps > 10.5:
        LOGGER.warning(
            "target-fps=%.1f: kostoja rritet LINEARISHT me fps-ne, ndersa saktesia e "
            "tracking-ut nuk permiresohet dukshem mbi ~6-10 fps per levizje njerezore. "
            "Rrite vetem nese ke levizje te shpejte qe po humbet.", effective_fps)
    LOGGER.info("=" * 74)

    # ---------------- Kalibrimi (opsional) ---------------- #
    calib = None
    if args.calibration:
        calib = GroundPlaneCalibration.from_json(args.calibration)
        err = calib.reprojection_error()
        var = calib.scale_variation(width, height)
        LOGGER.info("Kalibrim toke-plan: %d pika, gabim riprojektimi mes=%.3f m maks=%.3f m",
                    len(calib.image_points), err["mean_m"], err["max_m"])
        if var:
            LOGGER.info("  Shkalla nder kornize: %.2f..%.2f cm/px (raport %.1fx)",
                        var["min_m_per_px"] * 100, var["max_m_per_px"] * 100, var["ratio"])
        if err["max_m"] > 0.25:
            LOGGER.warning("  Gabimi i kalibrimit eshte i madh — matjet metrike jane te pasigurta.")

    # ---------------- Detektori ---------------- #
    det_cfg = DetectionConfig(
        model_path=args.model,
        confidence=args.conf,
        iou=args.iou,
        imgsz=args.imgsz,
        device=args.device,
        half=args.half,
        use_slicing=args.use_slicing,
        slice_wh=(args.slice_size, args.slice_size),
        slice_overlap=args.slice_overlap,
    )
    cached: dict[int, tuple] | None = None
    detector = None
    if args.load_detections:
        with open(args.load_detections, "rb") as fh:
            payload = pickle.load(fh)
        cached = payload["frames"]
        LOGGER.info("Detektimet u lexuan nga cache: %s (%d frame, modeli '%s')",
                    args.load_detections, len(cached), payload.get("model", "?"))
    else:
        detector = PersonDetector(det_cfg)

    # ---------------- Tracker-i ---------------- #
    trk_cfg = TrackingConfig(
        track_activation_threshold=args.track_activation,
        high_conf_det_threshold=args.high_conf,
        lost_track_buffer=args.lost_buffer,
        minimum_iou_threshold=args.min_iou,
        frame_rate=effective_fps,
        minimum_consecutive_frames=args.min_consecutive,
        backend=args.tracker_backend,
        algorithm=args.tracker,
        enable_cmc=not args.no_cmc,
    )
    tracker = PersonTracker(trk_cfg)

    # ---------------- ReID (opsional) ---------------- #
    linker = None
    if args.reid:
        from reid import ReIDConfig, ReIDLinker

        linker = ReIDLinker(ReIDConfig(
            backend=args.reid_backend,
            similarity_threshold=args.reid_threshold,
            max_gap_sec=args.reid_max_gap,
            min_margin=args.reid_margin,
            device=detector.device if detector is not None else "cpu",
        ))

    annotator = TrackAnnotator(
        resolution_wh=(width, height),
        draw_traces=not args.no_traces,
        trace_length=args.trace_length,
    )

    writer = None
    video_out_path = out_dir / args.video_name
    if not args.no_video:
        fourcc = cv2.VideoWriter_fourcc(*"mp4v")
        writer = cv2.VideoWriter(str(video_out_path), fourcc, effective_fps, (width, height))
        if not writer.isOpened():
            LOGGER.warning("VideoWriter nuk u hap — vazhdohet pa video output")
            writer = None

    csv_path = out_dir / args.csv_name
    csv_file = csv_path.open("w", newline="", encoding="utf-8")
    csv_writer = csv.writer(csv_file)
    csv_writer.writerow(CSV_COLUMNS)

    to_cache: dict[int, tuple] | None = {} if args.save_detections else None

    stats = TrackingStats()
    frame_index = -1      # indeks i frame-it NE VIDEON ORIGJINALE
    processed = 0
    t_start = time.perf_counter()

    try:
        while True:
            # `grab()` eshte i lire: dekodon vetem sa duhet per te kaluar frame-in.
            ok = cap.grab()
            if not ok:
                break
            frame_index += 1
            if frame_index % step != 0:
                continue

            ok, frame = cap.retrieve()
            if not ok or frame is None:
                break

            timestamp_sec = frame_index / source_fps

            if cached is not None:
                xyxy, conf = cached.get(frame_index, (np.zeros((0, 4)), np.zeros(0)))
                detections = sv.Detections(
                    xyxy=np.asarray(xyxy, dtype=float),
                    confidence=np.asarray(conf, dtype=float),
                    class_id=np.zeros(len(conf), dtype=int),
                )
            else:
                detections = detector.detect(frame)
            if to_cache is not None:
                to_cache[frame_index] = (detections.xyxy.copy(), detections.confidence.copy())
            raw_count = len(detections)

            tracked = tracker.update(detections, frame)

            # Ri-identifikimi hartezon ID-te e tracker-it ne ID kanonike.
            if linker is not None and len(tracked):
                tracked.tracker_id = linker.assign(
                    frame, tracked.xyxy, tracked.tracker_id, timestamp_sec
                )

            stats.update(tracked, timestamp_sec, raw_count=raw_count)

            anchors = bbox_anchor(tracked.xyxy) if len(tracked) else np.zeros((0, 2))
            ground = calib.to_ground(anchors) if (calib is not None and len(anchors)) else None

            for i, (xyxy_i, tid, conf) in enumerate(
                zip(tracked.xyxy, tracked.tracker_id, tracked.confidence)
            ):
                x1, y1, x2, y2 = (float(v) for v in xyxy_i)
                ax, ay = anchors[i]
                gx: object = ""
                gy: object = ""
                if ground is not None:
                    gx, gy = round(float(ground[i][0]), 3), round(float(ground[i][1]), 3)
                csv_writer.writerow([
                    frame_index,
                    round(timestamp_sec, 3),
                    int(tid),
                    round(x1, 1),
                    round(y1, 1),
                    round(x2 - x1, 1),
                    round(y2 - y1, 1),
                    round(float(conf), 4),
                    round(float(ax), 1),
                    round(float(ay), 1),
                    gx,
                    gy,
                ])

            if writer is not None:
                writer.write(annotator.annotate(frame, tracked))

            processed += 1
            if processed % 20 == 0:
                elapsed = time.perf_counter() - t_start
                LOGGER.info(
                    "  frame %4d (t=%5.2fs) | persona: %d | ID unike deri tani: %d | %.2f frame/s",
                    frame_index, timestamp_sec, len(tracked), stats.unique_ids, processed / elapsed,
                )

            if args.max_frames and processed >= args.max_frames:
                LOGGER.info("U arrit --max-frames=%d, ndalim.", args.max_frames)
                break
    finally:
        cap.release()
        if writer is not None:
            writer.release()
        csv_file.close()

    if to_cache is not None:
        with open(args.save_detections, "wb") as fh:
            pickle.dump({"model": args.model, "imgsz": args.imgsz, "conf": args.conf,
                         "step": step, "frames": to_cache}, fh)
        LOGGER.info("Detektimet u ruajten -> %s (%d frame)", args.save_detections, len(to_cache))

    elapsed = time.perf_counter() - t_start

    summary = build_summary(
        args=args,
        stats=stats,
        elapsed=elapsed,
        video_path=video_path,
        width=width,
        height=height,
        source_fps=source_fps,
        total_frames=total_frames,
        duration=duration,
        step=step,
        effective_fps=effective_fps,
        device=detector.device if detector is not None else "cache",
        half=detector.half_enabled if detector is not None else False,
        tracker_backend=tracker.backend,
        calib=calib,
        linker=linker,
        csv_path=csv_path,
        video_out_path=video_out_path if writer is not None else None,
    )

    summary_path = out_dir / "summary.json"
    summary_path.write_text(json.dumps(summary, indent=2, ensure_ascii=False), encoding="utf-8")

    print_report(summary, stats)
    LOGGER.info("CSV      -> %s", csv_path)
    if writer is not None:
        LOGGER.info("Video    -> %s", video_out_path)
    LOGGER.info("Summary  -> %s", summary_path)

    return summary


def build_summary(**kw) -> dict:
    args = kw["args"]
    stats: TrackingStats = kw["stats"]
    elapsed = kw["elapsed"]
    calib: Optional[GroundPlaneCalibration] = kw["calib"]
    linker = kw["linker"]

    summary = {
        "input": {
            "file": str(kw["video_path"]),
            "resolution": f"{kw['width']}x{kw['height']}",
            "source_fps": round(kw["source_fps"], 2),
            "total_frames": kw["total_frames"],
            "duration_sec": round(kw["duration"], 2),
        },
        "sampling": {
            "frame_step": kw["step"],
            "effective_fps": round(kw["effective_fps"], 2),
        },
        "detection": {
            "model": args.model,
            "device": kw["device"],
            "half_precision": kw["half"],
            "imgsz": args.imgsz,
            "confidence_threshold": args.conf,
            "nms_iou": args.iou,
            "slicing": args.use_slicing,
        },
        "tracking": {
            "algorithm": args.tracker,
            "backend": kw["tracker_backend"],
            "track_activation_threshold": args.track_activation,
            "high_conf_det_threshold": args.high_conf,
            "lost_track_buffer_frames": args.lost_buffer,
            "lost_track_buffer_sec": round(args.lost_buffer / max(kw["effective_fps"], 1e-6), 2),
            "minimum_iou_threshold": args.min_iou,
            "minimum_consecutive_frames": args.min_consecutive,
        },
        "results": {
            "frames_processed": stats.frames_processed,
            "frames_with_person": stats.frames_with_person,
            "frames_empty": stats.frames_processed - stats.frames_with_person,
            "raw_detections_before_tracking": stats.raw_detections,
            "tracked_detections": stats.total_detections,
            "avg_persons_per_frame": round(stats.avg_persons_per_frame, 3),
            "avg_persons_when_present": round(stats.avg_persons_when_present, 3),
            "max_persons_in_frame": stats.max_persons_in_frame,
            "unique_person_ids": stats.unique_ids,
            "id_switch_indicator": stats.id_switch_indicator(args.expected_persons),
            "short_lived_ids": stats.short_lived_ids(min_frames=3),
        },
        "performance": {
            "total_processing_sec": round(elapsed, 2),
            "fps_processing": round(stats.frames_processed / elapsed, 2) if elapsed else None,
            "sec_per_frame": round(elapsed / stats.frames_processed, 3) if stats.frames_processed else None,
            "realtime_factor": round(kw["duration"] / elapsed, 2) if elapsed else None,
        },
        "per_id": stats.id_table(),
        "outputs": {
            "csv": str(kw["csv_path"]),
            "video": str(kw["video_out_path"]) if kw["video_out_path"] else None,
        },
    }

    if calib is not None:
        summary["calibration"] = {
            "file": args.calibration,
            "points": len(calib.image_points),
            "unit": calib.unit,
            "lens_correction": calib.lens.model if calib.lens else None,
            "reprojection_error": calib.reprojection_error(),
            "scale_variation": calib.scale_variation(kw["width"], kw["height"]),
        }
    if linker is not None:
        summary["reid"] = linker.summary()

    return summary


def print_report(summary: dict, stats: TrackingStats) -> None:
    r = summary["results"]
    perf = summary["performance"]
    det = summary["detection"]

    print()
    print("=" * 74)
    print("  PERMBLEDHJE — FAZA 1 (detektim + tracking)")
    print("=" * 74)
    print(f"  Frame te procesuar            : {r['frames_processed']}"
          f"  (nga {summary['input']['total_frames']} total, hap={summary['sampling']['frame_step']})")
    print(f"  Frame me te pakten 1 person   : {r['frames_with_person']}  "
          f"({100 * r['frames_with_person'] / max(r['frames_processed'], 1):.1f}%)")
    print(f"  Persona mesatarisht / frame   : {r['avg_persons_per_frame']}")
    print(f"  Persona mesat. kur ka prezence: {r['avg_persons_when_present']}")
    print(f"  Maksimum persona ne nje frame : {r['max_persons_in_frame']}")
    print(f"  Detektime (para tracking-ut)  : {r['raw_detections_before_tracking']}")
    print(f"  Detektime te track-uara       : {r['tracked_detections']}")
    print(f"  ID UNIKE te krijuara          : {r['unique_person_ids']}")
    if r["id_switch_indicator"] is not None:
        print(f"  Indikator ID-switching        : {r['id_switch_indicator']}x  (1.0 = ideal)")
    if r["short_lived_ids"]:
        print(f"  ID jeteshkurtra (<3 frame)    : {r['short_lived_ids']}")

    if "reid" in summary:
        rid = summary["reid"]
        print("-" * 74)
        print(f"  ReID [{rid['backend']}]: {rid['relinks']} ri-lidhje, "
              f"{rid['rejected_ambiguous']} te refuzuara si te paqarta")
        print(f"    track-e te tracker-it: {rid['raw_tracks_seen']} -> ID kanonike: {rid['canonical_ids']}")

    if "calibration" in summary:
        cal = summary["calibration"]
        var = cal.get("scale_variation") or {}
        print("-" * 74)
        print(f"  Kalibrim toke-plan            : {cal['points']} pika, gabim maks "
              f"{cal['reprojection_error']['max_m']:.3f} {cal['unit']}")
        if var:
            print(f"  Shkalla nder kornize          : {var['min_m_per_px']*100:.2f}.."
                  f"{var['max_m_per_px']*100:.2f} cm/px (raport {var['ratio']:.1f}x)")

    print("-" * 74)
    print(f"  Pajisja                       : {det['device']}"
          f"{' (FP16)' if det['half_precision'] else ''}")
    print(f"  Kohe totale perpunimi         : {perf['total_processing_sec']} s")
    print(f"  Shpejtesia                    : {perf['fps_processing']} frame/s "
          f"({perf['sec_per_frame']} s/frame)")
    print(f"  Faktor realtime               : {perf['realtime_factor']}x")
    print("-" * 74)

    rows = summary["per_id"]
    if rows:
        print("  PER ID:")
        print(f"  {'ID':>4} {'frame':>6} {'nga(s)':>8} {'deri(s)':>9} {'kohezgj.':>9} {'conf.mes':>9}")
        for row in rows:
            print(f"  {row['person_id']:>4} {row['frames']:>6} {row['first_seen_sec']:>8.2f} "
                  f"{row['last_seen_sec']:>9.2f} {row['duration_sec']:>9.2f} {row['avg_confidence']:>9.3f}")
    print("=" * 74)
    print()


def main(argv: Optional[List[str]] = None) -> int:
    args = parse_args(argv)
    logging.basicConfig(
        level=logging.DEBUG if args.verbose else logging.INFO,
        format="%(asctime)s [%(levelname)s] %(message)s",
        datefmt="%H:%M:%S",
    )
    try:
        run(args)
    except Exception as exc:  # noqa: BLE001
        LOGGER.error("Deshtoi: %s", exc, exc_info=args.verbose)
        return 1
    return 0


if __name__ == "__main__":
    sys.exit(main())
