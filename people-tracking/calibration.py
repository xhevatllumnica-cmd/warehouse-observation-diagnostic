"""
calibration.py — Kalibrim tokë-plan (homografi) për matje metrike.

PROBLEMI QË ZGJIDH
------------------
Në një pamje perspektive, e njëjta distancë në piksele NUK i korrespondon të
njëjtës distancë reale: 50 px pranë kamerës janë pak centimetra, ndërsa 50 px
në sfond mund të jenë një metër. Çdo llogaritje distance/shpejtësie ose çdo
kufi zone i vizatuar direkt mbi piksele është prandaj i pasaktë.

Zgjidhja standarde është një **homografi** H që hartëzon pikat e dyshemesë
(një plan) nga pikselat në koordinata reale (metra):

        [u]         [X]
    s * [v]  =  H * [Y]          (X, Y në metra mbi dysheme)
        [1]         [1]

Duhen së paku 4 pika të dyshemesë me distanca reale të njohura.

FISHEYE — KUFIZIM I RËNDËSISHËM
-------------------------------
Homografia supozon një kamerë pinhole: vijat e drejta mbeten të drejta. Te
G5 Turret Ultra me kënd të gjerë kjo NUK vlen në skajet e kornizës — vijat e
dyshemesë shfaqen të lakuara. Prandaj ky modul mbështet një hap opsional
para-korrigjimi të lentes (`LensModel`): pikat fillimisht un-distortohen, e
më pas aplikohet homografia.

Radhitja e preferuar e opsioneve:
  1. Përdor stream-in e korrigjuar të vetë UniFi Protect-it, nëse ofrohet.
  2. Kalibro intrinsics-at me një chessboard (`cv2.calibrateCamera`) dhe vendosi
     te `lens` në JSON.
  3. Pa asnjë nga të dyat: përdor >= 6-8 pika kalibrimi të shpërndara dhe
     kontrollo `reprojection_error_m` — nëse është i madh, distorsioni mbetet
     i pakompensuar dhe matjet në skaje nuk janë të besueshme.

ANKORIMI I PERSONIT
-------------------
Personi hartëzohet nga pika BOTTOM_CENTER e bbox-it (qendra e buzës së poshtme)
— pika e kontaktit me dyshemenë. Qendra e bbox-it lundron në ajër dhe do të
jepte distanca të gabuara sistematikisht (shih `bbox_anchor`).

PËRDORIM
--------
    # 1) nxirr një frame referencë për të zgjedhur pikat
    python calibration.py extract --video video.mp4 --frame 0 --out ref.png

    # 2) zgjidh 4+ pika me mouse (hap dritare; kërkon desktop)
    python calibration.py pick --image ref.png --out calib.json

    # 3) vendos distancat reale te calib.json, pastaj validoje
    python calibration.py validate --calibration calib.json --image ref.png \
        --out calib_check.png
"""

from __future__ import annotations

import argparse
import json
import logging
from dataclasses import dataclass, field
from pathlib import Path
from typing import List, Optional, Sequence, Tuple

import cv2
import numpy as np

LOGGER = logging.getLogger(__name__)


# --------------------------------------------------------------------------- #
# Ankorimi i bbox-it
# --------------------------------------------------------------------------- #
def bbox_anchor(xyxy: np.ndarray) -> np.ndarray:
    """Kthen pikën BOTTOM_CENTER për çdo bbox — kontakti me dyshemenë.

    `xyxy` me formë (N, 4) -> del (N, 2).

    Pse jo qendra e bbox-it: qendra ndodhet rreth belit të personit, pra ~1 m
    mbi dysheme. Pas homografisë ajo projektohet në një pikë të dyshemesë që
    ndodhet më larg kamerës nga sa është personi realisht, dhe gabimi rritet me
    largësinë. Buza e poshtme është e vetmja pikë që i përket vërtet planit të
    dyshemesë.
    """
    xyxy = np.asarray(xyxy, dtype=float).reshape(-1, 4)
    x_center = (xyxy[:, 0] + xyxy[:, 2]) / 2.0
    y_bottom = xyxy[:, 3]
    return np.stack([x_center, y_bottom], axis=1)


