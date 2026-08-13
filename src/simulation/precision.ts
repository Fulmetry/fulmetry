// SPDX-FileCopyrightText: 2026 PCBoo contributors
// SPDX-License-Identifier: MIT
const FLOAT64_BYTES = 8;
const ulpBuffer = new ArrayBuffer(FLOAT64_BYTES);
const ulpView = new DataView(ulpBuffer);
const PRISTINE_SET_FLOAT64 = Function.prototype.call.bind(DataView.prototype.setFloat64) as (
  view: DataView,
  byteOffset: number,
  value: number,
  littleEndian?: boolean,
) => void;
const PRISTINE_GET_FLOAT64 = Function.prototype.call.bind(DataView.prototype.getFloat64) as (
  view: DataView,
  byteOffset: number,
  littleEndian?: boolean,
) => number;
const PRISTINE_SET_BIG_UINT64 = Function.prototype.call.bind(DataView.prototype.setBigUint64) as (
  view: DataView,
  byteOffset: number,
  value: bigint,
  littleEndian?: boolean,
) => void;
const PRISTINE_GET_BIG_UINT64 = Function.prototype.call.bind(DataView.prototype.getBigUint64) as (
  view: DataView,
  byteOffset: number,
  littleEndian?: boolean,
) => bigint;

/** Distance from a finite value to the next greater representable binary64 value. */
export function binary64Ulp(value: number): number {
  if (!Number.isFinite(value)) throw new TypeError("binary64 ULP requires a finite value");
  const magnitude = Math.abs(value);
  if (magnitude === 0) return Number.MIN_VALUE;

  PRISTINE_SET_FLOAT64(ulpView, 0, magnitude, false);
  const bits = PRISTINE_GET_BIG_UINT64(ulpView, 0, false);
  if (magnitude === Number.MAX_VALUE) {
    PRISTINE_SET_BIG_UINT64(ulpView, 0, bits - 1n, false);
    return magnitude - PRISTINE_GET_FLOAT64(ulpView, 0, false);
  }
  PRISTINE_SET_BIG_UINT64(ulpView, 0, bits + 1n, false);
  return PRISTINE_GET_FLOAT64(ulpView, 0, false) - magnitude;
}
