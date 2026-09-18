"""
tracking.py — Tracking multi-frame me ByteTrack + anotim vizual + statistika.

Permbajtja:
  * `TrackingConfig` / `PersonTracker` — wrapper mbi `supervision.ByteTrack`.
  * `TrackAnnotator`                   — vizatimi i bbox + person_id mbi frame.
  * `TrackingStats`                    — statistika dhe indikatore per ID-switching.

Shenim mbi ByteTrack-un dhe sampling-un:
`frame_rate` i dhene ByteTrack-ut DUHET te jete fps-ja e mostrimit (p.sh. 6),
jo fps-ja e videos origjinale (30). Ky parameter perdoret bashke me
`lost_track_buffer` per te llogaritur sa kohe mbahet "gjalle" nje track i humbur
(occlusion). Nese i jepet 30 nderkohe qe realisht procesohen 6 frame/sek,
buffer-i efektiv behet 5x me i shkurter dhe ID-switching-u rritet artificialisht.
"""

from __future__ import annotations

import logging
from collections import defaultdict
from dataclasses import dataclass, field
from typing import Dict, List, Optional, Tuple

import numpy as np
import supervision as sv

LOGGER = logging.getLogger(__name__)


@dataclass
class TrackingConfig:
    """Parametrat e ByteTrack-ut."""

    # Besueshmeria minimale qe nje detektim te NISE nje track te ri.
    track_activation_threshold: float = 0.35
    # Ndarja high/low confidence — zemra e ByteTrack-ut. Detektimet nen kete prag
    # nuk nisin track te ri, por perdoren ne fazen e dyte te asociimit (occlusion).
    high_conf_det_threshold: float = 0.50
    # Sa frame (ne fps-ne e mostrimit) mbahet nje track pas humbjes -> occlusion.
    lost_track_buffer: int = 60
    # IoU minimal per matching midis track-ut dhe detektimit.
    minimum_iou_threshold: float = 0.10
    # Frame rate REAL i mostrimit (jo i videos origjinale).
    frame_rate: float = 6.0
    # Sa frame rresht duhet te jetoje nje track para se te raportohet.
    minimum_consecutive_frames: int = 1
    # "auto" | "trackers" (paketa e re) | "supervision" (sv.ByteTrack, deprecated)
    backend: str = "auto"
    # Algoritmi: "bytetrack" | "botsort" | "ocsort" | "sort".
    # `botsort` shton kompensim te levizjes se kameres (CMC) — i dobishem nese
    # kamera dridhet; per kamere fikse si kjo, kosto pa perfitim.
    algorithm: str = "bytetrack"
    # Vetem per botsort: kompensimi i levizjes se kameres.
    enable_cmc: bool = True