# --------------------------------------------------------------------------- #
# Modeli i lentes (opsional)
# --------------------------------------------------------------------------- #
@dataclass
class LensModel:
    """Intrinsics + koeficientë distorsioni për para-korrigjim fisheye."""

    camera_matrix: np.ndarray  # (3, 3)
    dist_coeffs: np.ndarray    # (k1, k2, p1, p2, k3) ose fisheye (k1..k4)
    model: str = "pinhole"     # "pinhole" (cv2.undistortPoints) | "fisheye"

    @classmethod
    def from_dict(cls, data: dict) -> "LensModel":
        return cls(
            camera_matrix=np.asarray(data["camera_matrix"], dtype=float).reshape(3, 3),
            dist_coeffs=np.asarray(data["dist_coeffs"], dtype=float).ravel(),
            model=data.get("model", "pinhole"),
        )

    def to_dict(self) -> dict:
        return {
            "camera_matrix": self.camera_matrix.tolist(),
            "dist_coeffs": self.dist_coeffs.tolist(),
            "model": self.model,
        }

    def undistort(self, points_px: np.ndarray) -> np.ndarray:
        """Heq distorsionin e lentes, duke i mbajtur pikat në piksele."""
        pts = np.asarray(points_px, dtype=np.float64).reshape(-1, 1, 2)
        if self.model == "fisheye":
            out = cv2.fisheye.undistortPoints(
                pts, self.camera_matrix, self.dist_coeffs, P=self.camera_matrix
            )
        else:
            out = cv2.undistortPoints(
                pts, self.camera_matrix, self.dist_coeffs, P=self.camera_matrix
            )
        return out.reshape(-1, 2)


