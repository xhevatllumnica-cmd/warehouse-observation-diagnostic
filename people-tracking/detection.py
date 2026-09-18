"""
detection.py — Detektim personash me YOLO (Faza 1: pilot).

Përgjegjësia e vetme e këtij moduli: të marrë një frame (numpy BGR) dhe të
kthejë detektimet e personave si `supervision.Detections`.

Shënime dizajni:
  * Klasa e vetme e interesit është COCO class 0 = "person". Filtrimi bëhet
    brenda YOLO-s (parametri `classes`) që të mos harxhohet kohë në post-processing.
  * Confidence threshold-i mbahet I ULËT me qëllim. ByteTrack-u përdor edhe
    detektimet me besueshmëri të ulët në fazën e dytë të asociimit, gjë që
    ndihmon direkt te occlusion-i. Pragu që vendos nëse LIND një track i ri
    kontrollohet veçmas në `tracking.py` (`track_activation_threshold`).
  * `imgsz` i lartë (1280 në vend të 640-s standarde) është zgjedhje e
    qëllimshme për këtë kamerë: në kënd oblik/wide-angle personat larg kamerës
    zënë pak piksele dhe humbasin në inference me rezolucion të ulët.
  * Opsionalisht mund të aktivizohet ndarja e frame-it në rajone (tiling/SAHI)
    përmes `use_slicing=True` — çdo rajon procesohet veçmas dhe rezultatet
    bashkohen me NMS. Kjo rrit ndjeshmërinë te objektet e vogla dhe te skajet
    e shtrembëruara, me kosto kohe përpunimi ~3-4x.
"""

from __future__ import annotations

import inspect
import logging
from dataclasses import dataclass
from typing import Tuple

import numpy as np
import supervision as sv
from ultralytics import YOLO

LOGGER = logging.getLogger(__name__)

# COCO: 0 == person
PERSON_CLASS_ID = 0


@dataclass
class DetectionConfig:
    """Konfigurim i detektorit. Asgjë nuk është hardcoded në logjikë."""

    model_path: str = "yolov8m.pt"
    confidence: float = 0.15          # prag i ulët -> ushqim për ByteTrack
    iou: float = 0.55                 # NMS IoU
    imgsz: int = 1280                 # rezolucion inference
    device: str = "auto"              # "auto" | "cpu" | "cuda" | "0"
    half: bool | None = None          # FP16: None = auto (po në CUDA, jo në CPU)
    use_slicing: bool = False         # ndarje e frame-it në rajone
    slice_wh: Tuple[int, int] = (960, 960)
    slice_overlap: float = 0.2        # mbivendosje midis rajoneve (raport)
    max_detections: int = 100


def resolve_device(requested: str = "auto") -> str:
    """Zgjidh pajisjen e inference-it; bie në CPU nëse CUDA s'është e disponueshme."""
    try:
        import torch
    except ImportError:  # pragma: no cover - torch është varësi e detyrueshme
        return "cpu"

    if requested and requested != "auto":
        if requested.startswith("cuda") or requested.isdigit():
            if not torch.cuda.is_available():
                LOGGER.warning("U kërkua '%s' por CUDA nuk është e disponueshme -> CPU", requested)
                return "cpu"
        return requested

    if torch.cuda.is_available():
        return "cuda"
    return "cpu"


