// Small vector and fitting helpers for the geometry analysis. Ported from the
// CAD-Viewer-Projekt (src/geom.js): Jacobi eigen-decomposition, Kasa circle fit and
// algebraic sphere fit. Point sets are flat xyz arrays to avoid per-point allocation.

import type { Vec3 } from "../types.ts";

export const sub = (a: Vec3, b: Vec3): Vec3 => [a[0] - b[0], a[1] - b[1], a[2] - b[2]];
export const add = (a: Vec3, b: Vec3): Vec3 => [a[0] + b[0], a[1] + b[1], a[2] + b[2]];
export const scale = (a: Vec3, s: number): Vec3 => [a[0] * s, a[1] * s, a[2] * s];
export const dot = (a: Vec3, b: Vec3) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
export const cross = (a: Vec3, b: Vec3): Vec3 => [
  a[1] * b[2] - a[2] * b[1],
  a[2] * b[0] - a[0] * b[2],
  a[0] * b[1] - a[1] * b[0],
];
export const length = (a: Vec3) => Math.hypot(a[0], a[1], a[2]);
export const distance = (a: Vec3, b: Vec3) => Math.hypot(a[0] - b[0], a[1] - b[1], a[2] - b[2]);
export const normalize = (a: Vec3): Vec3 => {
  const l = length(a) || 1;
  return [a[0] / l, a[1] / l, a[2] / l];
};
export const lerp = (a: Vec3, b: Vec3, t: number): Vec3 => [
  a[0] + (b[0] - a[0]) * t,
  a[1] + (b[1] - a[1]) * t,
  a[2] + (b[2] - a[2]) * t,
];
export const deg = (rad: number) => (rad * 180) / Math.PI;

/** Flat xyz point set. */
export type Points = ArrayLike<number>;

export const pointAt = (p: Points, i: number): Vec3 => [p[3 * i], p[3 * i + 1], p[3 * i + 2]];

export type Mat3 = [Vec3, Vec3, Vec3];

/** Eigen-decomposition of a symmetric 3×3 matrix (Jacobi), sorted by ascending value. */
export const eig3 = (m: Mat3): { value: number; vector: Vec3 }[] => {
  const a = [m[0].slice(), m[1].slice(), m[2].slice()];
  const v = [
    [1, 0, 0],
    [0, 1, 0],
    [0, 0, 1],
  ];
  const pairs: [number, number][] = [
    [0, 1],
    [0, 2],
    [1, 2],
  ];
  const norm = Math.abs(a[0][0]) + Math.abs(a[1][1]) + Math.abs(a[2][2]) || 1;
  for (let sweep = 0; sweep < 50; sweep++) {
    const off = Math.abs(a[0][1]) + Math.abs(a[0][2]) + Math.abs(a[1][2]);
    if (off < 1e-15 * norm) break;
    for (const [p, q] of pairs) {
      if (Math.abs(a[p][q]) < 1e-18 * norm) continue;
      const th = (a[q][q] - a[p][p]) / (2 * a[p][q]);
      const t = Math.sign(th || 1) / (Math.abs(th) + Math.sqrt(th * th + 1));
      const c = 1 / Math.sqrt(t * t + 1);
      const s = t * c;
      for (let k = 0; k < 3; k++) {
        const akp = a[k][p];
        const akq = a[k][q];
        a[k][p] = c * akp - s * akq;
        a[k][q] = s * akp + c * akq;
      }
      for (let k = 0; k < 3; k++) {
        const apk = a[p][k];
        const aqk = a[q][k];
        a[p][k] = c * apk - s * aqk;
        a[q][k] = s * apk + c * aqk;
      }
      for (let k = 0; k < 3; k++) {
        const vkp = v[k][p];
        const vkq = v[k][q];
        v[k][p] = c * vkp - s * vkq;
        v[k][q] = s * vkp + c * vkq;
      }
    }
  }
  return [0, 1, 2]
    .map((i) => ({ value: a[i][i], vector: [v[0][i], v[1][i], v[2][i]] as Vec3 }))
    .sort((x, y) => x.value - y.value);
};

