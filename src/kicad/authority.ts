// SPDX-FileCopyrightText: 2026 PCBoo contributors
// SPDX-License-Identifier: MIT
import type { KicadHandoff, KicadLiveValidation } from "./index";

const AUTHENTIC_HANDOFFS = new WeakSet<object>();
const AUTHENTIC_LIVE_VALIDATIONS = new WeakSet<object>();
const PRISTINE_WEAKSET_ADD = Function.prototype.call.bind(WeakSet.prototype.add) as (set: WeakSet<object>, value: object) => void;
const PRISTINE_WEAKSET_HAS = Function.prototype.call.bind(WeakSet.prototype.has) as (set: WeakSet<object>, value: object) => boolean;

/** @internal Package-private authenticity boundary. */
export function markAuthenticKicadHandoff<T extends Readonly<KicadHandoff>>(handoff: T): T {
  PRISTINE_WEAKSET_ADD(AUTHENTIC_HANDOFFS, handoff);
  return handoff;
}

/** @internal Package-private authenticity boundary. */
export function assertAuthenticKicadHandoff(handoff: Readonly<KicadHandoff>): void {
  if (!PRISTINE_WEAKSET_HAS(AUTHENTIC_HANDOFFS, handoff)) {
    throw new TypeError("KiCad handoff envelope was not created by this PCBoo runtime");
  }
}

/** @internal Package-private authenticity boundary. */
export function markAuthenticKicadLiveValidation<T extends Readonly<KicadLiveValidation>>(validation: T): T {
  PRISTINE_WEAKSET_ADD(AUTHENTIC_LIVE_VALIDATIONS, validation);
  return validation;
}

/** @internal Package-private authenticity boundary. */
export function assertAuthenticKicadLiveValidation(validation: Readonly<KicadLiveValidation>): void {
  if (!PRISTINE_WEAKSET_HAS(AUTHENTIC_LIVE_VALIDATIONS, validation)) {
    throw new TypeError("KiCad live-validation envelope was not produced by PCBoo's live validator");
  }
}
