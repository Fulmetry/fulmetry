// SPDX-FileCopyrightText: 2026 PCBoo contributors
// SPDX-License-Identifier: MIT
export const MAX_SIMULATION_REGION_COMPONENTS = 4_096;
export const MAX_SIMULATION_REGION_NETS = 4_096;
// A completed run also publishes input, raw, stdout, stderr, evidence, and the
// models directory entry. 250 models + 6 framework entries fits the 256 cap.
export const MAX_SIMULATION_MODELS = 250;
export const MAX_SIMULATION_MODEL_BINDINGS = 4_096;
export const MAX_SIMULATION_STIMULI = 256;
export const MAX_SIMULATION_ASSERTIONS = 256;
export const MAX_SIMULATION_PWL_POINTS = 4_096;
export const MAX_SIMULATION_RECORD_FIELDS = 256;

export const MAX_SIMULATION_VECTORS = 256;
export const MAX_SIMULATION_SAMPLES_PER_VECTOR = 200_000;
export const MAX_SIMULATION_TOTAL_SAMPLES = 250_000;
