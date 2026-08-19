export type FlowController = {
  start: () => void;
  stop: () => void;
  destroy: () => void;
  /**
   * Optional: place (or remove) a draggable solid obstacle in the flow.
   * xFrac/yFrac are normalized DOM viewport fractions (0..1, y-down,
   * matching clientX/clientY against the canvas's bounding rect) — the
   * controller is responsible for converting into its own grid/coordinate
   * convention. Pass (null, null) to remove the obstacle entirely.
   * Not every backend implements this (it's currently only wired up for
   * the home-page convection background), so callers must optional-chain.
   */
  setObstacle?: (xFrac: number | null, yFrac: number | null) => void;
};
