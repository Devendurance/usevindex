export const PREVIEW_PARAM = "preview";

export const normalizeRouteParam = (value: string | undefined | null) => {
  const normalized = value?.trim();
  return normalized || null;
};

export const isPreviewParam = (value: string | undefined | null) =>
  normalizeRouteParam(value) === PREVIEW_PARAM;
