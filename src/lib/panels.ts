import type { PanelId } from "./types";
import { PANEL_IDS } from "./types";

export function isPanelId(value: string): value is PanelId {
  return (PANEL_IDS as readonly string[]).includes(value);
}

export function panelIndex(id: PanelId): number {
  return PANEL_IDS.indexOf(id);
}

export function clampPanelIndex(index: number): number {
  return Math.max(0, Math.min(PANEL_IDS.length - 1, index));
}