# --------------------------------------------------------------------------- #
# Homografia tokë-plan
# --------------------------------------------------------------------------- #
@dataclass
class GroundPlaneCalibration:
    """Hartëzim piksele <-> metra mbi planin e dyshemesë."""

    image_points: np.ndarray           # (N, 2) piksele, N >= 4
    world_points: np.ndarray           # (N, 2) metra
    lens: Optional[LensModel] = None
    unit: str = "m"
    notes: str = ""
    _H: np.ndarray = field(init=False, repr=False)
    _H_inv: np.ndarray = field(init=False, repr=False)

    def __post_init__(self) -> None:
        self.image_points = np.asarray(self.image_points, dtype=np.float64).reshape(-1, 2)
        self.world_points = np.asarray(self.world_points, dtype=np.float64).reshape(-1, 2)

        if len(self.image_points) != len(self.world_points):
            raise ValueError("image_points dhe world_points duhet të kenë të njëjtin numër pikash")
        if len(self.image_points) < 4:
            raise ValueError("Duhen së paku 4 pika kalibrimi")

        src = self._prepare(self.image_points)
        # Me 4 pika -> zgjidhje e saktë; me më shumë -> katrorë më të vegjël (RANSAC).
        if len(src) == 4:
            H, _ = cv2.findHomography(src, self.world_points, method=0)
        else:
            H, _ = cv2.findHomography(src, self.world_points, method=cv2.RANSAC,
                                      ransacReprojThreshold=0.05)
        if H is None:
            raise ValueError(
                "Homografia nuk u llogarit dot. Zakonisht do të thotë që pikat janë "
                "kolineare (në një vijë) ose që koordinatat reale nuk përputhen me ato në figurë."
            )
        self._H = H
        self._H_inv = np.linalg.inv(H)

    # ------------------------------------------------------------------ #
    def _prepare(self, points_px: np.ndarray) -> np.ndarray:
        pts = np.asarray(points_px, dtype=np.float64).reshape(-1, 2)
        if self.lens is not None:
            pts = self.lens.undistort(pts)
        return pts

    def to_ground(self, points_px: np.ndarray) -> np.ndarray:
        """Piksele -> metra mbi dysheme. Hyrje (N,2), dalje (N,2)."""
        pts = self._prepare(points_px)
        if len(pts) == 0:
            return np.zeros((0, 2))
        out = cv2.perspectiveTransform(pts.reshape(-1, 1, 2), self._H)
        return out.reshape(-1, 2)

    def to_image(self, points_m: np.ndarray) -> np.ndarray:
        """Metra -> piksele (pa ri-aplikuar distorsionin e lentes)."""
        pts, _ = self.to_image_with_validity(points_m)
        return pts

    def to_image_with_validity(self, points_m: np.ndarray) -> Tuple[np.ndarray, np.ndarray]:
        """Si `to_image`, por kthen edhe maskën e pikave të vlefshme.

        Pikat "prapa horizontit" kanë koordinatë homogjene w <= 0: ato janë
        matematikisht të projektueshme, por fizikisht ndodhen prapa kamerës dhe
        do të vizatoheshin si vija që kthehen mbrapsht. `cv2.perspectiveTransform`
        pjesëton me w pa e kontrolluar shenjën, prandaj llogaritja bëhet këtu.
        """
        pts = np.asarray(points_m, dtype=np.float64).reshape(-1, 2)
        if len(pts) == 0:
            return np.zeros((0, 2)), np.zeros(0, dtype=bool)

        homogeneous = np.hstack([pts, np.ones((len(pts), 1))])
        projected = homogeneous @ self._H_inv.T
        w = projected[:, 2]
        valid = w > 1e-9
        out = np.full((len(pts), 2), np.nan)
        out[valid] = projected[valid, :2] / w[valid, None]
        return out, valid

    # ------------------------------------------------------------------ #
    # Diagnostikë
    # ------------------------------------------------------------------ #
    def reprojection_error(self) -> dict:
        """Sa mirë i riprodhon homografia vetë pikat e kalibrimit (në metra).

        Gabim i madh me 4 pika = matje të gabuara reale. Gabim i madh me shumë
        pika = distorsion i lentes i pakompensuar (shih shënimin fisheye lart).
        """
        pred = self.to_ground(self.image_points)
        err = np.linalg.norm(pred - self.world_points, axis=1)
        return {
            "mean_m": float(err.mean()),
            "max_m": float(err.max()),
            "per_point_m": [float(e) for e in err],
        }

    def meters_per_pixel(self, point_px: Sequence[float]) -> float:
        """Shkalla lokale në një pikë — sa metra "vlen" 1 piksel aty.

        Përdoret për të treguar konkretisht sa ndryshon shkalla nëpër kornizë.
        """
        p = np.asarray(point_px, dtype=float).reshape(1, 2)
        neighbours = p + np.array([[1.0, 0.0], [0.0, 1.0]])
        base = self.to_ground(p)[0]
        near = self.to_ground(neighbours)
        dx = float(np.linalg.norm(near[0] - base))
        dy = float(np.linalg.norm(near[1] - base))
        return (dx + dy) / 2.0

    def scale_variation(self, width: int, height: int) -> dict:
        """Raporti max/min i shkallës brenda zonës së kalibruar.

        Mostrimi kufizohet te drejtkëndëshi i pikave të kalibrimit (i zgjeruar
        pak), jo e gjithë korniza: mbi horizont homografia divergjon drejt
        pafundësisë dhe do të jepte numra pa kuptim.
        """
        x0, y0 = self.image_points.min(axis=0)
        x1, y1 = self.image_points.max(axis=0)
        pad_x, pad_y = 0.15 * (x1 - x0), 0.15 * (y1 - y0)
        xs = np.linspace(max(0.0, x0 - pad_x), min(width - 1.0, x1 + pad_x), 6)
        ys = np.linspace(max(0.0, y0 - pad_y), min(height - 1.0, y1 + pad_y), 6)

        scales = [self.meters_per_pixel((x, y)) for x in xs for y in ys]
        scales = [s for s in scales if np.isfinite(s) and s > 1e-9]
        if not scales:
            return {}
        return {
            "min_m_per_px": float(min(scales)),
            "max_m_per_px": float(max(scales)),
            "ratio": float(max(scales) / min(scales)),
            "region_px": [float(x0), float(y0), float(x1), float(y1)],
        }

    # ------------------------------------------------------------------ #
    # IO
    # ------------------------------------------------------------------ #
    @classmethod
    def from_json(cls, path: str | Path) -> "GroundPlaneCalibration":
        data = json.loads(Path(path).read_text(encoding="utf-8"))
        lens = LensModel.from_dict(data["lens"]) if data.get("lens") else None
        return cls(
            image_points=data["image_points"],
            world_points=data["world_points"],
            lens=lens,
            unit=data.get("unit", "m"),
            notes=data.get("notes", ""),
        )

    def to_json(self, path: str | Path) -> None:
        payload = {
            "unit": self.unit,
            "notes": self.notes,
            "image_points": self.image_points.tolist(),
            "world_points": self.world_points.tolist(),
            "lens": self.lens.to_dict() if self.lens else None,
            "reprojection_error": self.reprojection_error(),
        }
        Path(path).write_text(json.dumps(payload, indent=2, ensure_ascii=False), encoding="utf-8")

    # ------------------------------------------------------------------ #
    # Vizualizim
    # ------------------------------------------------------------------ #
    def draw_grid(
        self,
        frame: np.ndarray,
        spacing_m: float = 1.0,
        extent_m: float = 12.0,
        color: Tuple[int, int, int] = (0, 220, 255),
    ) -> np.ndarray:
        """Vizaton një rrjet metrik mbi dysheme — kontrolli vizual i kalibrimit.

        Nëse kalibrimi është i saktë, vijat e rrjetit shtrihen paralel me
        strukturat reale të dyshemesë (rafte, vija, fuga). Nëse rrjeti "rrëshqet"
        ose lakohet, kalibrimi ose distorsioni i lentes janë problem.
        """
        out = frame.copy()
        h, w = out.shape[:2]
        ticks = np.arange(-extent_m, extent_m + spacing_m, spacing_m)
        # Mostrim i dendur përgjatë çdo vije, që segmentet të priten pastër te horizonti.
        dense = np.linspace(ticks[0], ticks[-1], 200)

        def draw(line_m: np.ndarray) -> None:
            pts, valid = self.to_image_with_validity(line_m)
            inside = valid & (
                (pts[:, 0] > -w) & (pts[:, 0] < 2 * w)
                & (pts[:, 1] > -h) & (pts[:, 1] < 2 * h)
            )
            # Vizato vetëm segmentet e pandërprera të vlefshme.
            start = None
            for i, ok in enumerate(np.append(inside, False)):
                if ok and start is None:
                    start = i
                elif not ok and start is not None:
                    seg = pts[start:i]
                    if len(seg) >= 2:
                        cv2.polylines(out, [seg.astype(np.int32)], False, color, 1, cv2.LINE_AA)
                    start = None

        for t in ticks:
            draw(np.stack([np.full_like(dense, t), dense], axis=1))   # vijat X = t
            draw(np.stack([dense, np.full_like(dense, t)], axis=1))   # vijat Y = t

        # Pikat e kalibrimit + origjina
        for (px, py), (wx, wy) in zip(self.image_points, self.world_points):
            cv2.circle(out, (int(px), int(py)), 7, (0, 0, 255), -1)
            cv2.putText(out, f"({wx:.2f},{wy:.2f})", (int(px) + 10, int(py) - 8),
                        cv2.FONT_HERSHEY_SIMPLEX, 0.55, (0, 0, 255), 2, cv2.LINE_AA)
        return out


