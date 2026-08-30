// SPDX-FileCopyrightText: 2026 Fulmetry contributors
// SPDX-License-Identifier: MIT
export * from "./definition";
export {
  MAX_SIMULATION_ASSERTIONS,
  MAX_SIMULATION_MODEL_BINDINGS,
  MAX_SIMULATION_MODELS,
  MAX_SIMULATION_PWL_POINTS,
  MAX_SIMULATION_RECORD_FIELDS,
  MAX_SIMULATION_REGION_COMPONENTS,
  MAX_SIMULATION_REGION_NETS,
  MAX_SIMULATION_STIMULI,
} from "./limits";
export {
  SIMULATION_RESULT_SCHEMA_VERSION,
  MAX_SIMULATION_VECTORS,
  MAX_SIMULATION_SAMPLES_PER_VECTOR,
  MAX_SIMULATION_TOTAL_SAMPLES,
  simulationDefinitionDigest,
  parseSimulationResultEvidence,
  assessSimulationResult,
} from "./result";
export type {
  SimulationSample,
  SimulationVector,
  SimulationResultEvidence,
  SimulationEvidenceBinding,
  SimulationAssessment,
} from "./result";
export * from "./assets";
export * from "./loader";
export * from "./ngspice";
