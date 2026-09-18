"""
reid.py — Ri-identifikim pamor: vazhdimësi e `person_id` përtej occlusion-it të gjatë.

PROBLEMI
--------
ByteTrack (dhe SORT/OC-SORT) asociojnë vetëm me IoU + Kalman, pra me
**mbivendosje gjeometrike**. Kjo funksionon derisa kutia e re të mbivendoset me
atë ku e parashikon filtri. Nuk funksionon kur:

  * personi del krejt nga korniza dhe kthehet pas 20 sekondash,
  * personi fshihet plotësisht pas një rafti dhe del në anën tjetër,
  * dy persona kryqëzohen dhe ndahen (identitetet mund të shkëmbehen).

Në të gjitha këto, track-u i vjetër skadon dhe lind një ID e re — pra i njëjti
punëtor numërohet dy herë në statistikat agregate të Fazës 2.

ZGJIDHJA
--------
Një shtresë ri-identifikimi **mbi** tracker-in: çdo track mban një nënshkrim
pamor (embedding). Kur tracker-i nxjerr një ID krejt të re, nënshkrimi i saj
krahasohet me ata të ID-ve të parealizuara së fundmi; nëse ngjashmëria është e
lartë dhe koha e ndërprerjes e arsyeshme, ID-ja e re **hartëzohet** te e vjetra.

Tracker-i vetë mbetet i paprekur — kjo është vetëm një shtresë hartëzimi
`raw_id -> canonical_id`. Prandaj mund të çaktivizohet pa ndryshuar asgjë tjetër.

MBROJTJET KUNDËR BASHKIMIT TË GABUAR
------------------------------------
Bashkimi i dy personave të ndryshëm është gabim më i rëndë se një ID e dyfishtë.
Prandaj:
  * Një ID e re NUK bashkohet kurrë me një ID që është aktive në të njëjtin
    frame (dy trupa njëkohësisht nuk mund të jenë i njëjti person).
  * Kërkohet një prag i qartë ngjashmërie dhe një hendek maksimal kohor.
  * Kërkohet një **diferencë** minimale midis kandidatit më të mirë dhe të dytit;
    nëse dy persona duken njësoj, nuk merret vendim (shpesh uniforma të njëjta
    në magazinë).

BACKEND-ET
----------
  * `hist` (default) — histogram HSV i rajonit të trupit. Pa shkarkim, pa GPU,
    ~0.1 ms/krop. Në kamerë fikse me ndriçim konstant, ngjyra e veshjes është
    sinjali dominues dhe kjo mjafton për hendeqe të shkurtra/mesme.
  * `cnn` — tipare nga një rrjet i para-trajnuar (torchvision). Më i qëndrueshëm
    ndaj ndryshimit të pozës/ndriçimit, por kërkon shkarkim peshash dhe kohë
    inference. Rekomandohet nëse `hist` ngatërron persona me veshje të ngjashme.

Asnjë nga të dy nuk ruan fytyra dhe as identitet real: embedding-u është një
vektor numerik i përkohshëm, i mbajtur vetëm në memorie gjatë përpunimit të një
videoje të vetme.
"""

from __future__ import annotations

import logging
from dataclasses import dataclass, field
from typing import Dict, List, Optional, Set, Tuple

import cv2
import numpy as np

LOGGER = logging.getLogger(__name__)


# --------------------------------------------------------------------------- #
# Embedders
# --------------------------------------------------------------------------- #
class ColorHistogramEmbedder:
    """Histogram HSV i rajonit qendror të trupit, i normalizuar L2.

    Merret vetëm brendësia e bbox-it (30%-85% vertikalisht, 15%-85%
    horizontalisht) që të shmanget sfondi dhe koka — pjesa më e qëndrueshme e
    veshjes.
    """

    name = "hist"
    dim = 8 * 8 * 4

    def __init__(self, h_bins: int = 8, s_bins: int = 8, v_bins: int = 4) -> None:
        self.bins = (h_bins, s_bins, v_bins)
        self.dim = h_bins * s_bins * v_bins

    def __call__(self, crops: List[np.ndarray]) -> np.ndarray:
        out = np.zeros((len(crops), self.dim), dtype=np.float32)
        for i, crop in enumerate(crops):
            if crop.size == 0:
                continue
            hsv = cv2.cvtColor(crop, cv2.COLOR_BGR2HSV)
            hist = cv2.calcHist([hsv], [0, 1, 2], None, self.bins,
                                [0, 180, 0, 256, 0, 256]).ravel()
            norm = np.linalg.norm(hist)
            if norm > 0:
                out[i] = hist / norm
        return out