class PersonDetector:
    """Wrapper i hollë mbi ultralytics YOLO, i specializuar për klasën 'person'."""

    def __init__(self, config: DetectionConfig | None = None) -> None:
        self.config = config or DetectionConfig()
        self.device = resolve_device(self.config.device)

        LOGGER.info("Po ngarkohet modeli '%s' në pajisjen '%s'", self.config.model_path, self.device)
        self.model = YOLO(self.config.model_path)
        self.model.to(self.device)

        # FP16 ka kuptim vetëm në GPU. Ultralytics 8.4 e ka zhvlerësuar kwarg-un
        # `half` te `predict()`, prandaj konvertimi bëhet një herë te vetë modeli.
        on_gpu = self.device != "cpu"
        want_half = on_gpu if self.config.half is None else bool(self.config.half)
        self._half = want_half and on_gpu
        if self._half:
            self.model.model.half()
            LOGGER.info("FP16 i aktivizuar")
        elif self.config.half and not on_gpu:
            LOGGER.warning("--half u injorua: FP16 kërkon CUDA, pajisja aktuale është CPU")

        self._log_device()

        self._slicer = self._build_slicer() if self.config.use_slicing else None

    # ------------------------------------------------------------------ #
    # API publik
    # ------------------------------------------------------------------ #
    def detect(self, frame: np.ndarray) -> sv.Detections:
        """Kthen detektimet e personave për një frame BGR."""
        if self._slicer is not None:
            return self._slicer(frame)
        return self._detect_whole_frame(frame)

    @property
    def model_name(self) -> str:
        return str(self.config.model_path)

    @property
    def half_enabled(self) -> bool:
        return self._half

    def _log_device(self) -> None:
        """Raporton GPU-në e përdorur — që të jetë e dukshme nëse ra në CPU pa u vënë re."""
        if self.device == "cpu":
            LOGGER.warning(
                "Inference në CPU. Nëse ka GPU NVIDIA, instalo torch me CUDA "
                "(shih requirements.txt) — pritet 10-20x përshpejtim."
            )
            return
        try:
            import torch

            idx = torch.cuda.current_device()
            name = torch.cuda.get_device_name(idx)
            total = torch.cuda.get_device_properties(idx).total_memory / (1024 ** 3)
            LOGGER.info("GPU: %s (%.1f GB, CUDA %s)", name, total, torch.version.cuda)
        except Exception:  # pragma: no cover - vetëm raportim
            pass

    # ------------------------------------------------------------------ #
    # Brendshme
    # ------------------------------------------------------------------ #
    def _detect_whole_frame(self, frame: np.ndarray) -> sv.Detections:
        result = self.model.predict(
            source=frame,
            conf=self.config.confidence,
            iou=self.config.iou,
            imgsz=self.config.imgsz,
            classes=[PERSON_CLASS_ID],
            device=self.device,
            max_det=self.config.max_detections,
            verbose=False,
        )[0]

        detections = sv.Detections.from_ultralytics(result)
        return self._keep_persons_only(detections)

    def _build_slicer(self) -> sv.InferenceSlicer:
        """Ndërton slicer-in për procesim rajon-për-rajon.

        API-ja e `InferenceSlicer` ka ndryshuar midis versioneve të supervision
        (`overlap_ratio_wh` -> `overlap_wh`), prandaj parametrat zgjidhen
        dinamikisht nga signature-a e vërtetë.
        """
        def callback(patch: np.ndarray) -> sv.Detections:
            return self._detect_whole_frame(patch)

        kwargs = {"callback": callback, "slice_wh": self.config.slice_wh}
        params = inspect.signature(sv.InferenceSlicer.__init__).parameters

        ow = int(self.config.slice_wh[0] * self.config.slice_overlap)
        oh = int(self.config.slice_wh[1] * self.config.slice_overlap)

        if "overlap_wh" in params:
            kwargs["overlap_wh"] = (ow, oh)
        elif "overlap_ratio_wh" in params:
            kwargs["overlap_ratio_wh"] = (self.config.slice_overlap, self.config.slice_overlap)

        if "iou_threshold" in params:
            kwargs["iou_threshold"] = self.config.iou
        if "thread_workers" in params:
            kwargs["thread_workers"] = 2

        LOGGER.info("Slicing i aktivizuar: slice_wh=%s, overlap=%.2f", self.config.slice_wh, self.config.slice_overlap)
        return sv.InferenceSlicer(**kwargs)

    @staticmethod
    def _keep_persons_only(detections: sv.Detections) -> sv.Detections:
        """Siguresë shtesë: edhe nëse `classes=[0]` dështon, filtro këtu."""
        if detections.class_id is None or len(detections) == 0:
            return detections
        return detections[detections.class_id == PERSON_CLASS_ID]