export const centroid = (p: Points, n = p.length / 3): Vec3 => {
  let x = 0;
  let y = 0;
  let z = 0;
  for (let i = 0; i < n; i++) {
    x += p[3 * i];
    y += p[3 * i + 1];
    z += p[3 * i + 2];
  }
  return n ? [x / n, y / n, z / n] : [0, 0, 0];
};

/** Scatter matrix Σ (p−c)(p−c)ᵀ; `center` defaults to the origin. */
export const scatter = (p: Points, center: Vec3 = [0, 0, 0], n = p.length / 3): Mat3 => {
  let xx = 0, xy = 0, xz = 0, yy = 0, yz = 0, zz = 0;
  for (let i = 0; i < n; i++) {
    const x = p[3 * i] - center[0];
    const y = p[3 * i + 1] - center[1];
    const z = p[3 * i + 2] - center[2];
    xx += x * x;
    xy += x * y;
    xz += x * z;
    yy += y * y;
    yz += y * z;
    zz += z * z;
  }
  return [
    [xx, xy, xz],
    [xy, yy, yz],
    [xz, yz, zz],
  ];
};

/** Solves A·x = b (n×n, Gauss with partial pivoting); null when singular. */
export const solve = (A: number[][], b: number[]): number[] | null => {
  const n = b.length;
  const M = A.map((r, i) => [...r, b[i]]);
  for (let c = 0; c < n; c++) {
    let piv = c;
    for (let r = c + 1; r < n; r++) if (Math.abs(M[r][c]) > Math.abs(M[piv][c])) piv = r;
    [M[c], M[piv]] = [M[piv], M[c]];
    if (Math.abs(M[c][c]) < 1e-30) return null;
    for (let r = 0; r < n; r++) {
      if (r === c) continue;
      const f = M[r][c] / M[c][c];
      for (let k = c; k <= n; k++) M[r][k] -= f * M[c][k];
    }
  }
  return M.map((r, i) => r[n] / r[i]);
};

/** Orthonormal pair perpendicular to the unit vector `a`. */
export const basis = (a: Vec3): [Vec3, Vec3] => {
  const t: Vec3 = Math.abs(a[0]) < 0.9 ? [1, 0, 0] : [0, 1, 0];
  const u = normalize(cross(a, t));
  return [u, cross(a, u)];
};

export interface CircleFit {
  center: Vec3;
  radius: number;
  /** Largest radial deviation of a point from the circle. */
  residual: number;
  /** In-plane basis used for angles around `center`. */
  u: Vec3;
  w: Vec3;
}

/**
 * Kasa least-squares circle through the points projected into the plane with unit
 * normal `axis`. `center` lies in the plane through the centroid.
 */
export const fitCircle = (p: Points, axis: Vec3, n = p.length / 3): CircleFit | null => {
  if (n < 3) return null;
  const [u, w] = basis(axis);
  const c0 = centroid(p, n);
  const xs = new Float64Array(n);
  const ys = new Float64Array(n);
  const A = [
    [0, 0, 0],
    [0, 0, 0],
    [0, 0, 0],
  ];
  const b = [0, 0, 0];
  for (let i = 0; i < n; i++) {
    const d: Vec3 = [p[3 * i] - c0[0], p[3 * i + 1] - c0[1], p[3 * i + 2] - c0[2]];
    const x = dot(d, u);
    const y = dot(d, w);
    xs[i] = x;
    ys[i] = y;
    const r = [x, y, 1];
    const rhs = -(x * x + y * y);
    for (let k = 0; k < 3; k++) {
      b[k] += r[k] * rhs;
      for (let j = 0; j < 3; j++) A[k][j] += r[k] * r[j];
    }
  }
  const s = solve(A, b);
  if (!s) return null;
  const cx = -s[0] / 2;
  const cy = -s[1] / 2;
  const radius = Math.sqrt(Math.max(0, cx * cx + cy * cy - s[2]));
  let residual = 0;
  for (let i = 0; i < n; i++) {
    residual = Math.max(residual, Math.abs(Math.hypot(xs[i] - cx, ys[i] - cy) - radius));
  }
  return { center: add(c0, add(scale(u, cx), scale(w, cy))), radius, residual, u, w };
};

export interface SphereFit {
  center: Vec3;
  radius: number;
  residual: number;
}