class CNNEmbedder:
    """Tipare nga një rrjet i para-trajnuar ImageNet (torchvision)."""

    name = "cnn"

    def __init__(self, device: str = "cpu", input_size: Tuple[int, int] = (128, 256)) -> None:
        import torch
        import torchvision

        self.torch = torch
        self.device = device
        self.input_size = input_size  # (gjerësi, lartësi) — persona janë vertikalë

        weights = torchvision.models.ResNet18_Weights.IMAGENET1K_V1
        model = torchvision.models.resnet18(weights=weights)
        model.fc = torch.nn.Identity()  # -> vektor 512-dimensional
        self.model = model.eval().to(device)
        self.dim = 512

        self._mean = torch.tensor([0.485, 0.456, 0.406], device=device).view(1, 3, 1, 1)
        self._std = torch.tensor([0.229, 0.224, 0.225], device=device).view(1, 3, 1, 1)
        LOGGER.info("ReID CNN: resnet18 (ImageNet) në '%s'", device)

    def __call__(self, crops: List[np.ndarray]) -> np.ndarray:
        torch = self.torch
        valid = [i for i, c in enumerate(crops) if c.size > 0]
        out = np.zeros((len(crops), self.dim), dtype=np.float32)
        if not valid:
            return out

        batch = np.stack([
            cv2.cvtColor(cv2.resize(crops[i], self.input_size), cv2.COLOR_BGR2RGB)
            for i in valid
        ])
        with torch.no_grad():
            t = torch.from_numpy(batch).to(self.device).permute(0, 3, 1, 2).float() / 255.0
            t = (t - self._mean) / self._std
            feats = self.model(t)
            feats = torch.nn.functional.normalize(feats, dim=1)
        out[valid] = feats.cpu().numpy().astype(np.float32)
        return out


def build_embedder(backend: str, device: str = "cpu"):
    if backend == "hist":
        return ColorHistogramEmbedder()
    if backend == "cnn":
        return CNNEmbedder(device=device)
    raise ValueError(f"Backend i panjohur ReID: {backend!r} (prit 'hist' ose 'cnn')")


# --------------------------------------------------------------------------- #
# Linker
# --------------------------------------------------------------------------- #
@dataclass
class ReIDConfig:
    backend: str = "hist"
    # Ngjashmëria minimale (kosinus) për të pranuar një bashkim.
    similarity_threshold: float = 0.80
    # Sa sekonda pas humbjes mbetet një ID kandidate për ri-lidhje.
    max_gap_sec: float = 30.0
    # Diferenca minimale midis kandidatit më të mirë dhe të dytit.
    min_margin: float = 0.05
    # Pesha e EMA-s për përditësimin e nënshkrimit (0 = i ngrirë, 1 = vetëm i fundit).
    ema_alpha: float = 0.25
    # Bbox nën këtë lartësi (px) injorohen — shumë të vogla për nënshkrim të besueshëm.
    min_box_height: int = 40
    device: str = "cpu"


@dataclass
class ReIDStats:
    relinks: int = 0
    new_ids: int = 0
    rejected_ambiguous: int = 0
    events: List[dict] = field(default_factory=list)