# --------------------------------------------------------------------------- #
# CLI
# --------------------------------------------------------------------------- #
def _cmd_extract(args: argparse.Namespace) -> int:
    cap = cv2.VideoCapture(args.video)
    if not cap.isOpened():
        raise RuntimeError(f"Nuk u hap dot videoja: {args.video}")
    cap.set(cv2.CAP_PROP_POS_FRAMES, args.frame)
    ok, frame = cap.read()
    cap.release()
    if not ok:
        raise RuntimeError(f"Nuk u lexua dot frame-i {args.frame}")
    cv2.imwrite(args.out, frame)
    print(f"Frame {args.frame} -> {args.out}  ({frame.shape[1]}x{frame.shape[0]})")
    return 0


def _cmd_pick(args: argparse.Namespace) -> int:
    """Zgjedhje interaktive e pikave me mouse. Kërkon desktop me GUI."""
    image = cv2.imread(args.image)
    if image is None:
        raise RuntimeError(f"Nuk u lexua dot figura: {args.image}")

    picked: List[Tuple[float, float]] = []
    window = "Zgjidh pikat e dyshemesë (klik majtas = shto, u = zhbej, enter = ruaj, esc = dil)"

    def redraw() -> None:
        disp = image.copy()
        for i, (x, y) in enumerate(picked):
            cv2.circle(disp, (int(x), int(y)), 7, (0, 0, 255), -1)
            cv2.putText(disp, str(i), (int(x) + 10, int(y) - 8),
                        cv2.FONT_HERSHEY_SIMPLEX, 0.7, (0, 0, 255), 2)
        cv2.imshow(window, disp)

    def on_mouse(event: int, x: int, y: int, flags: int, param) -> None:
        if event == cv2.EVENT_LBUTTONDOWN:
            picked.append((float(x), float(y)))
            redraw()

    cv2.namedWindow(window, cv2.WINDOW_NORMAL)
    cv2.setMouseCallback(window, on_mouse)
    redraw()
    while True:
        key = cv2.waitKey(20) & 0xFF
        if key == 27:  # esc
            cv2.destroyAllWindows()
            print("U anulua.")
            return 1
        if key in (ord("u"), ord("U")) and picked:
            picked.pop()
            redraw()
        if key in (13, 10):  # enter
            break
    cv2.destroyAllWindows()

    if len(picked) < 4:
        print(f"Vetëm {len(picked)} pika u zgjodhën; duhen së paku 4.")
        return 1

    payload = {
        "unit": "m",
        "notes": "ZËVENDËSO world_points me distancat REALE të matura mbi dysheme.",
        "image_points": [[round(x, 1), round(y, 1)] for x, y in picked],
        "world_points": [[0.0, 0.0] for _ in picked],
        "lens": None,
    }
    Path(args.out).write_text(json.dumps(payload, indent=2, ensure_ascii=False), encoding="utf-8")
    print(f"{len(picked)} pika -> {args.out}")
    print("HAPI TJETËR: hap file-in dhe vendos world_points (metra reale), pastaj:")
    print(f"  python calibration.py validate --calibration {args.out} --image {args.image}")
    return 0


