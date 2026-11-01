export const READABLE_ZOOM = 0.7;

export type FitStep =
  | { kind: "full" }
  | { kind: "overview" }
  | { kind: "show"; zoom: number; overview: boolean };

export interface FitInput {
  room: number;
  layoutOverview: boolean;
  measuredFull: boolean;
}

export function fitStep(input: FitInput): FitStep {
  const zoom = Math.min(1, input.room);
  if (input.layoutOverview) {
    return input.measuredFull ? { kind: "show", zoom, overview: true } : { kind: "full" };
  }
  return zoom >= READABLE_ZOOM ? { kind: "show", zoom, overview: false } : { kind: "overview" };
}