class PersonTracker:
    """Mban ID te qendrueshme per person pergjate frame-ve.

    `sv.ByteTrack` u shpall deprecated ne supervision 0.28 dhe hiqet ne 0.31,
    ne favor te `ByteTrackTracker` nga paketa `trackers` e Roboflow-it. Ky
    wrapper perdor implementimin e ri kur eshte i instaluar dhe bie ne te vjetrin
    perndryshe, me te njejtat parametra semantike.
    """

    def __init__(self, config: TrackingConfig | None = None) -> None:
        self.config = config or TrackingConfig()
        self.backend, self.tracker = self._build_tracker()

        LOGGER.info(
            "ByteTrack [%s]: activation=%.2f, high_conf=%.2f, lost_buffer=%d frame "
            "(~%.1fs @ %.2f fps), min_iou=%.2f, min_consecutive=%d",
            self.backend,
            self.config.track_activation_threshold,
            self.config.high_conf_det_threshold,
            self.config.lost_track_buffer,
            self.config.lost_track_buffer / max(self.config.frame_rate, 1e-6),
            self.config.frame_rate,
            self.config.minimum_iou_threshold,
            self.config.minimum_consecutive_frames,
        )

    def _build_tracker(self):
        cfg = self.config
        if cfg.backend in ("auto", "trackers"):
            try:
                return f"trackers/{cfg.algorithm}", self._build_from_trackers()
            except ImportError:
                if cfg.backend == "trackers":
                    raise
                LOGGER.warning("Paketa `trackers` mungon -> perdoret sv.ByteTrack (deprecated)")
        if cfg.algorithm != "bytetrack":
            raise ValueError(
                f"Algoritmi '{cfg.algorithm}' ofrohet vetem nga paketa `trackers`; "
                "backend-i 'supervision' mbeshtet vetem 'bytetrack'."
            )

        # Fallback: implementimi i vjeter. Aty `minimum_matching_threshold` eshte
        # prag DISTANCE (1 - IoU), prandaj konvertohet.
        import warnings

        with warnings.catch_warnings():
            warnings.simplefilter("ignore", FutureWarning)
            tracker = sv.ByteTrack(
                track_activation_threshold=cfg.track_activation_threshold,
                lost_track_buffer=cfg.lost_track_buffer,
                minimum_matching_threshold=1.0 - cfg.minimum_iou_threshold,
                frame_rate=cfg.frame_rate,
                minimum_consecutive_frames=cfg.minimum_consecutive_frames,
            )
        return "supervision/bytetrack", tracker

    def _build_from_trackers(self):
        """Nderton tracker-in e kerkuar nga paketa `trackers`.

        Parametrat nuk jane identike midis algoritmeve, prandaj secili merr
        vetem ata qe kupton — nje mapping i sheshte do te thyhej.
        """
        cfg = self.config
        common = dict(
            lost_track_buffer=cfg.lost_track_buffer,
            frame_rate=float(cfg.frame_rate),
            minimum_consecutive_frames=cfg.minimum_consecutive_frames,
        )

        if cfg.algorithm == "bytetrack":
            from trackers import ByteTrackTracker

            return ByteTrackTracker(
                track_activation_threshold=cfg.track_activation_threshold,
                minimum_iou_threshold=cfg.minimum_iou_threshold,
                high_conf_det_threshold=cfg.high_conf_det_threshold,
                **common,
            )
        if cfg.algorithm == "botsort":
            from trackers import BoTSORTTracker

            return BoTSORTTracker(
                track_activation_threshold=cfg.track_activation_threshold,
                high_conf_det_threshold=cfg.high_conf_det_threshold,
                minimum_iou_threshold_first_assoc=cfg.minimum_iou_threshold,
                enable_cmc=cfg.enable_cmc,
                **common,
            )
        if cfg.algorithm == "ocsort":
            from trackers import OCSORTTracker

            return OCSORTTracker(
                minimum_iou_threshold=cfg.minimum_iou_threshold,
                high_conf_det_threshold=cfg.high_conf_det_threshold,
                **common,
            )
        if cfg.algorithm == "sort":
            from trackers import SORTTracker

            return SORTTracker(
                track_activation_threshold=cfg.track_activation_threshold,
                minimum_iou_threshold=cfg.minimum_iou_threshold,
                **common,
            )
        raise ValueError(f"Algoritem i panjohur tracking-u: {cfg.algorithm!r}")

    def update(
        self, detections: sv.Detections, frame: np.ndarray | None = None
    ) -> sv.Detections:
        """Kthen detektimet me `tracker_id` te vlefshem (pa ato qe nuk u track-uan).

        `frame` perdoret vetem nga botsort (kompensim i levizjes se kameres).
        """
        if self.backend.startswith("trackers"):
            if self.config.algorithm == "botsort" and frame is not None:
                tracked = self.tracker.update(detections, frame)
            else:
                tracked = self.tracker.update(detections)
        else:
            tracked = self.tracker.update_with_detections(detections)

        if len(tracked) == 0 or tracked.tracker_id is None:
            return tracked

        # `ByteTrackTracker` kthen -1 per detektime qe ende nuk jane track i konfirmuar.
        ids = np.asarray(tracked.tracker_id)
        keep = np.array([tid is not None and int(tid) >= 0 for tid in ids], dtype=bool)
        return tracked[keep]

    def reset(self) -> None:
        self.tracker.reset()