def _cmd_validate(args: argparse.Namespace) -> int:
    calib = GroundPlaneCalibration.from_json(args.calibration)
    err = calib.reprojection_error()

    print("=" * 66)
    print("  VALIDIM I KALIBRIMIT TOKË-PLAN")
    print("=" * 66)
    print(f"  Pika kalibrimi        : {len(calib.image_points)}")
    print(f"  Korrigjim lenteje     : {'po (' + calib.lens.model + ')' if calib.lens else 'jo'}")
    print(f"  Gabim riprojektimi    : mesatar {err['mean_m']:.3f} {calib.unit}, "
          f"maks {err['max_m']:.3f} {calib.unit}")

    if err["max_m"] > 0.25:
        print("  ! Gabimi është i madh. Shkaqet e mundshme: distanca reale të matura")
        print("    gabim, pika jo mbi dysheme, ose distorsion fisheye i pakompensuar.")
    else:
        print("  + Gabimi është brenda kufijve të pranueshëm.")

    image = cv2.imread(args.image) if args.image else None
    if image is not None:
        var = calib.scale_variation(image.shape[1], image.shape[0])
        if var:
            print(f"  Shkalla nëpër kornizë : {var['min_m_per_px']*100:.2f} .. "
                  f"{var['max_m_per_px']*100:.2f} cm/px  (raport {var['ratio']:.1f}x)")
            print(f"    -> 100 px nënkuptojnë {var['min_m_per_px']*100:.2f} m në një skaj")
            print(f"       dhe {var['max_m_per_px']*100:.2f} m në tjetrin. Pikërisht prandaj")
            print("       matjet direkt mbi piksele janë të pavlefshme.")
        if args.out:
            cv2.imwrite(args.out, calib.draw_grid(image, spacing_m=args.spacing))
            print(f"  Rrjeti metrik         -> {args.out}")
            print("    Kontrollo që vijat të përputhen me strukturat reale të dyshemesë.")
    print("=" * 66)
    return 0


def main(argv: Optional[List[str]] = None) -> int:
    p = argparse.ArgumentParser(description="Kalibrim tokë-plan (homografi) për matje metrike.")
    sub = p.add_subparsers(dest="cmd", required=True)

    e = sub.add_parser("extract", help="Nxirr një frame referencë nga videoja")
    e.add_argument("--video", required=True)
    e.add_argument("--frame", type=int, default=0)
    e.add_argument("--out", default="reference_frame.png")
    e.set_defaults(func=_cmd_extract)

    k = sub.add_parser("pick", help="Zgjidh pikat e dyshemesë me mouse (kërkon GUI)")
    k.add_argument("--image", required=True)
    k.add_argument("--out", default="calibration.json")
    k.set_defaults(func=_cmd_pick)

    v = sub.add_parser("validate", help="Validon kalibrimin dhe vizaton rrjetin metrik")
    v.add_argument("--calibration", required=True)
    v.add_argument("--image", default=None)
    v.add_argument("--out", default=None)
    v.add_argument("--spacing", type=float, default=1.0, help="Hapi i rrjetit në metra")
    v.set_defaults(func=_cmd_validate)

    args = p.parse_args(argv)
    logging.basicConfig(level=logging.INFO, format="%(message)s")
    return args.func(args)


if __name__ == "__main__":
    raise SystemExit(main())