/** Algebraic least-squares sphere. */
export const fitSphere = (p: Points, n = p.length / 3): SphereFit | null => {
  if (n < 4) return null;
  const c0 = centroid(p, n);
  const A = Array.from({ length: 4 }, () => [0, 0, 0, 0]);
  const b = [0, 0, 0, 0];
  for (let i = 0; i < n; i++) {
    const d: Vec3 = [p[3 * i] - c0[0], p[3 * i + 1] - c0[1], p[3 * i + 2] - c0[2]];
    const r = [d[0], d[1], d[2], 1];
    const rhs = -dot(d, d);
    for (let k = 0; k < 4; k++) {
      b[k] += r[k] * rhs;
      for (let j = 0; j < 4; j++) A[k][j] += r[k] * r[j];
    }
  }
  const s = solve(A, b);
  if (!s) return null;
  const cc: Vec3 = [-s[0] / 2, -s[1] / 2, -s[2] / 2];
  const radius = Math.sqrt(Math.max(0, dot(cc, cc) - s[3]));
  let residual = 0;
  for (let i = 0; i < n; i++) {
    const d: Vec3 = [p[3 * i] - c0[0] - cc[0], p[3 * i + 1] - c0[1] - cc[1], p[3 * i + 2] - c0[2] - cc[2]];
    residual = Math.max(residual, Math.abs(length(d) - radius));
  }
  return { center: add(c0, cc), radius, residual };
};

// ---------- 4×4 column-major transforms (SwMesh.matrix) ----------

export type Mat4 = ArrayLike<number>;

export const transformPoint = (m: Mat4 | undefined, p: Vec3): Vec3 =>
  m
    ? [
        m[0] * p[0] + m[4] * p[1] + m[8] * p[2] + m[12],
        m[1] * p[0] + m[5] * p[1] + m[9] * p[2] + m[13],
        m[2] * p[0] + m[6] * p[1] + m[10] * p[2] + m[14],
      ]
    : p;

/** Direction through the 3×3 part, renormalised (rigid or uniformly scaled matrices). */
export const transformDir = (m: Mat4 | undefined, d: Vec3): Vec3 =>
  m
    ? normalize([
        m[0] * d[0] + m[4] * d[1] + m[8] * d[2],
        m[1] * d[0] + m[5] * d[1] + m[9] * d[2],
        m[2] * d[0] + m[6] * d[1] + m[10] * d[2],
      ])
    : d;

export const det3 = (m: Mat4) =>
  m[0] * (m[5] * m[10] - m[9] * m[6]) -
  m[4] * (m[1] * m[10] - m[9] * m[2]) +
  m[8] * (m[1] * m[6] - m[5] * m[2]);

/** Uniform scale factor of the matrix (cube root of |det|); 1 without a matrix. */
export const scaleOf = (m: Mat4 | undefined) => (m ? Math.cbrt(Math.abs(det3(m))) || 1 : 1);

/** Inverse of an affine column-major 4×4 matrix; null when singular. */
export const invertAffine = (m: Mat4): number[] | null => {
  const d = det3(m);
  if (!d) return null;
  const i = 1 / d;
  const r = [
    (m[5] * m[10] - m[6] * m[9]) * i,
    (m[2] * m[9] - m[1] * m[10]) * i,
    (m[1] * m[6] - m[2] * m[5]) * i,
    0,
    (m[6] * m[8] - m[4] * m[10]) * i,
    (m[0] * m[10] - m[2] * m[8]) * i,
    (m[2] * m[4] - m[0] * m[6]) * i,
    0,
    (m[4] * m[9] - m[5] * m[8]) * i,
    (m[1] * m[8] - m[0] * m[9]) * i,
    (m[0] * m[5] - m[1] * m[4]) * i,
    0,
    0,
    0,
    0,
    1,
  ];
  const t: Vec3 = [m[12], m[13], m[14]];
  r[12] = -(r[0] * t[0] + r[4] * t[1] + r[8] * t[2]);
  r[13] = -(r[1] * t[0] + r[5] * t[1] + r[9] * t[2]);
  r[14] = -(r[2] * t[0] + r[6] * t[1] + r[10] * t[2]);
  return r;
};