class TrackAnnotator:
    """Vizatim i bbox-eve, i person_id-ve dhe i gjurmes se levizjes."""

    def __init__(
        self,
        resolution_wh: Tuple[int, int],
        draw_traces: bool = True,
        trace_length: int = 30,
    ) -> None:
        thickness = sv.calculate_optimal_line_thickness(resolution_wh=resolution_wh)
        text_scale = sv.calculate_optimal_text_scale(resolution_wh=resolution_wh)

        palette = sv.ColorPalette.DEFAULT
        self.box_annotator = sv.BoxAnnotator(
            color=palette, thickness=thickness, color_lookup=sv.ColorLookup.TRACK
        )
        self.label_annotator = sv.LabelAnnotator(
            color=palette,
            text_scale=text_scale,
            text_thickness=max(1, thickness - 1),
            text_position=sv.Position.TOP_LEFT,
            color_lookup=sv.ColorLookup.TRACK,
        )
        self.trace_annotator = (
            sv.TraceAnnotator(
                color=palette,
                thickness=thickness,
                trace_length=trace_length,
                position=sv.Position.BOTTOM_CENTER,
                color_lookup=sv.ColorLookup.TRACK,
            )
            if draw_traces
            else None
        )

    def annotate(self, frame: np.ndarray, detections: sv.Detections) -> np.ndarray:
        out = frame.copy()
        if len(detections) == 0:
            return out

        labels = [
            f"ID {int(tid)} | {conf:.2f}"
            for tid, conf in zip(detections.tracker_id, detections.confidence)
        ]
        if self.trace_annotator is not None:
            out = self.trace_annotator.annotate(out, detections=detections)
        out = self.box_annotator.annotate(out, detections=detections)
        out = self.label_annotator.annotate(out, detections=detections, labels=labels)
        return out


@dataclass
class TrackingStats:
    """Grumbullues statistikash per raportin perfundimtar."""

    frames_processed: int = 0
    frames_with_person: int = 0
    total_detections: int = 0
    raw_detections: int = 0  # detektime para tracking-ut
    per_frame_counts: List[int] = field(default_factory=list)
    _id_frames: Dict[int, int] = field(default_factory=lambda: defaultdict(int))
    _id_first_ts: Dict[int, float] = field(default_factory=dict)
    _id_last_ts: Dict[int, float] = field(default_factory=dict)
    _id_conf_sum: Dict[int, float] = field(default_factory=lambda: defaultdict(float))

    def update(
        self, detections: sv.Detections, timestamp_sec: float, raw_count: int = 0
    ) -> None:
        self.frames_processed += 1
        self.raw_detections += raw_count
        n = len(detections)
        self.per_frame_counts.append(n)
        self.total_detections += n
        if n:
            self.frames_with_person += 1
            for tid, conf in zip(detections.tracker_id, detections.confidence):
                tid = int(tid)
                self._id_frames[tid] += 1
                self._id_conf_sum[tid] += float(conf)
                self._id_first_ts.setdefault(tid, timestamp_sec)
                self._id_last_ts[tid] = timestamp_sec

    # -------------------------- metrika te nxjerra -------------------------- #
    @property
    def unique_ids(self) -> int:
        return len(self._id_frames)

    @property
    def avg_persons_per_frame(self) -> float:
        if not self.frames_processed:
            return 0.0
        return self.total_detections / self.frames_processed

    @property
    def max_persons_in_frame(self) -> int:
        return max(self.per_frame_counts) if self.per_frame_counts else 0

    @property
    def avg_persons_when_present(self) -> float:
        if not self.frames_with_person:
            return 0.0
        return self.total_detections / self.frames_with_person

    def id_table(self) -> List[dict]:
        """Nje rresht per cdo person_id — baza per diagnozen e ID-switching-ut."""
        rows = []
        for tid, frames in sorted(self._id_frames.items()):
            first, last = self._id_first_ts[tid], self._id_last_ts[tid]
            rows.append(
                {
                    "person_id": tid,
                    "frames": frames,
                    "first_seen_sec": round(first, 2),
                    "last_seen_sec": round(last, 2),
                    "duration_sec": round(last - first, 2),
                    "avg_confidence": round(self._id_conf_sum[tid] / frames, 3),
                }
            )
        return rows

    def short_lived_ids(self, min_frames: int = 3) -> List[int]:
        """ID qe zgjaten shume pak — kandidate per ID-switch ose false positive."""
        return [tid for tid, f in sorted(self._id_frames.items()) if f < min_frames]

    def id_switch_indicator(self, expected_persons: Optional[int] = None) -> Optional[float]:
        """Raporti ID unike / persona reale. ~1.0 = i shendetshem, >2 = problem."""
        if not expected_persons:
            return None
        return round(self.unique_ids / expected_persons, 2)