class ReIDLinker:
    """Hartëzon `raw_id` (nga tracker-i) -> `canonical_id` (i qëndrueshëm)."""

    def __init__(self, config: ReIDConfig | None = None) -> None:
        self.config = config or ReIDConfig()
        self.embedder = build_embedder(self.config.backend, self.config.device)

        self._raw_to_canonical: Dict[int, int] = {}
        self._embeddings: Dict[int, np.ndarray] = {}      # canonical -> nënshkrim
        self._last_seen: Dict[int, float] = {}            # canonical -> timestamp
        self._next_canonical = 0
        self.stats = ReIDStats()

        LOGGER.info(
            "ReID [%s]: prag=%.2f, hendek max=%.0fs, margjinë=%.2f",
            self.config.backend, self.config.similarity_threshold,
            self.config.max_gap_sec, self.config.min_margin,
        )

    # ------------------------------------------------------------------ #
    def assign(
        self,
        frame: Optional[np.ndarray],
        xyxy: np.ndarray,
        raw_ids: np.ndarray,
        timestamp_sec: float,
        embeddings: Optional[np.ndarray] = None,
    ) -> np.ndarray:
        """Kthen ID-të kanonike për detektimet e track-uara të këtij frame-i.

        `embeddings` (N x D) lejon kalimin e nënshkrimeve të para-llogaritura —
        e domosdoshme për `tune.py stress`, ku i njëjti klip riprodhohet dhjetëra
        herë dhe ri-llogaritja e tyre çdo herë do ta bënte testin të papërdorshëm.
        """
        xyxy = np.asarray(xyxy, dtype=float).reshape(-1, 4)
        raw_ids = [int(r) for r in raw_ids]
        if not raw_ids:
            return np.zeros(0, dtype=int)

        if embeddings is None:
            if frame is None:
                raise ValueError("Duhet ose `frame` ose `embeddings`")
            embeddings = self.embedder([self._crop(frame, b) for b in xyxy])
        embeddings = np.asarray(embeddings, dtype=np.float32).reshape(len(raw_ids), -1)

        # ID-të kanonike aktive në KËTË frame — nuk mund të ri-përdoren.
        active_now: Set[int] = {
            self._raw_to_canonical[r] for r in raw_ids if r in self._raw_to_canonical
        }

        for idx, raw in enumerate(raw_ids):
            if raw in self._raw_to_canonical:
                continue
            emb = embeddings[idx]
            box_h = xyxy[idx, 3] - xyxy[idx, 1]

            canonical = None
            if box_h >= self.config.min_box_height and np.any(emb):
                canonical = self._match(emb, timestamp_sec, active_now, raw)

            if canonical is None:
                canonical = self._next_canonical
                self._next_canonical += 1
                self.stats.new_ids += 1

            self._raw_to_canonical[raw] = canonical
            active_now.add(canonical)
            self._embeddings[canonical] = emb.copy()

        # Përditëso nënshkrimet dhe kohën e fundit të parë.
        canonical_ids = np.array([self._raw_to_canonical[r] for r in raw_ids], dtype=int)
        self._refresh(xyxy, canonical_ids, embeddings, timestamp_sec)
        return canonical_ids

    # ------------------------------------------------------------------ #
    def _match(
        self, emb: np.ndarray, timestamp_sec: float, active_now: Set[int], raw: int
    ) -> Optional[int]:
        """Gjen ID-në kanonike më të ngjashme që është e lirë dhe e freskët."""
        scores: List[Tuple[float, int]] = []
        for canonical, ref in self._embeddings.items():
            if canonical in active_now:
                continue  # nuk mund të jetë i njëjti person dy herë njëkohësisht
            gap = timestamp_sec - self._last_seen.get(canonical, -1e9)
            if gap < 0 or gap > self.config.max_gap_sec:
                continue
            if ref.shape != emb.shape:
                continue
            scores.append((float(np.dot(emb, ref)), canonical))

        if not scores:
            return None

        scores.sort(reverse=True)
        best_score, best_id = scores[0]
        if best_score < self.config.similarity_threshold:
            return None

        # Kërko dallim të qartë nga kandidati i dytë.
        if len(scores) > 1 and (best_score - scores[1][0]) < self.config.min_margin:
            self.stats.rejected_ambiguous += 1
            LOGGER.debug("ReID i paqartë në t=%.2fs: %.3f vs %.3f", timestamp_sec,
                         best_score, scores[1][0])
            return None

        self.stats.relinks += 1
        self.stats.events.append({
            "timestamp_sec": round(timestamp_sec, 2),
            "raw_id": raw,
            "canonical_id": best_id,
            "similarity": round(best_score, 3),
            "gap_sec": round(timestamp_sec - self._last_seen[best_id], 2),
        })
        LOGGER.info("ReID: raw %d -> ID %d (ngjashmëri %.3f, hendek %.1fs)",
                    raw, best_id, best_score, timestamp_sec - self._last_seen[best_id])
        return best_id

    def _refresh(
        self,
        xyxy: np.ndarray,
        canonical_ids: np.ndarray,
        embeddings: np.ndarray,
        timestamp_sec: float,
    ) -> None:
        """Përditëson nënshkrimet me EMA për track-et e qëndrueshme."""
        alpha = self.config.ema_alpha
        for i, cid in enumerate(canonical_ids):
            if (xyxy[i, 3] - xyxy[i, 1]) < self.config.min_box_height:
                continue
            emb = embeddings[i]
            if not np.any(emb):
                continue
            cid = int(cid)
            prev = self._embeddings.get(cid)
            if prev is None or prev.shape != emb.shape:
                self._embeddings[cid] = emb.copy()
            else:
                merged = (1 - alpha) * prev + alpha * emb
                n = np.linalg.norm(merged)
                self._embeddings[cid] = merged / n if n > 0 else merged

        for cid in canonical_ids:
            self._last_seen[int(cid)] = timestamp_sec

    @staticmethod
    def _crop(frame: np.ndarray, box: np.ndarray) -> np.ndarray:
        """Rajoni qendror i trupit — pa sfond dhe pa kokë."""
        h, w = frame.shape[:2]
        x1, y1, x2, y2 = box
        bw, bh = x2 - x1, y2 - y1
        cx1 = int(np.clip(x1 + 0.15 * bw, 0, w - 1))
        cx2 = int(np.clip(x1 + 0.85 * bw, 0, w))
        cy1 = int(np.clip(y1 + 0.30 * bh, 0, h - 1))
        cy2 = int(np.clip(y1 + 0.85 * bh, 0, h))
        if cx2 <= cx1 or cy2 <= cy1:
            return np.zeros((0, 0, 3), dtype=frame.dtype)
        return frame[cy1:cy2, cx1:cx2]

    # ------------------------------------------------------------------ #
    @property
    def unique_ids(self) -> int:
        return self._next_canonical

    def summary(self) -> dict:
        return {
            "backend": self.config.backend,
            "similarity_threshold": self.config.similarity_threshold,
            "max_gap_sec": self.config.max_gap_sec,
            "raw_tracks_seen": len(self._raw_to_canonical),
            "canonical_ids": self._next_canonical,
            "relinks": self.stats.relinks,
            "rejected_ambiguous": self.stats.rejected_ambiguous,
            "events": self.stats.events,
        }
